const fs = require("fs");
const path = require("path");

const REQUEST_COLUMNS = [
  "experiment_id", "scenario_id", "repetition", "method", "replay_store", "replica_count", "phase",
  "request_type", "request_id", "jti_hash", "requested_replica_id", "replica_id", "routing_correct",
  "sequence_number", "concurrency_level", "concurrent_batch_id", "timestamp",
  "client_launch_timestamp", "client_launch_monotonic_ns",
  "gateway_arrival_timestamp", "gateway_arrival_monotonic_ns",
  "order_service_arrival_timestamp", "order_service_arrival_monotonic_ns",
  "replay_store_start_timestamp", "replay_store_start_monotonic_ns",
  "replay_store_end_timestamp", "replay_store_end_monotonic_ns",
  "request_start_timestamp", "request_end_timestamp", "latency_ms", "http_status",
  "status", "expected_outcome", "actual_outcome", "outcome_correct", "replay_detected",
  "legitimate_request", "store_operation", "store_latency_ms", "store_ttl_ms", "replay_context",
  "protected_operation_executed", "error_category", "error_message"
];
const SCENARIO_COLUMNS = [
  "experiment_id", "scenario_id", "method", "replica_count", "repetition",
  "planned_requests", "completed_requests", "accepted_requests", "rejected_requests",
  "replay_attempts", "replay_blocked", "legitimate_requests", "legitimate_accepted",
  "protected_operation_execution_count", "concurrent_batch_count",
  "global_invariant_violations", "global_excess_acceptances", "global_excess_executions",
  "global_one_time_use_compliant_batch_count", "execution_available_batch_count",
  "local_process_atomicity_violations", "concurrent_arrival_spread_mean_ms",
  "planned_request_count_by_replica", "received_request_count_by_replica",
  "accepted_count_by_replica", "replay_rejected_count_by_replica",
  "protected_operation_count_by_replica",
  "error_count", "status", "reason", "start_time", "end_time"
];
const SUMMARY_COLUMNS = [
  "experiment_id", "scenario_id", "method", "replica_count", "repetition",
  "replay_detection_rate", "legitimate_request_acceptance_rate", "false_rejection_rate",
  "false_acceptance_rate", "replay_acceptance_count", "replay_rejection_count",
  "latency_mean_ms", "latency_median_ms", "latency_std_ms", "latency_p95_ms",
  "latency_p99_ms", "throughput_rps", "store_latency_mean_ms", "store_latency_p95_ms",
  "cpu_usage", "memory_usage_mb", "store_error_count", "request_error_count", "service_error_count",
  "cross_replica_replay_detection_rate", "restart_state_retained",
  "protected_operation_execution_count", "concurrent_batch_count",
  "global_one_time_use_compliance_rate", "global_execution_availability_rate",
  "global_invariant_violations", "global_excess_acceptances", "global_excess_executions",
  "local_process_atomicity_compliance_rate", "concurrent_arrival_spread_mean_ms",
  "planned_request_count_by_replica", "received_request_count_by_replica",
  "accepted_count_by_replica", "replay_rejected_count_by_replica",
  "protected_operation_count_by_replica"
];

function csvCell(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  const text = typeof value === "boolean" ? String(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function appendCsv(filePath, columns, row) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${columns.map(csvCell).join(",")}\n`);
  }
  fs.appendFileSync(filePath, `${columns.map((column) => csvCell(row[column])).join(",")}\n`);
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function sampleStdDev(values) {
  if (values.length < 2) return values.length ? 0 : null;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function summarizeConcurrentBatch(requests, method, replicaCount) {
  const plannedByReplica = {};
  const receivedByReplica = {};
  const acceptedByReplica = {};
  const replayRejectedByReplica = {};
  const protectedByReplica = {};
  for (const request of requests) {
    const plannedReplica = request.requested_replica_id;
    if (plannedReplica) plannedByReplica[plannedReplica] = (plannedByReplica[plannedReplica] || 0) + 1;
    const actualReplica = request.replica_id;
    if (actualReplica) receivedByReplica[actualReplica] = (receivedByReplica[actualReplica] || 0) + 1;
    if (request.actual_outcome === "accepted" && actualReplica) {
      acceptedByReplica[actualReplica] = (acceptedByReplica[actualReplica] || 0) + 1;
    }
    if (request.actual_outcome === "replay_detected" && actualReplica) {
      replayRejectedByReplica[actualReplica] = (replayRejectedByReplica[actualReplica] || 0) + 1;
    }
    if (request.protected_operation_executed === true && actualReplica) {
      protectedByReplica[actualReplica] = (protectedByReplica[actualReplica] || 0) + 1;
    }
  }
  const acceptedRequestCount = requests.filter((request) => request.actual_outcome === "accepted").length;
  const executionCount = requests.filter((request) => request.protected_operation_executed === true).length;
  const maxAcceptancesOnOneReplica = Math.max(0, ...Object.values(acceptedByReplica));
  const acceptedByReplicaValues = Object.values(acceptedByReplica);
  const localAtomicityCompliant = acceptedByReplicaValues.every((count) => count <= 1);
  const arrivals = requests
    .map((request) => request.order_service_arrival_monotonic_ns)
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => BigInt(value))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const arrivalSpreadMs = arrivals.length === requests.length && arrivals.length
    ? Number(arrivals[arrivals.length - 1] - arrivals[0]) / 1e6
    : null;
  const arrivalIntervalMs = arrivals.length > 1
    ? Number(arrivals[arrivals.length - 1] - arrivals[0]) / (arrivals.length - 1) / 1e6
    : null;
  const globalOneTimeUseCompliant = acceptedRequestCount <= 1 && executionCount <= 1;

  return {
    batch_size: requests.length,
    accepted_request_count: acceptedRequestCount,
    replay_rejected_count: requests.filter((request) => request.actual_outcome === "replay_detected").length,
    store_error_count: requests.filter((request) => request.actual_outcome === "store_error").length,
    request_error_count: requests.filter((request) => request.actual_outcome === "request_error").length,
    service_error_count: requests.filter((request) => request.actual_outcome === "service_error").length,
    protected_operation_execution_count: executionCount,
    distinct_replicas_reached: Object.keys(receivedByReplica).length,
    distinct_replicas_accepted: Object.keys(acceptedByReplica).length,
    distinct_replicas_executed: Object.keys(protectedByReplica).length,
    arrival_spread_ms: arrivalSpreadMs,
    mean_arrival_interval_ms: arrivalIntervalMs,
    global_excess_acceptances: Math.max(0, acceptedRequestCount - 1),
    global_excess_executions: Math.max(0, executionCount - 1),
    global_one_time_use_compliant: globalOneTimeUseCompliant,
    execution_available: executionCount > 0,
    local_process_atomicity_compliant: method === "in-memory" ? localAtomicityCompliant : null,
    accepted_count_by_replica: acceptedByReplica,
    replay_rejected_count_by_replica: replayRejectedByReplica,
    protected_operation_count_by_replica: protectedByReplica,
    planned_request_count_by_replica: plannedByReplica,
    received_request_count_by_replica: receivedByReplica,
    replicas_with_no_request: Object.keys(plannedByReplica)
      .filter((replicaId) => !receivedByReplica[replicaId]),
    maximum_acceptances_on_one_replica: maxAcceptancesOnOneReplica,
    expected_replicas_covered: requests.length < replicaCount
      ? Object.keys(receivedByReplica).every((replicaId) => (plannedByReplica[replicaId] || 0) > 0)
      : Object.keys(plannedByReplica).every((replicaId) => (receivedByReplica[replicaId] || 0) > 0)
  };
}

function timestampMilliseconds(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return NaN;
  const fraction = value.match(/\.(\d+)Z$/);
  if (!fraction) return parsed;
  const digits = fraction[1];
  const millisecondPart = Number((digits + "000").slice(0, 3));
  const fullFractionMs = Number(`0.${digits}`) * 1000;
  return parsed + fullFractionMs - millisecondPart;
}

function summarizeScenario({ experimentId, scenario, requests, restartStateRetained }) {
  const performance = requests.filter((request) => request.phase === "performance");
  const latencyValues = performance
    .map((request) => Number(request.latency_ms))
    .filter(Number.isFinite);
  const storeLatencyValues = performance
    .map((request) => Number(request.store_latency_ms))
    .filter(Number.isFinite);
  const replayRows = requests.filter((request) => request.phase === "replay");
  const concurrencyGroups = new Map();
  for (const request of requests.filter((row) => row.phase === "concurrent_replay")) {
    const key = request.jti_hash;
    if (!concurrencyGroups.has(key)) concurrencyGroups.set(key, []);
    concurrencyGroups.get(key).push(request);
  }
  const concurrentReplayExpected = [...concurrencyGroups.values()]
    .reduce((count, group) => count + Math.max(0, group.length - 1), 0);
  const replayBlocked = replayRows.filter((request) => request.replay_detected === true).length +
    requests.filter((request) =>
      request.phase === "concurrent_replay" &&
      request.legitimate_request !== true &&
      request.replay_detected === true
    ).length;
  const replayAttempts = replayRows.length + concurrentReplayExpected;
  const concurrentOverAcceptances = [...concurrencyGroups.values()].reduce(
    (count, group) => count + Math.max(
      0,
      group.filter((request) => request.actual_outcome === "accepted").length - 1
    ),
    0
  );
  const legitimateRows = requests.filter((request) =>
    request.legitimate_request === true && ["first_use", "performance", "concurrent_replay"].includes(request.phase)
  );
  const legitimateAccepted = legitimateRows.filter((request) => request.actual_outcome === "accepted").length;
  const replayAccepted = replayRows.filter((request) => request.actual_outcome === "accepted").length +
    concurrentOverAcceptances;
  const crossReplicaReplayRows = replayRows.filter((request) =>
    request.replay_context === "cross_replica"
  );
  const crossReplicaBlocked = crossReplicaReplayRows
    .filter((request) => request.replay_detected === true).length;
  const performanceTimes = performance.flatMap((request) => [
    timestampMilliseconds(request.request_start_timestamp),
    timestampMilliseconds(request.request_end_timestamp)
  ]).filter(Number.isFinite);
  const measurementSeconds = performanceTimes.length > 1
    ? (Math.max(...performanceTimes) - Math.min(...performanceTimes)) / 1000
    : null;
  const storeErrors = requests.filter((request) => request.error_category === "store_error").length;
  const requestErrors = requests.filter((request) => request.error_category === "request_error").length;
  const serviceErrors = requests.filter((request) => request.error_category === "service_error").length;
  const concurrentBatches = new Map();
  for (const request of requests.filter((row) => row.phase === "concurrent_replay")) {
    const key = request.concurrent_batch_id;
    if (!concurrentBatches.has(key)) concurrentBatches.set(key, []);
    concurrentBatches.get(key).push(request);
  }
  const batchMetrics = [...concurrentBatches.values()].map((batch) =>
    summarizeConcurrentBatch(batch, scenario.method, scenario.replica_count)
  );
  const batchCount = batchMetrics.length;
  const globalViolations = batchMetrics.filter((batch) =>
    batch.global_excess_executions > 0 || batch.global_excess_acceptances > 0
  ).length;
  const acceptedCountByReplica = {};
  const replayRejectedCountByReplica = {};
  const protectedCountByReplica = {};
  const plannedRequestCountByReplica = {};
  const receivedRequestCountByReplica = {};
  for (const batch of batchMetrics) {
    for (const [replicaId, count] of Object.entries(batch.planned_request_count_by_replica)) {
      plannedRequestCountByReplica[replicaId] = (plannedRequestCountByReplica[replicaId] || 0) + count;
    }
    for (const [replicaId, count] of Object.entries(batch.received_request_count_by_replica)) {
      receivedRequestCountByReplica[replicaId] = (receivedRequestCountByReplica[replicaId] || 0) + count;
    }
    for (const [replicaId, count] of Object.entries(batch.accepted_count_by_replica)) {
      acceptedCountByReplica[replicaId] = (acceptedCountByReplica[replicaId] || 0) + count;
    }
    for (const [replicaId, count] of Object.entries(batch.replay_rejected_count_by_replica)) {
      replayRejectedCountByReplica[replicaId] = (replayRejectedCountByReplica[replicaId] || 0) + count;
    }
    for (const [replicaId, count] of Object.entries(batch.protected_operation_count_by_replica)) {
      protectedCountByReplica[replicaId] = (protectedCountByReplica[replicaId] || 0) + count;
    }
  }

  return {
    experiment_id: experimentId,
    scenario_id: scenario.scenario_id,
    method: scenario.method,
    replica_count: scenario.replica_count,
    repetition: scenario.repetition,
    replay_detection_rate: rate(replayBlocked, replayAttempts),
    legitimate_request_acceptance_rate: rate(legitimateAccepted, legitimateRows.length),
    false_rejection_rate: rate(
      legitimateRows.filter((request) => request.actual_outcome !== "accepted").length,
      legitimateRows.length
    ),
    false_acceptance_rate: rate(replayAccepted, replayAttempts),
    replay_acceptance_count: replayAccepted,
    replay_rejection_count: replayBlocked,
    latency_mean_ms: mean(latencyValues),
    latency_median_ms: percentile(latencyValues, 0.5),
    latency_std_ms: sampleStdDev(latencyValues),
    latency_p95_ms: percentile(latencyValues, 0.95),
    latency_p99_ms: percentile(latencyValues, 0.99),
    throughput_rps: measurementSeconds > 0 ? performance.length / measurementSeconds : null,
    store_latency_mean_ms: mean(storeLatencyValues),
    store_latency_p95_ms: percentile(storeLatencyValues, 0.95),
    cpu_usage: null,
    memory_usage_mb: null,
    store_error_count: storeErrors,
    request_error_count: requestErrors,
    service_error_count: serviceErrors,
    cross_replica_replay_detection_rate: scenario.replica_count > 1
      ? rate(crossReplicaBlocked, crossReplicaReplayRows.length)
      : null,
    restart_state_retained: restartStateRetained,
    protected_operation_execution_count: requests.filter(
      (request) => request.protected_operation_executed === true
    ).length,
    concurrent_batch_count: batchCount,
    global_one_time_use_compliance_rate: rate(
      batchMetrics.filter((batch) => batch.global_one_time_use_compliant && batch.execution_available).length,
      batchCount
    ),
    global_execution_availability_rate: rate(
      batchMetrics.filter((batch) => batch.execution_available).length,
      batchCount
    ),
    global_invariant_violations: globalViolations,
    global_excess_acceptances: batchMetrics.reduce((sum, batch) => sum + batch.global_excess_acceptances, 0),
    global_excess_executions: batchMetrics.reduce((sum, batch) => sum + batch.global_excess_executions, 0),
    local_process_atomicity_compliance_rate: scenario.method === "in-memory"
      ? rate(batchMetrics.filter((batch) => batch.local_process_atomicity_compliant).length, batchCount)
      : null,
    concurrent_arrival_spread_mean_ms: mean(
      batchMetrics.map((batch) => batch.arrival_spread_ms).filter(Number.isFinite)
    ),
    planned_request_count_by_replica: JSON.stringify(plannedRequestCountByReplica),
    received_request_count_by_replica: JSON.stringify(receivedRequestCountByReplica),
    accepted_count_by_replica: JSON.stringify(acceptedCountByReplica),
    replay_rejected_count_by_replica: JSON.stringify(replayRejectedCountByReplica),
    protected_operation_count_by_replica: JSON.stringify(protectedCountByReplica)
  };
}

function createExperimentFiles(outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const [file, columns] of [
    ["requests.csv", REQUEST_COLUMNS],
    ["scenarios.csv", SCENARIO_COLUMNS],
    ["summary.csv", SUMMARY_COLUMNS]
  ]) {
    fs.writeFileSync(path.join(outputDir, file), `${columns.join(",")}\n`);
  }
  return {
    request(row) {
      appendCsv(path.join(outputDir, "requests.csv"), REQUEST_COLUMNS, row);
    },
    scenario(row) {
      appendCsv(path.join(outputDir, "scenarios.csv"), SCENARIO_COLUMNS, row);
    },
    summary(row) {
      appendCsv(path.join(outputDir, "summary.csv"), SUMMARY_COLUMNS, row);
    },
    event(event) {
      fs.appendFileSync(
        path.join(outputDir, "events.jsonl"),
        `${JSON.stringify({ schema_version: 3, timestamp: new Date().toISOString(), ...event })}\n`
      );
    }
  };
}

module.exports = {
  REQUEST_COLUMNS,
  summarizeConcurrentBatch,
  SCENARIO_COLUMNS,
  SUMMARY_COLUMNS,
  appendCsv,
  createExperimentFiles,
  percentile,
  summarizeScenario
};
