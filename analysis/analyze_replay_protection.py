#!/usr/bin/env python3
"""Validate a replay-protection run and recompute metrics from request observations."""

import argparse
import json
import math
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd


METHODS = ("in-memory", "redis", "redis-ttl", "mysql")
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
    "concurrent_batch_count",
    "global_one_time_use_compliance_rate",
    "global_execution_availability_rate",
    "global_invariant_violations",
    "global_excess_acceptances",
    "global_excess_executions",
    "local_process_atomicity_compliance_rate",
    "concurrent_arrival_spread_mean_ms",
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


def compute_concurrent_batch_metrics(requests, events, metadata):
    concurrent = requests[requests["phase"] == "concurrent_replay"]
    if concurrent.empty:
        return pd.DataFrame()
    schema_version = int(metadata.get("metadata_schema_version", 0) or 0)
    execution_events = pd.DataFrame(
        event for event in events if event.get("event") == "protected_operation_executed"
    )
    rows = []
    group_columns = [
        "experiment_id", "scenario_id", "method", "replica_count", "repetition",
        "concurrency_level", "concurrent_batch_id",
    ]
    for keys, batch in concurrent.groupby(group_columns, dropna=False):
        experiment_id, scenario_id, method, replicas, repetition, level, batch_id = keys
        requested = batch["requested_replica_id"].dropna().astype(str)
        received = batch["replica_id"].dropna().astype(str)
        accepted = batch[batch["actual_outcome"] == "accepted"]
        accepted_by_replica = accepted.groupby("replica_id").size().to_dict()
        planned_by_replica = requested.value_counts().to_dict()
        received_by_replica = received.value_counts().to_dict()

        if schema_version >= 3:
            batch_request_ids = set(batch["request_id"].dropna().astype(str))
            matching_events = (
                execution_events[
                    execution_events["request_id"].astype(str).isin(batch_request_ids)
                ]
                if not execution_events.empty and "request_id" in execution_events
                else pd.DataFrame()
            )
            execution_count = len(matching_events)
            execution_by_replica = (
                matching_events.groupby("replica_id").size().to_dict()
                if not matching_events.empty and "replica_id" in matching_events
                else {}
            )
            execution_ids = (
                set(matching_events["request_id"].dropna().astype(str))
                if not matching_events.empty
                else set()
            )
            header_execution_ids = set(
                batch.loc[batch["protected_operation_executed"].eq(True), "request_id"]
                .dropna().astype(str)
            )
            event_evidence_complete = execution_ids == header_execution_ids
        else:
            execution_count = int(batch["protected_operation_executed"].eq(True).sum())
            execution_by_replica = batch.loc[
                batch["protected_operation_executed"].eq(True)
            ].groupby("replica_id").size().to_dict()
            event_evidence_complete = pd.NA

        arrivals = []
        if "order_service_arrival_monotonic_ns" in batch:
            for value in batch["order_service_arrival_monotonic_ns"].dropna():
                try:
                    if str(value).strip():
                        arrivals.append(int(value))
                except (TypeError, ValueError):
                    continue
        arrival_spread_ms = (
            (max(arrivals) - min(arrivals)) / 1e6
            if len(arrivals) == len(batch) and arrivals
            else float("nan")
        )
        mean_arrival_interval_ms = (
            (max(arrivals) - min(arrivals)) / (len(arrivals) - 1) / 1e6
            if len(arrivals) > 1
            else float("nan")
        )
        accepted_count = len(accepted)
        global_excess_acceptances = max(0, accepted_count - 1)
        global_excess_executions = max(0, execution_count - 1)
        expected_replicas = set(planned_by_replica)
        actual_replicas = set(received_by_replica)
        replica_coverage_valid = (
            expected_replicas.issubset(actual_replicas)
            if len(batch) >= int(replicas)
            else actual_replicas == expected_replicas
        )
        rows.append({
            "experiment_id": experiment_id,
            "scenario_id": scenario_id,
            "method": method,
            "replica_count": replicas,
            "repetition": repetition,
            "concurrency_level": level,
            "concurrent_batch_id": batch_id,
            "jti_hash_count": batch["jti_hash"].nunique(dropna=True),
            "batch_size": len(batch),
            "accepted_request_count": accepted_count,
            "replay_rejected_count": int((batch["actual_outcome"] == "replay_detected").sum()),
            "store_error_count": int((batch["actual_outcome"] == "store_error").sum()),
            "request_error_count": int((batch["actual_outcome"] == "request_error").sum()),
            "service_error_count": int((batch["actual_outcome"] == "service_error").sum()),
            "protected_operation_execution_count": execution_count,
            "execution_available": execution_count > 0,
            "execution_event_evidence_complete": event_evidence_complete,
            "distinct_replicas_reached": len(actual_replicas),
            "distinct_replicas_accepted": accepted["replica_id"].nunique(dropna=True),
            "accepted_count_by_replica": json.dumps(accepted_by_replica, sort_keys=True),
            "protected_operation_count_by_replica": json.dumps(execution_by_replica, sort_keys=True),
            "planned_request_count_by_replica": json.dumps(planned_by_replica, sort_keys=True),
            "received_request_count_by_replica": json.dumps(received_by_replica, sort_keys=True),
            "replicas_with_no_request": json.dumps(sorted(expected_replicas - actual_replicas)),
            "maximum_acceptances_on_one_replica": max(accepted_by_replica.values(), default=0),
            "arrival_spread_ms": arrival_spread_ms,
            "mean_arrival_interval_ms": mean_arrival_interval_ms,
            "global_excess_acceptances": global_excess_acceptances,
            "global_excess_executions": global_excess_executions,
            "global_one_time_use_compliant": accepted_count <= 1 and execution_count <= 1,
            "global_security_pass": accepted_count <= 1 and execution_count == 1,
            "global_invariant_violation": global_excess_acceptances > 0 or global_excess_executions > 0,
            "local_process_atomicity_compliant": (
                all(count <= 1 for count in accepted_by_replica.values())
                if method == "in-memory"
                else pd.NA
            ),
            "replica_routing_valid": bool(
                batch["routing_correct"].eq(True).all() and replica_coverage_valid
            ),
        })
    return pd.DataFrame(rows)


def compute_metrics(group, method, replica_count, batch_metrics=None):
    if batch_metrics is None:
        batch_metrics = pd.DataFrame()
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
        "concurrent_batch_count": len(batch_metrics),
        "global_one_time_use_compliance_rate": (
            float(batch_metrics["global_security_pass"].mean())
            if len(batch_metrics)
            else float("nan")
        ),
        "global_execution_availability_rate": (
            float(batch_metrics["execution_available"].mean())
            if len(batch_metrics)
            else float("nan")
        ),
        "global_invariant_violations": int(batch_metrics["global_invariant_violation"].sum())
        if len(batch_metrics) else 0,
        "global_excess_acceptances": int(batch_metrics["global_excess_acceptances"].sum())
        if len(batch_metrics) else 0,
        "global_excess_executions": int(batch_metrics["global_excess_executions"].sum())
        if len(batch_metrics) else 0,
        "local_process_atomicity_compliance_rate": (
            float(batch_metrics["local_process_atomicity_compliant"].mean())
            if method == "in-memory" and len(batch_metrics)
            else float("nan")
        ),
        "concurrent_arrival_spread_mean_ms": (
            batch_metrics["arrival_spread_ms"].mean()
            if len(batch_metrics) and batch_metrics["arrival_spread_ms"].notna().any()
            else float("nan")
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


def validate_run(metadata, requests, scenarios, summary, events=None):
    events = events or []
    schema_version = int(metadata.get("metadata_schema_version", 0) or 0)
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
    concurrent_batch_metrics = compute_concurrent_batch_metrics(requests, events, metadata)
    if schema_version >= 3:
        execution_event_ids = [
            str(event.get("request_id"))
            for event in events
            if event.get("event") == "protected_operation_executed"
        ]
        expected_execution_ids = set(
            requests.loc[
                requests["protected_operation_executed"].eq(True), "request_id"
            ].dropna().astype(str)
        )
        if (
            len(execution_event_ids) != len(set(execution_event_ids))
            or set(execution_event_ids) != expected_execution_ids
        ):
            failures.append(
                "protected-operation events do not match request-level execution evidence"
            )
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
            scenario_batches = concurrent_batch_metrics[
                (concurrent_batch_metrics["scenario_id"] == planned["scenario_id"])
                & (concurrent_batch_metrics["method"] == planned["method"])
                & (pd.to_numeric(concurrent_batch_metrics["replica_count"], errors="coerce")
                   == planned["replica_count"])
                & (pd.to_numeric(concurrent_batch_metrics["repetition"], errors="coerce")
                   == planned["repetition"])
            ] if not concurrent_batch_metrics.empty else pd.DataFrame()
            metrics = compute_metrics(
                request_group, planned["method"], planned["replica_count"], scenario_batches
            )
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
            configured_levels = metadata.get("configuration", {}).get("concurrency_levels", [])
            if schema_version >= 3 and (
                not configured_levels
                or any(not isinstance(level, int) or level < 1 for level in configured_levels)
                or len(set(configured_levels)) != len(configured_levels)
            ):
                reasons.append("configured concurrency levels must be unique positive integers")
            configured_levels = set(configured_levels)
            observed_levels = set(pd.to_numeric(concurrent["concurrency_level"], errors="coerce").dropna().astype(int))
            if configured_levels != observed_levels:
                reasons.append("observed concurrency levels differ from the configured levels")
            if schema_version >= 3:
                concurrent_id_counts = concurrent.groupby(
                    "concurrent_batch_id", dropna=False
                )["concurrency_level"].nunique(dropna=True)
                if concurrent["concurrent_batch_id"].isna().any() or concurrent["concurrent_batch_id"].eq("").any():
                    reasons.append("concurrent batch ID is missing")
                if concurrent_id_counts.gt(1).any():
                    reasons.append("a concurrent batch ID is reused across concurrency levels")
                batch_counts_by_level = (
                    concurrent.drop_duplicates("concurrent_batch_id")
                    .groupby("concurrency_level", dropna=False)["concurrent_batch_id"]
                    .nunique(dropna=False)
                )
                for level in configured_levels:
                    if int(batch_counts_by_level.get(level, 0)) != 1:
                        reasons.append(f"concurrency level {level} must have exactly one batch")
                if concurrent_batch_metrics.empty:
                    reasons.append("concurrent batch observations are missing")
                else:
                    for _, batch_metrics_row in scenario_batches.iterrows():
                        level = int(batch_metrics_row["concurrency_level"])
                        batch = concurrent[
                            concurrent["concurrent_batch_id"] == batch_metrics_row["concurrent_batch_id"]
                        ]
                        if len(batch) != level:
                            reasons.append(f"concurrency level {level} batch size is incomplete")
                        if batch["jti_hash"].nunique(dropna=True) != 1:
                            reasons.append("concurrent batch did not use one shared jti")
                        if batch["request_id"].isna().any() or batch["request_id"].duplicated().any():
                            reasons.append("concurrent batch request IDs are missing or duplicated")
                        if not batch_metrics_row["replica_routing_valid"]:
                            reasons.append("concurrent replica routing coverage failed")
                        if not batch_metrics_row["execution_event_evidence_complete"]:
                            reasons.append("protected operation execution events disagree with request evidence")
                        for column in (
                            "client_launch_monotonic_ns", "gateway_arrival_monotonic_ns",
                            "order_service_arrival_monotonic_ns", "replay_store_start_monotonic_ns",
                            "replay_store_end_monotonic_ns",
                        ):
                            if column not in batch or batch[column].isna().any() or batch[column].eq("").any():
                                reasons.append(f"concurrent batch is missing {column}")
            else:
                for _, batch in concurrent.groupby("concurrent_batch_id", dropna=False):
                    accepted = batch[batch["actual_outcome"] == "accepted"]
                    if batch["jti_hash"].nunique(dropna=True) != 1:
                        reasons.append("concurrent batch did not use one shared jti")
                        break
                    if batch["concurrent_batch_id"].isna().any() or len(batch) != int(batch["concurrency_level"].iloc[0]):
                        reasons.append("concurrent batch size or identifier is invalid")
                        break
                    valid = (
                        accepted.groupby("replica_id").size().eq(1).all()
                        and accepted["replica_id"].nunique() == batch["requested_replica_id"].nunique()
                        if planned["method"] == "in-memory"
                        else len(accepted) == 1
                    )
                    valid = valid and batch["actual_outcome"].isin(("accepted", "replay_detected")).all()
                    valid = valid and batch["routing_correct"].eq(True).all()
                    if len(batch) > 1 and batch["request_id"].nunique() != len(batch):
                        valid = False
                    if not valid:
                        reasons.append("legacy concurrent replay atomicity/routing validation failed")
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
                for column in (name for name in COMPARE_COLUMNS if name in summary.columns):
                    if not compare_value(recomputed.get(column, float("nan")), recorded.get(column, float("nan"))):
                        reasons.append(f"summary mismatch: {column}")
                        break

        validation_rows.append({**planned, "valid": not reasons, "validation_errors": "; ".join(reasons)})

    all_valid = len(validation_rows) == len(expected) and all(row["valid"] for row in validation_rows)
    if not metadata.get("redis_available") or not metadata.get("mysql_available"):
        failures.append("one or more shared replay-store dependencies were unavailable")
        all_valid = False
    planned_requests = metadata.get("request_counts", {}).get("planned_measured_requests")
    completed_requests = metadata.get("request_counts", {}).get("completed_measured_requests")
    if planned_requests != completed_requests or completed_requests != len(requests):
        failures.append("metadata request count is incomplete")
        all_valid = False
    if failures:
        all_valid = False
    return (
        pd.DataFrame(validation_rows),
        pd.DataFrame(derived_rows),
        concurrent_batch_metrics,
        all_valid,
        failures,
    )


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
    events_path = experiment_dir / "events.jsonl"
    events = [
        json.loads(line)
        for line in events_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ] if events_path.exists() else []
    for column in (
        "concurrent_batch_id", "request_id", "jti_hash", "phase", "method", "replica_count",
        "repetition", "actual_outcome", "expected_outcome", "replay_context", "replica_id",
        "requested_replica_id", "routing_correct", "protected_operation_executed",
        "legitimate_request", "latency_ms", "store_latency_ms", "request_start_timestamp",
        "request_end_timestamp",
        "error_category", "status", "replay_detected", "experiment_id",
        "order_service_arrival_monotonic_ns", "client_launch_monotonic_ns",
        "gateway_arrival_monotonic_ns", "replay_store_start_monotonic_ns",
        "replay_store_end_monotonic_ns",
    ):
        if column not in requests:
            requests[column] = requests["http_status"] if column == "status" and "http_status" in requests else pd.NA
    for column in ("replay_detected", "legitimate_request", "routing_correct", "protected_operation_executed"):
        if column in requests:
            requests[column] = requests[column].map(parse_bool).astype("boolean")
    for column in ("latency_ms", "store_latency_ms", "concurrency_level", "replica_count", "repetition", "status"):
        if column in requests:
            requests[column] = pd.to_numeric(requests[column], errors="coerce")

    validation, derived, concurrent_batches, all_valid, failures = validate_run(
        metadata, requests, scenarios, summary, events
    )
    validation.to_csv(output_dir / "scenario_validation.csv", index=False)
    derived.to_csv(output_dir / "derived_metrics.csv", index=False)
    concurrent_batches.to_csv(output_dir / "concurrent_batch_metrics.csv", index=False)
    requests.isna().sum().rename("missing_values").to_csv(output_dir / "missing_values.csv")

    matrix_complete = len(derived) == len(expected_scenarios(
        int(metadata.get("configuration", {}).get("repetitions", 0))
    ))
    dependencies_available = metadata.get("redis_available") and metadata.get("mysql_available")
    comparison_generated = bool(all_valid and matrix_complete and dependencies_available)
    if comparison_generated:
        compared_columns = [column for column in COMPARE_COLUMNS if column in derived.columns]
        comparisons = derived.groupby(["method", "replica_count"], as_index=False)[compared_columns].mean(numeric_only=True)
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

        concurrent_comparison = (
            concurrent_batches.groupby(
                ["method", "replica_count", "concurrency_level"], as_index=False
            )
            .agg(
                batch_count=("concurrent_batch_id", "count"),
                global_one_time_use_compliance_rate=("global_security_pass", "mean"),
                execution_availability_rate=("execution_available", "mean"),
                global_excess_acceptances=("global_excess_acceptances", "sum"),
                global_excess_executions=("global_excess_executions", "sum"),
                protected_operation_execution_count=("protected_operation_execution_count", "sum"),
                distinct_replicas_reached_mean=("distinct_replicas_reached", "mean"),
                arrival_spread_mean_ms=("arrival_spread_ms", "mean"),
            )
        )
        if "local_process_atomicity_compliant" in concurrent_batches:
            local = concurrent_batches[concurrent_batches["method"] == "in-memory"]
            local_comparison = (
                local.groupby(["replica_count", "concurrency_level"], as_index=False)
                .agg(local_process_atomicity_compliance_rate=("local_process_atomicity_compliant", "mean"))
            )
            concurrent_comparison = concurrent_comparison.merge(
                local_comparison, on=["replica_count", "concurrency_level"], how="left"
            )
        concurrent_comparison.to_csv(output_dir / "concurrent_comparison.csv", index=False)

        for metric, filename, title, ylabel in (
            (
                "global_one_time_use_compliance_rate",
                "concurrent_global_compliance.png",
                "Global one-time-use compliance by concurrency",
                "Compliant batches / available executions",
            ),
            (
                "global_excess_executions",
                "concurrent_global_excess_executions.png",
                "Global excess protected-operation executions",
                "Excess executions per method/replica count/level",
            ),
            (
                "protected_operation_execution_count",
                "concurrent_protected_operations.png",
                "Protected operations observed per concurrency level",
                "Executions across repetitions",
            ),
            (
                "distinct_replicas_reached_mean",
                "concurrent_replica_distribution.png",
                "Actual replicas reached by concurrency level",
                "Mean replicas reached per batch",
            ),
            (
                "arrival_spread_mean_ms",
                "concurrent_arrival_spread.png",
                "Order Service arrival spread by concurrency",
                "Arrival spread (ms)",
            ),
        ):
            figure, axes = plt.subplots(1, len(REPLICA_COUNTS), figsize=(15, 4), sharey=True)
            for axis, replicas in zip(axes, REPLICA_COUNTS):
                subset = concurrent_comparison[concurrent_comparison["replica_count"] == replicas]
                for method, method_rows in subset.groupby("method"):
                    axis.plot(
                        method_rows["concurrency_level"],
                        method_rows[metric],
                        marker="o",
                        label=method,
                    )
                axis.set(
                    xlabel="Concurrency level",
                    title=f"{replicas} replika",
                    xticks=sorted(metadata["configuration"]["concurrency_levels"]),
                )
                axis.grid(alpha=0.25)
            axes[0].set_ylabel(ylabel)
            axes[-1].legend(loc="best")
            figure.suptitle(title)
            figure.tight_layout()
            figure.savefig(output_dir / filename, dpi=150)
            plt.close(figure)

        local = concurrent_comparison[concurrent_comparison["method"] == "in-memory"]
        if not local.empty and "local_process_atomicity_compliance_rate" in local:
            figure, axis = plt.subplots(figsize=(8, 5))
            for replicas, rows in local.groupby("replica_count"):
                axis.plot(
                    rows["concurrency_level"],
                    rows["local_process_atomicity_compliance_rate"],
                    marker="o",
                    label=f"{replicas} replika",
                )
            axis.set(
                xlabel="Concurrency level",
                ylabel="Atomic batches / batches",
                title="In-memory local process atomicity",
                xticks=sorted(metadata["configuration"]["concurrency_levels"]),
                ylim=(-0.03, 1.03),
            )
            axis.grid(alpha=0.25)
            axis.legend()
            figure.tight_layout()
            figure.savefig(output_dir / "in_memory_local_atomicity.png", dpi=150)
            plt.close(figure)

        concurrent_comparison["concurrency_level_group"] = concurrent_comparison[
            "concurrency_level"
        ].map(lambda level: "historical" if level in (1, 10, 50) else "added")
        level_comparison = (
            concurrent_comparison.groupby(
                ["method", "replica_count", "concurrency_level_group", "concurrency_level"],
                as_index=False,
            )[
                [
                    "global_one_time_use_compliance_rate",
                    "global_excess_executions",
                    "arrival_spread_mean_ms",
                ]
            ]
            .mean(numeric_only=True)
        )
        level_comparison.to_csv(output_dir / "concurrency_level_comparison.csv", index=False)
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
