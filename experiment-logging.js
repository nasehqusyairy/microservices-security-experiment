const fs = require("fs");
const path = require("path");

const REQUEST_COLUMNS = [
  "experiment_id", "scenario_id", "repetition", "method", "replica_count", "phase",
  "request_id", "jti_hash", "replica_id", "sequence_number", "concurrency_level",
  "request_start_timestamp", "request_end_timestamp", "latency_ms", "http_status",
  "expected_outcome", "actual_outcome", "outcome_correct", "replay_detected",
  "legitimate_request", "store_operation", "store_latency_ms", "store_ttl_ms", "replay_context",
  "error_category", "error_message"
];
const SCENARIO_COLUMNS = [
  "experiment_id", "scenario_id", "method", "replica_count", "repetition",
  "planned_requests", "completed_requests", "accepted_requests", "rejected_requests",
  "replay_attempts", "replay_blocked", "legitimate_requests", "legitimate_accepted",
  "error_count", "status", "reason", "start_time", "end_time"
];
const SUMMARY_COLUMNS = [
  "experiment_id", "scenario_id", "method", "replica_count", "repetition",
  "replay_detection_rate", "legitimate_request_acceptance_rate", "false_rejection_rate",
  "false_acceptance_rate", "replay_acceptance_count", "replay_rejection_count",
  "latency_mean_ms", "latency_median_ms", "latency_std_ms", "latency_p95_ms",
  "latency_p99_ms", "throughput_rps", "store_latency_mean_ms", "store_latency_p95_ms",
  "cpu_usage", "memory_usage_mb", "store_error_count", "service_error_count",
  "cross_replica_replay_detection_rate", "restart_state_retained"
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
  const serviceErrors = requests.filter((request) =>
    request.error_category === "service_error" || request.error_category === "request_error"
  ).length;

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
    service_error_count: serviceErrors,
    cross_replica_replay_detection_rate: scenario.replica_count > 1
      ? rate(crossReplicaBlocked, crossReplicaReplayRows.length)
      : null,
    restart_state_retained: restartStateRetained
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
        `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`
      );
    }
  };
}

module.exports = {
  REQUEST_COLUMNS,
  SCENARIO_COLUMNS,
  SUMMARY_COLUMNS,
  appendCsv,
  createExperimentFiles,
  percentile,
  summarizeScenario
};
