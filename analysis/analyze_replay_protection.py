#!/usr/bin/env python3
"""Recompute replay-protection metrics from a run's raw CSV observations."""

import argparse
import json
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd


REQUEST_COLUMNS = {
    "experiment_id", "scenario_id", "repetition", "method", "replica_count", "phase",
    "jti_hash", "replica_id", "concurrency_level", "request_start_timestamp",
    "request_end_timestamp", "latency_ms", "http_status", "actual_outcome",
    "replay_detected", "legitimate_request", "store_latency_ms", "replay_context",
}
SCENARIO_COLUMNS = {
    "experiment_id", "scenario_id", "method", "replica_count", "repetition", "status",
}
SUMMARY_COLUMNS = {
    "experiment_id", "scenario_id", "method", "replica_count", "repetition",
    "replay_detection_rate", "latency_mean_ms", "throughput_rps",
}
GROUP_COLUMNS = ["scenario_id", "method", "replica_count", "repetition"]


def parse_bool(series):
    """Parse CSV boolean fields consistently; empty/missing values remain false."""
    return series.astype(str).str.lower().eq("true")


def validate_columns(frame, required, name):
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"{name} is missing required columns: {', '.join(missing)}")


def percentile(series, probability):
    """Use linear interpolation between adjacent sorted request observations."""
    values = pd.to_numeric(series, errors="coerce").dropna()
    return values.quantile(probability, interpolation="linear") if len(values) else float("nan")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("experiment_dir", type=Path, help="Directory containing metadata.json and CSV outputs")
    args = parser.parse_args()
    experiment_dir = args.experiment_dir.resolve()
    output_dir = experiment_dir / "analysis"
    output_dir.mkdir(parents=True, exist_ok=True)

    metadata = json.loads((experiment_dir / "metadata.json").read_text(encoding="utf-8"))
    requests = pd.read_csv(experiment_dir / "requests.csv")
    scenarios = pd.read_csv(experiment_dir / "scenarios.csv")
    recorded_summary = pd.read_csv(experiment_dir / "summary.csv")
    validate_columns(requests, REQUEST_COLUMNS, "requests.csv")
    validate_columns(scenarios, SCENARIO_COLUMNS, "scenarios.csv")
    validate_columns(recorded_summary, SUMMARY_COLUMNS, "summary.csv")

    print(f"Experiment: {metadata['experiment_id']}")
    print(f"requests.csv: {requests.shape}; scenarios.csv: {scenarios.shape}; summary.csv: {recorded_summary.shape}")
    print("\nMissing values by file:")
    print(pd.DataFrame({
        "requests": requests.isna().sum(),
        "scenarios": scenarios.isna().sum(),
        "summary": recorded_summary.isna().sum(),
    }).fillna(0).astype(int).to_string())

    for column in ["latency_ms", "store_latency_ms", "concurrency_level"]:
        requests[column] = pd.to_numeric(requests[column], errors="coerce")
    requests["replay_detected"] = parse_bool(requests["replay_detected"])
    requests["legitimate_request"] = parse_bool(requests["legitimate_request"])
    requests["request_start_timestamp"] = pd.to_datetime(
        requests["request_start_timestamp"], utc=True, errors="coerce"
    )
    requests["request_end_timestamp"] = pd.to_datetime(
        requests["request_end_timestamp"], utc=True, errors="coerce"
    )

    raw_metrics = []
    throughput_rows = []
    for key, group in requests.groupby(GROUP_COLUMNS, dropna=False):
        replay = group[group["phase"] == "replay"]
        replay_attempt_count = len(replay)
        replay_blocked = int(replay["replay_detected"].sum())
        concurrent = group[group["phase"] == "concurrent_replay"]
        # Concurrent duplicate attempts exclude one expected first-use request per jti.
        concurrent_duplicate_count = int(
            concurrent.groupby("jti_hash", dropna=False).size().sub(1).clip(lower=0).sum()
        )
        accepted_concurrent_per_jti = concurrent[
            concurrent["actual_outcome"] == "accepted"
        ].groupby("jti_hash", dropna=False).size()
        concurrent_over_acceptances = int(
            (accepted_concurrent_per_jti - 1).clip(lower=0).sum()
        )
        concurrent_blocked = int(
            concurrent.loc[~concurrent["legitimate_request"], "replay_detected"].sum()
        )
        replay_denominator = replay_attempt_count + concurrent_duplicate_count
        replay_detection_rate = (
            (replay_blocked + concurrent_blocked) / replay_denominator
            if replay_denominator else float("nan")
        )
        legitimate = group[group["legitimate_request"]]
        legitimate_accepted = int((legitimate["actual_outcome"] == "accepted").sum())
        legitimate_acceptance_rate = (
            legitimate_accepted / len(legitimate) if len(legitimate) else float("nan")
        )
        performance = group[group["phase"] == "performance"]
        latency = performance["latency_ms"].dropna()
        cross_replica = replay[replay["replay_context"] == "cross_replica"]
        cross_replica_rate = (
            float(cross_replica["replay_detected"].mean()) if len(cross_replica) else float("nan")
        )
        replay_acceptance_count = int((replay["actual_outcome"] == "accepted").sum()) + concurrent_over_acceptances
        raw_metrics.append({
            **dict(zip(GROUP_COLUMNS, key)),
            "replay_detection_rate": replay_detection_rate,
            "legitimate_request_acceptance_rate": legitimate_acceptance_rate,
            "false_rejection_rate": 1 - legitimate_acceptance_rate if len(legitimate) else float("nan"),
            "false_acceptance_rate": (
                replay_acceptance_count / replay_denominator
                if replay_denominator else float("nan")
            ),
            "replay_acceptance_count": replay_acceptance_count,
            "replay_rejection_count": replay_blocked + concurrent_blocked,
            "latency_mean_ms": latency.mean() if len(latency) else float("nan"),
            "latency_median_ms": latency.median() if len(latency) else float("nan"),
            "latency_std_ms": latency.std(ddof=1) if len(latency) > 1 else (0 if len(latency) else float("nan")),
            "latency_p95_ms": percentile(latency, 0.95),
            "latency_p99_ms": percentile(latency, 0.99),
            "store_latency_mean_ms": pd.to_numeric(
                performance["store_latency_ms"], errors="coerce"
            ).mean(),
            "cross_replica_replay_detection_rate": cross_replica_rate,
        })

        for concurrency, window in performance.groupby("concurrency_level", dropna=False):
            valid_window = window.dropna(subset=["request_start_timestamp", "request_end_timestamp"])
            if valid_window.empty:
                duration = float("nan")
                throughput = float("nan")
            else:
                duration = (
                    valid_window["request_end_timestamp"].max() -
                    valid_window["request_start_timestamp"].min()
                ).total_seconds()
                throughput = len(valid_window) / duration if duration > 0 else float("nan")
            throughput_rows.append({
                **dict(zip(GROUP_COLUMNS, key)),
                "concurrency_level": concurrency,
                "completed_requests": len(valid_window),
                "measurement_duration_seconds": duration,
                "throughput_rps": throughput,
            })

    derived = pd.DataFrame(raw_metrics)
    throughput = pd.DataFrame(throughput_rows)
    derived.to_csv(output_dir / "derived_metrics.csv", index=False)
    throughput.to_csv(output_dir / "throughput_by_concurrency.csv", index=False)
    requests.isna().sum().rename("missing_values").to_csv(output_dir / "missing_values.csv")

    if not derived.empty:
        method_comparison = derived.groupby(["method", "replica_count"], as_index=False).agg(
            replay_detection_rate=("replay_detection_rate", "mean"),
            legitimate_request_acceptance_rate=("legitimate_request_acceptance_rate", "mean"),
            latency_mean_ms=("latency_mean_ms", "mean"),
            latency_p95_ms=("latency_p95_ms", "mean"),
        )
        method_comparison.to_csv(output_dir / "method_comparison.csv", index=False)
        method_comparison.plot(
            x="method",
            y=["replay_detection_rate", "legitimate_request_acceptance_rate"],
            kind="bar",
            ylim=(0, 1),
            title="Replay detection and legitimate acceptance",
            ylabel="Rate",
            rot=20,
        )
        plt.tight_layout()
        plt.savefig(output_dir / "security_rates.png", dpi=150)
        plt.close()

        latency_rows = requests[
            (requests["phase"] == "performance") & requests["latency_ms"].notna()
        ]
        if not latency_rows.empty:
            latency_rows.boxplot(column="latency_ms", by=["method", "replica_count"])
            plt.suptitle("")
            plt.title("Runner-observed end-to-end latency")
            plt.ylabel("Latency (ms)")
            plt.tight_layout()
            plt.savefig(output_dir / "latency_by_method.png", dpi=150)
            plt.close()

    if not throughput.empty:
        throughput_plot = throughput.dropna(subset=["throughput_rps"])
        if not throughput_plot.empty:
            for (method, replica_count), group in throughput_plot.groupby(["method", "replica_count"]):
                group.groupby("concurrency_level")["throughput_rps"].mean().sort_index().plot(
                    marker="o", label=f"{method}, {replica_count} replica(s)"
                )
            plt.title("Throughput by concurrency")
            plt.xlabel("Concurrency level")
            plt.ylabel("Requests per second")
            plt.legend()
            plt.tight_layout()
            plt.savefig(output_dir / "throughput_by_concurrency.png", dpi=150)
            plt.close()

    print(f"\nDerived tables and figures saved under: {output_dir}")


if __name__ == "__main__":
    main()
