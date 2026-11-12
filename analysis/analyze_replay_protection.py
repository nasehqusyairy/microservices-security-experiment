#!/usr/bin/env python3
"""Validate a replay-protection run and recompute metrics from request observations."""

import argparse
import json
import math
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd


METHODS = ("in-memory", "redis", "redis-ttl", "mariadb")
REPLICA_COUNTS = (1, 2, 3)
GROUP_COLUMNS = ["scenario_id", "method", "replica_count", "repetition"]
RATE_COLUMNS = (
    "replay_detection_rate",
    "legitimate_request_acceptance_rate",
    "false_rejection_rate",
    "false_acceptance_rate",
    "cross_replica_replay_detection_rate",
)
COMPARE_COLUMNS = (
    *RATE_COLUMNS,
    "latency_mean_ms",
    "latency_median_ms",
    "latency_p95_ms",
    "latency_p99_ms",
    "throughput_rps",
    "store_latency_mean_ms",
    "store_latency_p95_ms",
    "store_error_count",
    "request_error_count",
    "service_error_count",
    "protected_operation_execution_count",
    "restart_state_retained",
)


def parse_bool(value):
    """Keep unknown/missing booleans distinct from a measured false."""
    if pd.isna(value) or value == "":
        return pd.NA
    if str(value).strip().lower() == "true":
        return True
    if str(value).strip().lower() == "false":
        return False
    return pd.NA


def rate(numerator, denominator):
    return numerator / denominator if denominator else float("nan")


def compare_value(actual, recorded):
    if pd.isna(actual) and pd.isna(recorded):
        return True
    if pd.isna(actual) or pd.isna(recorded):
        return False
    # Runner timestamps retain nanoseconds, while JavaScript date conversion has
    # sub-microsecond floating-point precision at epoch scale.
    return math.isclose(float(actual), float(recorded), rel_tol=1e-5, abs_tol=1e-6)


def expected_scenarios(repetitions):
    return [
        {
            "scenario_id": f"S{replica_index * len(METHODS) + method_index + 1}",
            "method": method,
            "replica_count": replicas,
            "repetition": repetition,
        }
        for replica_index, replicas in enumerate(REPLICA_COUNTS)
        for method_index, method in enumerate(METHODS)
        for repetition in range(1, repetitions + 1)
    ]


def compute_metrics(group, method, replica_count):
    replay_rows = group[group["phase"] == "replay"]
    concurrent = group[group["phase"] == "concurrent_replay"]
    concurrent_groups = concurrent.groupby("concurrent_batch_id", dropna=False)
    concurrent_duplicate_count = sum(max(0, len(batch) - 1) for _, batch in concurrent_groups)
    accepted_concurrent = concurrent[concurrent["actual_outcome"] == "accepted"]
    concurrent_over_acceptances = sum(
        max(0, len(batch) - 1)
        for _, batch in accepted_concurrent.groupby("concurrent_batch_id", dropna=False)
    )
    replay_denominator = len(replay_rows) + concurrent_duplicate_count
    replay_detected = int((replay_rows["actual_outcome"] == "replay_detected").sum())
    replay_detected += int((concurrent["actual_outcome"] == "replay_detected").sum())
    replay_accepted = int((replay_rows["actual_outcome"] == "accepted").sum()) + concurrent_over_acceptances

    legitimate = group[
        group["legitimate_request"].eq(True)
        & group["phase"].isin(("first_use", "performance"))
    ]
    legitimate_accepted = int((legitimate["actual_outcome"] == "accepted").sum())
    cross = replay_rows[replay_rows["replay_context"] == "cross_replica"]
    first_use = group[group["phase"] == "first_use"].set_index("jti_hash", drop=False)
    cross_valid = []
    for _, request in cross.iterrows():
        original = first_use.loc[request["jti_hash"]] if request["jti_hash"] in first_use.index else None
        if isinstance(original, pd.DataFrame):
            original = original.iloc[0]
        cross_valid.append(
            original is not None
            and pd.notna(request["replica_id"])
            and pd.notna(original["replica_id"])
            and request["replica_id"] != original["replica_id"]
            and pd.notna(request["routing_correct"])
            and bool(request["routing_correct"])
        )

    performance = group[group["phase"] == "performance"]
    latency = pd.to_numeric(performance["latency_ms"], errors="coerce").dropna()
    store_latency = pd.to_numeric(performance["store_latency_ms"], errors="coerce").dropna()
    starts = pd.to_datetime(performance["request_start_timestamp"], utc=True, errors="coerce")
    ends = pd.to_datetime(performance["request_end_timestamp"], utc=True, errors="coerce")
    timestamps = pd.concat([starts, ends]).dropna()
    duration = (
        (timestamps.max() - timestamps.min()).total_seconds()
        if len(timestamps) > 1
        else float("nan")
    )
    restart_rows = group[group["replay_context"].isin(("before_restart", "after_restart"))]
    restart_after = restart_rows[restart_rows["replay_context"] == "after_restart"]
    restart_state_retained = (
        bool((restart_after["actual_outcome"] == "replay_detected").all())
        if len(restart_after) == 1
        else pd.NA
    )

    return {
        "replay_detection_rate": rate(replay_detected, replay_denominator),
        "legitimate_request_acceptance_rate": rate(legitimate_accepted, len(legitimate)),
        "false_rejection_rate": rate(
            int((legitimate["actual_outcome"] != "accepted").sum()), len(legitimate)
        ),
        "false_acceptance_rate": rate(replay_accepted, replay_denominator),
        "replay_acceptance_count": replay_accepted,
        "replay_rejection_count": replay_detected,
        "latency_mean_ms": latency.mean() if len(latency) else float("nan"),
        "latency_median_ms": latency.median() if len(latency) else float("nan"),
        "latency_std_ms": latency.std(ddof=1) if len(latency) > 1 else (0 if len(latency) else float("nan")),
        "latency_p95_ms": latency.quantile(0.95) if len(latency) else float("nan"),
        "latency_p99_ms": latency.quantile(0.99) if len(latency) else float("nan"),
        "throughput_rps": len(performance) / duration if duration > 0 else float("nan"),
        "store_latency_mean_ms": store_latency.mean() if len(store_latency) else float("nan"),
        "store_latency_p95_ms": store_latency.quantile(0.95) if len(store_latency) else float("nan"),
        "cross_replica_replay_detection_rate": (
            rate(int((cross["actual_outcome"] == "replay_detected").sum()), len(cross))
            if replica_count > 1 and len(cross)
            else float("nan")
        ),
        "cross_replica_valid": (
            bool(cross_valid) and all(cross_valid) if replica_count > 1 else pd.NA
        ),
        "restart_state_retained": restart_state_retained,
        "protected_operation_execution_count": int(
            group["protected_operation_executed"].eq(True).sum()
        ),
        "store_error_count": int((group["error_category"] == "store_error").sum()),
        "request_error_count": int((group["error_category"] == "request_error").sum()),
        "service_error_count": int((group["error_category"] == "service_error").sum()),
        "request_observation_count": len(group),
        "request_id_unique": bool(group["request_id"].notna().all() and group["request_id"].is_unique),
        "protected_operation_consistent": bool(
            group.loc[group["actual_outcome"] == "accepted", "protected_operation_executed"].eq(True).all()
            and group.loc[group["actual_outcome"].isin(("replay_detected", "store_error")),
                          "protected_operation_executed"].eq(False).all()
            and not group.loc[group["actual_outcome"] != "accepted",
                              "protected_operation_executed"].eq(True).any()
        ),
        "http_outcome_consistent": bool(
            group.loc[group["actual_outcome"] == "accepted", "status"].eq(200).all()
            and group.loc[group["actual_outcome"] == "replay_detected", "status"].eq(403).all()
            and group.loc[group["actual_outcome"] == "store_error", "status"].eq(503).all()
            and group.loc[group["actual_outcome"] == "store_error", "error_category"].eq("store_error").all()
            and group.loc[group["actual_outcome"] == "request_error", "error_category"].eq("request_error").all()
            and group.loc[group["actual_outcome"] == "service_error", "error_category"].eq("service_error").all()
            and not group.loc[group["actual_outcome"].isin(
                ("request_error", "service_error", "store_error")
            ), "replay_detected"].eq(True).any()
        ),
    }


def validate_run(metadata, requests, scenarios, summary):
    failures = []
    repetitions = int(metadata.get("configuration", {}).get("repetitions", 0))
    expected = expected_scenarios(repetitions)
    expected_keys = {
        (row["scenario_id"], row["method"], row["replica_count"], row["repetition"])
        for row in expected
    }
    recorded_keys = {
        (row.scenario_id, row.method, int(row.replica_count), int(row.repetition))
        for row in scenarios.itertuples()
    }
    if recorded_keys != expected_keys:
        failures.append("scenario matrix is incomplete or contains unexpected scenarios")

    derived_rows = []
    validation_rows = []
    for planned in expected:
        scenario_rows = scenarios[
            (scenarios["scenario_id"] == planned["scenario_id"])
            & (scenarios["method"] == planned["method"])
            & (pd.to_numeric(scenarios["replica_count"], errors="coerce") == planned["replica_count"])
            & (pd.to_numeric(scenarios["repetition"], errors="coerce") == planned["repetition"])
        ]
        request_group = requests[
            (requests["scenario_id"] == planned["scenario_id"])
            & (requests["method"] == planned["method"])
            & (pd.to_numeric(requests["replica_count"], errors="coerce") == planned["replica_count"])
            & (pd.to_numeric(requests["repetition"], errors="coerce") == planned["repetition"])
        ]
        reasons = []
        if len(scenario_rows) != 1:
            reasons.append("scenario result row missing or duplicated")
            scenario_record = None
        else:
            scenario_record = scenario_rows.iloc[0]
            if scenario_record["status"] != "completed":
                reasons.append(f"scenario status is {scenario_record['status']}")
            if int(scenario_record["completed_requests"]) != int(scenario_record["planned_requests"]):
                reasons.append("scenario request count is incomplete")
            if len(request_group) != int(scenario_record["planned_requests"]):
                reasons.append("requests.csv row count differs from planned requests")

        required_phases = {"first_use", "replay", "concurrent_replay", "performance"}
        missing_phases = required_phases - set(request_group["phase"].dropna())
        if missing_phases:
            reasons.append(f"missing request phases: {', '.join(sorted(missing_phases))}")

        before = request_group[request_group["replay_context"] == "before_restart"]
        after = request_group[request_group["replay_context"] == "after_restart"]
        if len(before) != 1 or len(after) != 1:
            reasons.append("restart behavior observations are missing or duplicated")
        elif before.iloc[0]["actual_outcome"] != "replay_detected" or (
            before.iloc[0]["jti_hash"] != after.iloc[0]["jti_hash"]
        ):
            reasons.append("restart replay did not use the already-consumed jti")
        elif planned["method"] == "in-memory":
            if after.iloc[0]["actual_outcome"] != "accepted":
                reasons.append("in-memory state was not observed as cleared after restart")
        elif after.iloc[0]["actual_outcome"] != "replay_detected":
            reasons.append("shared replay state was not observed as retained after restart")

        if planned["replica_count"] > 1:
            cross = request_group[
                (request_group["phase"] == "replay")
                & (request_group["replay_context"] == "cross_replica")
            ]
            if len(cross) != 1:
                reasons.append("cross-replica replay observation is missing or duplicated")
            elif pd.isna(cross.iloc[0]["routing_correct"]) or not bool(cross.iloc[0]["routing_correct"]):
                reasons.append("cross-replica request was not observed at its requested replica")
            elif cross.iloc[0]["expected_outcome"] != (
                "accepted" if planned["method"] == "in-memory" else "replay_detected"
            ) or cross.iloc[0]["actual_outcome"] != cross.iloc[0]["expected_outcome"]:
                reasons.append("cross-replica outcome does not match the configured replay-state semantics")

        if request_group["request_id"].isna().any() or request_group["request_id"].eq("").any() or request_group["request_id"].duplicated().any():
            reasons.append("request IDs are missing or duplicated")
        if request_group["jti_hash"].isna().any():
            reasons.append("jti_hash is missing on one or more request observations")
        if request_group["replay_detected"].isna().any():
            reasons.append("replay detection state is unknown on one or more requests")
        if request_group["protected_operation_executed"].isna().any():
            reasons.append("protected operation execution state is unknown on one or more requests")

        if not request_group.empty:
            metrics = compute_metrics(request_group, planned["method"], planned["replica_count"])
            derived_rows.append({**planned, **metrics})
            if not metrics["request_id_unique"]:
                reasons.append("request ID integrity check failed")
            if not metrics["protected_operation_consistent"]:
                reasons.append("protected operation execution disagrees with request outcomes")
            if not metrics["http_outcome_consistent"]:
                reasons.append("HTTP status, store outcome, and error category are inconsistent")
            if planned["replica_count"] > 1 and not bool(metrics["cross_replica_valid"]):
                reasons.append("cross-replica routing validation failed")
            concurrent = request_group[request_group["phase"] == "concurrent_replay"]
            configured_levels = set(metadata.get("configuration", {}).get("concurrency_levels", []))
            observed_levels = set(pd.to_numeric(concurrent["concurrency_level"], errors="coerce").dropna().astype(int))
            if configured_levels != observed_levels:
                reasons.append("observed concurrency levels differ from the configured levels")
            for _, batch in concurrent.groupby("concurrent_batch_id", dropna=False):
                accepted = batch[batch["actual_outcome"] == "accepted"]
                if batch["jti_hash"].nunique(dropna=True) != 1:
                    reasons.append("concurrent batch did not use one shared jti")
                    break
                if batch["concurrent_batch_id"].isna().any() or len(batch) != int(batch["concurrency_level"].iloc[0]):
                    reasons.append("concurrent batch size or identifier is invalid")
                    break
                if planned["method"] == "in-memory":
                    valid = accepted.groupby("replica_id").size().eq(1).all()
                    valid = valid and accepted["replica_id"].nunique() == batch["requested_replica_id"].nunique()
                else:
                    valid = len(accepted) == 1
                valid = valid and batch["actual_outcome"].isin(("accepted", "replay_detected")).all()
                valid = valid and batch["routing_correct"].eq(True).all()
                if len(batch) > 1 and batch["request_id"].nunique() != len(batch):
                    valid = False
                expected_label = (
                    "one_acceptance_per_replica"
                    if planned["method"] == "in-memory"
                    else "one_acceptance_per_jti"
                )
                valid = valid and batch["expected_outcome"].eq(expected_label).all()
                if not valid:
                    reasons.append("concurrent replay atomicity/routing validation failed")
                    break

        if scenario_record is not None:
            summary_row = summary[
                (summary["scenario_id"] == planned["scenario_id"])
                & (summary["method"] == planned["method"])
                & (pd.to_numeric(summary["replica_count"], errors="coerce") == planned["replica_count"])
                & (pd.to_numeric(summary["repetition"], errors="coerce") == planned["repetition"])
            ]
            if len(summary_row) != 1:
                reasons.append("summary row missing or duplicated")
            elif request_group.shape[0]:
                recomputed = derived_rows[-1]
                recorded = summary_row.iloc[0]
                for column in COMPARE_COLUMNS:
                    if not compare_value(recomputed.get(column, float("nan")), recorded.get(column, float("nan"))):
                        reasons.append(f"summary mismatch: {column}")
                        break

        validation_rows.append({**planned, "valid": not reasons, "validation_errors": "; ".join(reasons)})

    all_valid = len(validation_rows) == len(expected) and all(row["valid"] for row in validation_rows)
    if not metadata.get("redis_available") or not metadata.get("mariadb_available"):
        failures.append("one or more shared replay-store dependencies were unavailable")
        all_valid = False
    planned_requests = metadata.get("request_counts", {}).get("planned_measured_requests")
    completed_requests = metadata.get("request_counts", {}).get("completed_measured_requests")
    if planned_requests != completed_requests:
        failures.append("metadata request count is incomplete")
        all_valid = False
    return pd.DataFrame(validation_rows), pd.DataFrame(derived_rows), all_valid, failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("experiment_dir", type=Path, help="Explicit run directory containing metadata.json and CSV outputs")
    args = parser.parse_args()
    experiment_dir = args.experiment_dir.resolve()
    output_dir = experiment_dir / "analysis"
    output_dir.mkdir(parents=True, exist_ok=True)

    metadata = json.loads((experiment_dir / "metadata.json").read_text(encoding="utf-8"))
    requests = pd.read_csv(experiment_dir / "requests.csv")
    scenarios = pd.read_csv(experiment_dir / "scenarios.csv")
    summary = pd.read_csv(experiment_dir / "summary.csv")
    for column in (
        "concurrent_batch_id", "request_id", "jti_hash", "phase", "method", "replica_count",
        "repetition", "actual_outcome", "expected_outcome", "replay_context", "replica_id",
        "requested_replica_id", "routing_correct", "protected_operation_executed",
        "legitimate_request", "latency_ms", "store_latency_ms", "request_start_timestamp",
        "request_end_timestamp",
        "error_category", "status", "replay_detected",
    ):
        if column not in requests:
            requests[column] = requests["http_status"] if column == "status" and "http_status" in requests else pd.NA
    for column in ("replay_detected", "legitimate_request", "routing_correct", "protected_operation_executed"):
        if column in requests:
            requests[column] = requests[column].map(parse_bool).astype("boolean")
    for column in ("latency_ms", "store_latency_ms", "concurrency_level", "replica_count", "repetition", "status"):
        if column in requests:
            requests[column] = pd.to_numeric(requests[column], errors="coerce")

    validation, derived, all_valid, failures = validate_run(metadata, requests, scenarios, summary)
    validation.to_csv(output_dir / "scenario_validation.csv", index=False)
    derived.to_csv(output_dir / "derived_metrics.csv", index=False)
    requests.isna().sum().rename("missing_values").to_csv(output_dir / "missing_values.csv")

    matrix_complete = len(derived) == len(expected_scenarios(
        int(metadata.get("configuration", {}).get("repetitions", 0))
    ))
    dependencies_available = metadata.get("redis_available") and metadata.get("mariadb_available")
    comparison_generated = bool(all_valid and matrix_complete and dependencies_available)
    if comparison_generated:
        comparisons = derived.groupby(["method", "replica_count"], as_index=False)[list(COMPARE_COLUMNS)].mean(numeric_only=True)
        comparisons.to_csv(output_dir / "method_comparison.csv", index=False)
        comparisons.pivot(index="method", columns="replica_count", values="replay_detection_rate").plot(
            kind="bar", ylim=(0, 1), title="Replay detection rate by replica count", ylabel="Rate"
        )
        plt.tight_layout()
        plt.savefig(output_dir / "security_rates.png", dpi=150)
        plt.close()
        performance = requests[requests["phase"] == "performance"].copy()
        if not performance.empty:
            performance.boxplot(column="latency_ms", by=["method", "replica_count"])
            plt.suptitle("")
            plt.title("Runner-observed end-to-end latency")
            plt.ylabel("Latency (ms)")
            plt.tight_layout()
            plt.savefig(output_dir / "latency_by_method.png", dpi=150)
            plt.close()
    else:
        failures.append("comparison plots omitted because the complete 12-configuration run is not valid")

    report = {
        "experiment_id": metadata.get("experiment_id"),
        "valid": comparison_generated,
        "scenario_rows": len(validation),
        "valid_scenarios": int(validation["valid"].sum()) if not validation.empty else 0,
        "invalid_scenarios": int((~validation["valid"]).sum()) if not validation.empty else len(expected_scenarios(
            int(metadata.get("configuration", {}).get("repetitions", 0))
        )),
        "comparison_generated": comparison_generated,
        "failures": sorted(set(failures)),
    }
    (output_dir / "validation_report.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, indent=2))
    print(f"Analysis outputs: {output_dir}")
    if not comparison_generated:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
