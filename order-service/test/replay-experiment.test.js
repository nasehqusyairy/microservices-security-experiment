const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const {
  InMemoryReplayStore,
  RedisReplayStore,
  RedisTtlReplayStore,
  MySQLReplayStore
} = require("../replay-stores");
const { createReplayMiddleware } = require("../replay-auth");
const { createLaunchBarrier, parseConcurrencyLevels } = require("../../experiment-concurrency");
const {
  REQUEST_COLUMNS,
  createExperimentFiles,
  summarizeConcurrentBatch,
  summarizeScenario
} = require("../../experiment-logging");

class FakeRedis {
  constructor() {
    this.values = new Map();
    this.options = new Map();
  }

  async set(key, value, options = {}) {
    const now = Date.now();
    for (const [storedKey, stored] of this.values) {
      if (stored.expiresAt !== null && stored.expiresAt <= now) this.values.delete(storedKey);
    }
    if (options.NX && this.values.has(key)) return null;
    this.options.set(key, options);
    this.values.set(key, {
      value,
      expiresAt: options.PX ? now + options.PX : null
    });
    return "OK";
  }
}

function middlewareResponse() {
  return {
    statusCode: 200,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
}

function issueToken(secret, overrides = {}) {
  return jwt.sign(
    { service: "order_service", jti: crypto.randomUUID(), ...overrides },
    secret,
    { issuer: "auth-service", audience: "order-service", expiresIn: "30s" }
  );
}

async function callMiddleware(middleware, token) {
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = middlewareResponse();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

test("in-memory store accepts first use and rejects replay", async () => {
  const store = new InMemoryReplayStore();
  assert.equal((await store.consume("jti-a")).outcome, "accepted");
  assert.equal((await store.consume("jti-a")).outcome, "replay_detected");
});

test("in-memory store accepts different identifiers and is process-local", async () => {
  const replicaA = new InMemoryReplayStore();
  const replicaB = new InMemoryReplayStore();
  assert.equal((await replicaA.consume("jti-a")).outcome, "accepted");
  assert.equal((await replicaA.consume("jti-b")).outcome, "accepted");
  assert.equal((await replicaB.consume("jti-a")).outcome, "accepted");
});

test("in-memory consume is atomic under repeated high-concurrency calls in one process", async () => {
  for (let repetition = 0; repetition < 25; repetition += 1) {
    const store = new InMemoryReplayStore();
    const results = await Promise.all(
      Array.from({ length: 1000 }, () => store.consume(`stress-jti-${repetition}`))
    );
    assert.equal(results.filter((result) => result.outcome === "accepted").length, 1);
    assert.equal(results.filter((result) => result.outcome === "replay_detected").length, 999);
  }
});

test("independent in-memory replicas each accept once and violate global one-time use", async () => {
  const replicas = [new InMemoryReplayStore(), new InMemoryReplayStore(), new InMemoryReplayStore()];
  const results = await Promise.all(replicas.map((store) =>
    Promise.all(Array.from({ length: 100 }, () => store.consume("same-global-jti")))
  ));
  assert.deepEqual(
    results.map((replicaResults) =>
      replicaResults.filter((result) => result.outcome === "accepted").length
    ),
    [1, 1, 1]
  );
  const batch = summarizeConcurrentBatch(
    results.flatMap((replicaResults, replicaIndex) => {
      const replicaId = `order-${replicaIndex + 1}`;
      const accepted = replicaResults.find((result) => result.outcome === "accepted");
      return [
        {
          requested_replica_id: replicaId,
          replica_id: replicaId,
          actual_outcome: accepted.outcome,
          protected_operation_executed: true,
          order_service_arrival_monotonic_ns: String(1000 + replicaIndex * 1_000_000)
        },
        ...replicaResults
          .filter((result) => result.outcome === "replay_detected")
          .map(() => ({
            requested_replica_id: replicaId,
            replica_id: replicaId,
            actual_outcome: "replay_detected",
            protected_operation_executed: false,
            order_service_arrival_monotonic_ns: String(1000 + replicaIndex * 1_000_000)
          }))
      ];
    }),
    "in-memory",
    3
  );
  assert.equal(batch.local_process_atomicity_compliant, true);
  assert.equal(batch.global_one_time_use_compliant, false);
  assert.equal(batch.global_excess_executions, 2);
  assert.equal(batch.distinct_replicas_executed, 3);
});

test("launch barrier waits until every prepared request is ready", async () => {
  const barrier = createLaunchBarrier(3);
  let released = false;
  const participants = Array.from({ length: 3 }, async () => {
    await barrier.wait();
    released = true;
  });
  await Promise.all(participants);
  assert.equal(released, true);
});

test("concurrency levels validate, deduplicate in order, and preserve mode defaults", () => {
  assert.deepEqual(parseConcurrencyLevels("1,5,10,5,25,50", [1]), [1, 5, 10, 25, 50]);
  assert.deepEqual(parseConcurrencyLevels("", [1, 5]), [1, 5]);
  assert.throws(() => parseConcurrencyLevels("1,0,5", []), /integers from 1 to 1000/);
  assert.throws(() => parseConcurrencyLevels("1,1.5", []), /integers from 1 to 1000/);
});

test("Redis store atomically accepts a jti once across replicas", async () => {
  const client = new FakeRedis();
  const replicaA = new RedisReplayStore(client, "test");
  const replicaB = new RedisReplayStore(client, "test");
  assert.equal((await replicaA.consume("jti-a")).outcome, "accepted");
  assert.equal((await replicaB.consume("jti-a")).outcome, "replay_detected");
  assert.equal((await replicaB.consume("jti-b")).outcome, "accepted");
});

test("concurrent Redis duplicates have exactly one accepted operation", async () => {
  const store = new RedisReplayStore(new FakeRedis(), "concurrent");
  const outcomes = await Promise.all(Array.from({ length: 50 }, () => store.consume("same-jti")));
  assert.equal(outcomes.filter((result) => result.outcome === "accepted").length, 1);
  assert.equal(outcomes.filter((result) => result.outcome === "replay_detected").length, 49);
});

test("Redis TTL uses remaining JWT lifetime and expires the replay key", async () => {
  const client = new FakeRedis();
  const store = new RedisTtlReplayStore(client, "ttl");
  const jti = "expiring-jti";
  const expiry = Math.floor(Date.now() / 1000) + 2;
  assert.equal((await store.consume(jti, expiry)).outcome, "accepted");
  const [key, options] = [...client.options.entries()][0];
  assert.ok(options.PX > 0 && options.PX <= 2000);
  assert.equal(options.NX, true);
  await new Promise((resolve) => setTimeout(resolve, options.PX + 20));
  assert.equal((await store.consume(jti, Math.floor(Date.now() / 1000) + 2)).outcome, "accepted");
  assert.equal(key.startsWith("ttl:"), true);
});

test("MySQL replay store claims a hashed jti with one atomic INSERT", async () => {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(sql);
      return [];
    },
    async execute(sql, values) {
      statements.push({ sql, values });
      return {};
    }
  };
  const store = new MySQLReplayStore(pool);
  const result = await store.consume("database-jti", 123456);
  assert.equal(result.outcome, "accepted");
  assert.equal(statements.filter((statement) =>
    typeof statement === "object" && statement.sql.startsWith("INSERT INTO")
  ).length, 1);
  assert.match(statements[1].sql, /^INSERT INTO consumed_tokens \(jti_hash, expires_at\) VALUES \(\?, \?\)$/);
  assert.equal(
    statements[1].values[0],
    crypto.createHash("sha256").update("database-jti").digest("hex")
  );
  assert.equal(statements[1].values[1], 123456);
});

test("MySQL duplicate keys are replays but other database errors are store errors", async () => {
  const duplicateStore = new MySQLReplayStore({
    async query() { return []; },
    async execute() {
      const error = new Error("duplicate");
      error.code = "ER_DUP_ENTRY";
      error.errno = 1062;
      throw error;
    }
  });
  assert.equal((await duplicateStore.consume("duplicate-jti", 1)).outcome, "replay_detected");

  const failedStore = new MySQLReplayStore({
    async query() { return []; },
    async execute() {
      const error = new Error("connection failed");
      error.code = "ECONNREFUSED";
      throw error;
    }
  });
  const result = await failedStore.consume("failed-jti", 1);
  assert.equal(result.outcome, "store_error");
  assert.equal(result.errorCategory, "ECONNREFUSED");
});

test("concurrent MySQL insert claims accept exactly one duplicate jti", async () => {
  const hashes = new Set();
  const store = new MySQLReplayStore({
    async query() { return []; },
    async execute(_sql, [jtiHash]) {
      if (hashes.has(jtiHash)) {
        const error = new Error("duplicate");
        error.code = "ER_DUP_ENTRY";
        error.errno = 1062;
        throw error;
      }
      hashes.add(jtiHash);
    }
  });
  const results = await Promise.all(
    Array.from({ length: 50 }, () => store.consume("same-database-jti", 123456))
  );
  assert.equal(results.filter((result) => result.outcome === "accepted").length, 1);
  assert.equal(results.filter((result) => result.outcome === "replay_detected").length, 49);
});

test("JWT validation rejects invalid tokens before consulting replay storage", async () => {
  let storeCalls = 0;
  const middleware = createReplayMiddleware({
    jwtSecret: "expected-secret",
    replayStore: { async consume() { storeCalls += 1; return { outcome: "accepted" }; } }
  });
  const result = await callMiddleware(middleware, issueToken("wrong-secret"));
  assert.equal(result.res.statusCode, 401);
  assert.equal(result.nextCalled, false);
  assert.equal(storeCalls, 0);
});

test("replay storage failures are reported separately from replay detections", async () => {
  const middleware = createReplayMiddleware({
    jwtSecret: "test-secret",
    experimentMode: true,
    replayStore: { async consume() { throw new Error("private infrastructure detail"); } }
  });
  const result = await callMiddleware(middleware, issueToken("test-secret"));
  assert.equal(result.res.statusCode, 503);
  assert.equal(result.res.headers["x-experiment-store-result"], "store_error");
  assert.notEqual(result.res.headers["x-experiment-store-result"], "replay_detected");
  assert.equal(result.res.body, "Replay protection unavailable");
});

test("experiment CSV has a stable schema and contains no raw token or secret", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "replay-log-test-"));
  const files = createExperimentFiles(directory);
  const token = "eyJ.complete.secret-token";
  const secret = "never-log-this-secret";
  const row = Object.fromEntries(REQUEST_COLUMNS.map((column) => [column, ""]));
  Object.assign(row, {
    experiment_id: "experiment",
    request_id: "request",
    jti_hash: "hashed-jti",
    actual_outcome: "accepted",
    protected_operation_executed: true
  });
  row.token = token;
  row.secret = secret;
  files.request(row);
  const csv = fs.readFileSync(path.join(directory, "requests.csv"), "utf8");
  assert.equal(csv.split("\n")[0], REQUEST_COLUMNS.join(","));
  assert.equal(csv.trimEnd().split("\n")[1].split(",").length, REQUEST_COLUMNS.length);
  assert.equal(csv.includes(token), false);
  assert.equal(csv.includes(secret), false);
  assert.ok(REQUEST_COLUMNS.includes("protected_operation_executed"));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("summary metrics are reproducible from raw request observations", () => {
  const scenario = { scenario_id: "S1", method: "in-memory", replica_count: 1, repetition: 1 };
  const requests = [
    { phase: "first_use", legitimate_request: true, actual_outcome: "accepted", latency_ms: 1, store_latency_ms: 0.1,
      protected_operation_executed: true },
    { phase: "replay", expected_outcome: "replay_detected", replay_detected: true, actual_outcome: "replay_detected", latency_ms: 1.5,
      protected_operation_executed: false },
    { phase: "performance", legitimate_request: true, actual_outcome: "accepted", latency_ms: 2, store_latency_ms: 0.2,
      request_start_timestamp: "2026-01-01T00:00:00.000000000Z",
      request_end_timestamp: "2026-01-01T00:00:01.000000000Z" },
    { phase: "performance", legitimate_request: true, actual_outcome: "accepted", latency_ms: 4, store_latency_ms: 0.4,
      request_start_timestamp: "2026-01-01T00:00:01.000000000Z",
      request_end_timestamp: "2026-01-01T00:00:02.000000000Z" }
  ];
  const summary = summarizeScenario({ experimentId: "experiment", scenario, requests, restartStateRetained: false });
  assert.equal(summary.replay_detection_rate, 1);
  assert.equal(summary.legitimate_request_acceptance_rate, 1);
  assert.equal(summary.latency_mean_ms, 3);
  assert.equal(summary.latency_median_ms, 3);
  assert.equal(summary.latency_p95_ms, 3.9);
  assert.equal(summary.latency_p99_ms, 3.98);
  assert.equal(summary.throughput_rps, 1);
  assert.equal(summary.restart_state_retained, false);
  assert.equal(summary.protected_operation_execution_count, 1);
});

test("concurrent replay metrics exclude one expected first use per jti", () => {
  const scenario = { scenario_id: "S4", method: "in-memory", replica_count: 2, repetition: 1 };
  const requests = [
    { phase: "concurrent_replay", jti_hash: "same", actual_outcome: "replay_detected", replay_detected: true, legitimate_request: true },
    { phase: "concurrent_replay", jti_hash: "same", actual_outcome: "replay_detected", replay_detected: true, legitimate_request: false }
  ];
  const summary = summarizeScenario({ experimentId: "experiment", scenario, requests, restartStateRetained: null });
  assert.equal(summary.replay_detection_rate, 1);
  assert.equal(summary.legitimate_request_acceptance_rate, 0);
  assert.equal(summary.false_rejection_rate, 1);
  assert.equal(summary.replay_rejection_count, 1);
  assert.equal(summary.false_acceptance_rate, 0);
});
