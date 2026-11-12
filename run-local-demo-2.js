#!/usr/bin/env node

const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const { createRequire } = require("module");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const shellEnvironment = { ...process.env };
const exampleEnvPath = path.join(__dirname, ".env.example");
const localEnvPath = path.join(__dirname, ".env");
const exampleEnvironment = dotenv.parse(fs.readFileSync(exampleEnvPath));
const localEnvironment = fs.existsSync(localEnvPath)
  ? dotenv.parse(fs.readFileSync(localEnvPath))
  : {};
for (const [key, value] of Object.entries(exampleEnvironment)) {
  if (shellEnvironment[key] === undefined) process.env[key] = value;
}
for (const [key, value] of Object.entries(localEnvironment)) {
  if (shellEnvironment[key] === undefined) process.env[key] = value;
}
const http = require("http");
const https = require("https");
const os = require("os");
const net = require("net");
const tls = require("tls");
const jwt = require(path.join(__dirname, "auth-service/node_modules/jsonwebtoken"));
const {
  createExperimentFiles,
  summarizeConcurrentBatch,
  summarizeScenario
} = require("./experiment-logging");
const { createLaunchBarrier, parseConcurrencyLevels } = require("./experiment-concurrency");

const ROOT = __dirname;
const orderServiceRequire = createRequire(path.join(ROOT, "order-service/package.json"));
const mysqlConfig = {
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  database: process.env.MYSQL_DATABASE || "mse",
  user: process.env.MYSQL_USER || "mse_runner",
  password: process.env.MYSQL_PASSWORD || "",
  connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
  connectTimeout: Number(process.env.MYSQL_CONNECT_TIMEOUT_MS || 5000)
};
const SCENARIOS = [
  { scenario_id: "S1", method: "in-memory", replica_count: 1 },
  { scenario_id: "S2", method: "redis", replica_count: 1 },
  { scenario_id: "S3", method: "redis-ttl", replica_count: 1 },
  { scenario_id: "S4", method: "mysql", replica_count: 1 },
  { scenario_id: "S5", method: "in-memory", replica_count: 2 },
  { scenario_id: "S6", method: "redis", replica_count: 2 },
  { scenario_id: "S7", method: "redis-ttl", replica_count: 2 },
  { scenario_id: "S8", method: "mysql", replica_count: 2 },
  { scenario_id: "S9", method: "in-memory", replica_count: 3 },
  { scenario_id: "S10", method: "redis", replica_count: 3 },
  { scenario_id: "S11", method: "redis-ttl", replica_count: 3 },
  { scenario_id: "S12", method: "mysql", replica_count: 3 }
];
const ORDERS_PATH = "/orders";
let activeProcesses = new Set();
let activeFiles;
let interrupted = false;
let totalRequestsLogged = 0;
const scenarioOutcomes = [];
const runtimeIssues = [];
const wallClockOffsetNs = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();

function parseInteger(value, name, minimum = 1, maximum = 10000) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function parseOptions(argv) {
  const values = {};
  const allowedOptions = new Set([
    "mode", "output", "repetitions", "requests", "replays", "concurrency", "redis-url"
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      values.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    const equalIndex = arg.indexOf("=");
    const name = arg.slice(2, equalIndex === -1 ? undefined : equalIndex);
    if (!allowedOptions.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = equalIndex === -1 ? argv[++index] : arg.slice(equalIndex + 1);
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    values[name] = value;
  }

  if (values.help) return { help: true };
  const mode = values.mode || process.env.EXPERIMENT_MODE_PRESET || "quick";
  if (!["quick", "full"].includes(mode)) throw new Error("--mode must be quick or full");
  const isFull = mode === "full";
  const concurrencyInput = values.concurrency || process.env.EXPERIMENT_CONCURRENCY;
  const concurrencyLevels = parseConcurrencyLevels(
    concurrencyInput,
    isFull ? [1, 5, 10, 25, 50] : [1, 5]
  );

  return {
    mode,
    repetitions: parseInteger(values.repetitions || process.env.EXPERIMENT_REPETITIONS || (isFull ? 3 : 1), "repetitions", 1, 100),
    requestCount: parseInteger(values.requests || process.env.EXPERIMENT_REQUESTS || (isFull ? 100 : 10), "requests", 1, 10000),
    replayCount: parseInteger(values.replays || process.env.EXPERIMENT_REPLAYS || (isFull ? 100 : 10), "replays", 1, 10000),
    concurrencyLevels,
    output: path.resolve(values.output || process.env.EXPERIMENT_OUTPUT_DIR || path.join(ROOT, "results")),
    redisUrl: values["redis-url"] || process.env.REDIS_URL || "redis://127.0.0.1:6379",
    tokenTtlSeconds: parseInteger(process.env.EXPERIMENT_TOKEN_TTL_SECONDS || 300, "token TTL", 30, 3600)
  };
}

function usage() {
  console.log([
    "Usage: node run-local-demo-2.js [options]",
    "",
    "Options:",
    "  --mode quick|full       Quick defaults or the full 3x100-request experiment",
    "  --output PATH           Results directory (default: ./results)",
    "  --repetitions N         Repetitions per scenario",
    "  --requests N            Legitimate and performance requests per level",
    "  --replays N             Serial replay attempts per scenario",
    "  --concurrency N,N,...   Performance/concurrent-replay levels",
    "  --redis-url URL         Redis URL (default: redis://127.0.0.1:6379)",
    "  --help                  Show this help"
  ].join("\n"));
}

function timestamp() {
  const epochNs = wallClockOffsetNs + process.hrtime.bigint();
  const epochMs = Number(epochNs / 1_000_000n);
  const fraction = String(epochNs % 1_000_000_000n).padStart(9, "0");
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, `.${fraction}Z`);
}

function hashJti(jti) {
  return crypto.createHash("sha256").update(jti).digest("hex");
}

function createOutputDirectory(basePath) {
  fs.mkdirSync(basePath, { recursive: true });
  const timestampPart = new Date().toISOString().replace(/[:.]/g, "-");
  const experimentId = `replay-${timestampPart}-${crypto.randomBytes(4).toString("hex")}`;
  const directory = path.join(basePath, experimentId);
  fs.mkdirSync(directory);
  return { directory, experimentId };
}

function safeGitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || null;
  } catch {
    return null;
  }
}

function sanitizedRedisUrl(redisUrl) {
  try {
    const url = new URL(redisUrl);
    if (url.username) url.username = "redacted";
    if (url.password) url.password = "redacted";
    for (const key of url.searchParams.keys()) {
      if (/pass(word)?|token|secret|auth/i.test(key)) url.searchParams.set(key, "redacted");
    }
    return url.toString();
  } catch {
    return "[configured URL omitted]";
  }
}

function writeMetadata(metadata, outputDir) {
  fs.writeFileSync(path.join(outputDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
}

function appendEvent(event, details = {}) {
  activeFiles.event({ event, ...details });
}

function collectDependencies() {
  const dependencies = [
    ["auth-service express", path.join(ROOT, "auth-service/node_modules/express")],
    ["auth-service jsonwebtoken", path.join(ROOT, "auth-service/node_modules/jsonwebtoken")],
    ["gateway express", path.join(ROOT, "gateway/node_modules/express")],
    ["gateway http-proxy-middleware", path.join(ROOT, "gateway/node_modules/http-proxy-middleware")],
    ["order-service express", path.join(ROOT, "order-service/node_modules/express")],
    ["order-service redis client", path.join(ROOT, "order-service/node_modules/redis")],
    ["order-service mysql2 client", path.join(ROOT, "order-service/node_modules/mysql2")]
  ];
  return dependencies.filter(([, dependencyPath]) => !fs.existsSync(dependencyPath)).map(([name]) => name);
}

function validateCertificates(certDir) {
  const files = ["ca.pem", "client.pem", "client.key", "order.pem", "order.key"];
  const missing = files.filter((file) => !fs.existsSync(path.join(certDir, file)));
  if (missing.length) return { error: `Missing mTLS certificate files: ${missing.join(", ")}` };

  try {
    const ca = fs.readFileSync(path.join(certDir, "ca.pem"));
    for (const [certName, keyName] of [["client.pem", "client.key"], ["order.pem", "order.key"]]) {
      tls.createSecureContext({
        ca,
        cert: fs.readFileSync(path.join(certDir, certName)),
        key: fs.readFileSync(path.join(certDir, keyName))
      });
    }
    return { ca };
  } catch {
    return { error: "mTLS certificate/key pairs are invalid or do not match; regenerate them with npm run certs" };
  }
}

function safeDiagnostic(error, secrets = []) {
  let message = error && error.message ? error.message : String(error || "Unknown error");
  for (const secret of secrets.filter(Boolean)) {
    message = message.split(secret).join("[redacted]");
  }
  return message;
}

async function checkRedis(redisUrl) {
  let client;
  let parsedUrl;
  const status = {
    available: false,
    host: null,
    port: null,
    version: null,
    ping: false,
    atomic_set_nx: false,
    set_nx_without_ttl: false,
    set_nx_with_ttl: false,
    error: null
  };
  try {
    parsedUrl = new URL(redisUrl);
    status.host = parsedUrl.hostname;
    status.port = Number(parsedUrl.port || 6379);
    const { createClient } = orderServiceRequire("redis");
    client = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 3000,
        reconnectStrategy: () => false
      }
    });
    client.on("error", () => {});
    await client.connect();
    status.ping = (await client.ping()) === "PONG";
    if (!status.ping) throw new Error("Redis PING did not return PONG");
    const key = `mse:preflight:${crypto.randomUUID()}`;
    const ttlKey = `${key}:ttl`;
    const [persistentInsert, ttlInsert] = await Promise.all([
      client.set(key, "probe", { NX: true }),
      client.set(ttlKey, "probe", { NX: true, PX: 10000 })
    ]);
    const [persistentValue, ttlValue, ttlMs] = await Promise.all([
      client.get(key),
      client.get(ttlKey),
      client.pTTL(ttlKey)
    ]);
    if (persistentInsert !== "OK" || persistentValue !== "probe") {
      throw new Error("Redis persistent SET NX/GET replay-store probe failed");
    }
    if (ttlInsert !== "OK" || ttlValue !== "probe" || ttlMs <= 0) {
      throw new Error("Redis TTL SET NX PX/GET/PTTL replay-store probe failed");
    }
    status.atomic_set_nx = true;
    status.set_nx_without_ttl = true;
    status.set_nx_with_ttl = true;
    await client.del([key, ttlKey]);
    const version = await client.info("server");
    const match = version.match(/^redis_version:([^\r\n]+)/m);
    status.version = match ? match[1] : null;
    status.available = true;
  } catch (error) {
    status.error = safeDiagnostic(error, [parsedUrl && parsedUrl.password]);
  } finally {
    if (client && client.isOpen) {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }
  }
  return status;
}

async function checkMySQL(config) {
  const status = {
    available: false,
    host: config.host,
    port: Number(config.port),
    database: config.database,
    user: config.user,
    password_configured: Boolean(config.password),
    version: null,
    database_exists: false,
    table_engine: null,
    jti_hash_primary_key: false,
    create_table: false,
    insert_select: false,
    privileges: { create: false, insert: false, select: false },
    error: null
  };
  let connection;
  try {
    const mysql = orderServiceRequire("mysql2/promise");
    connection = await mysql.createConnection(config);
    const [versionRows] = await connection.query("SELECT VERSION() AS version, DATABASE() AS database_name");
    status.version = versionRows[0].version;
    status.database_exists = versionRows[0].database_name === config.database;
    const majorVersion = Number(status.version.match(/^(\d+)\./)?.[1]);
    if (!Number.isInteger(majorVersion) || majorVersion < 8 || majorVersion >= 10) {
      throw new Error(`MySQL 8.x or 9.x is required (reported ${status.version})`);
    }
    if (!status.database_exists) throw new Error(`Connected database does not match ${config.database}`);
    const [grants] = await connection.query("SHOW GRANTS");
    const grantStatements = grants.map((row) => String(Object.values(row)[0]));
    const grantCovers = (privilege) => grantStatements.some((statement) => {
      const match = statement.match(/^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i);
      if (!match) return false;
      const scope = match[2].replace(/`/g, "").toLowerCase();
      if (scope !== "*.*" && scope !== `${config.database.toLowerCase()}.*`) return false;
      const granted = match[1].toUpperCase().split(/\s*,\s*/);
      return granted.includes("ALL PRIVILEGES") || granted.includes(privilege);
    });
    status.privileges = {
      create: grantCovers("CREATE"),
      insert: grantCovers("INSERT"),
      select: grantCovers("SELECT")
    };
    if (!status.privileges.create || !status.privileges.insert || !status.privileges.select) {
      throw new Error("Database account must have CREATE, INSERT, and SELECT privileges on the experiment database");
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS consumed_tokens (
        jti_hash CHAR(64) NOT NULL PRIMARY KEY,
        expires_at BIGINT NOT NULL,
        consumed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);
    status.create_table = true;
    const [tables] = await connection.query(
      "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
      ["consumed_tokens"]
    );
    const [table] = tables;
    status.table_engine = table ? table.ENGINE : null;
    if (status.table_engine !== "InnoDB") {
      throw new Error(`consumed_tokens must use InnoDB (found ${status.table_engine || "missing"})`);
    }
    const [primaryKeys] = await connection.query(
      "SELECT COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'jti_hash'",
      ["consumed_tokens"]
    );
    const [primaryKey] = primaryKeys;
    status.jti_hash_primary_key = Boolean(primaryKey && primaryKey.COLUMN_KEY === "PRI");
    if (!status.jti_hash_primary_key) throw new Error("consumed_tokens.jti_hash must be the primary key");

    await connection.beginTransaction();
    try {
      const probeHash = crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex");
      await connection.query(
        "INSERT INTO consumed_tokens (jti_hash, expires_at) VALUES (?, ?)",
        [probeHash, Math.floor(Date.now() / 1000) + 60]
      );
      const [rows] = await connection.query(
        "SELECT jti_hash FROM consumed_tokens WHERE jti_hash = ?",
        [probeHash]
      );
      if (rows.length !== 1 || rows[0].jti_hash !== probeHash) {
        throw new Error("MySQL INSERT/SELECT replay-store probe returned unexpected data");
      }
      await connection.rollback();
      status.insert_select = true;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    status.available = true;
  } catch (error) {
    status.error = safeDiagnostic(error, [config.password]);
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch (error) {
        status.available = false;
        status.error = `MySQL connection cleanup failed: ${safeDiagnostic(error, [config.password])}`;
      }
    }
  }
  return status;
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function spawnService(name, cwd, script, env) {
  const child = spawn(process.execPath, [script], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.experimentName = name;
  child.stderrTail = "";
  child.stdoutBuffer = "";
  const captureStderr = (chunk) => {
    child.stderrTail = `${child.stderrTail}${chunk.toString("utf8")}`.slice(-4000);
  };
  child.stderr.on("data", captureStderr);
  child.stdout.on("data", (chunk) => {
    child.stdoutBuffer += chunk.toString("utf8");
    const lines = child.stdoutBuffer.split("\n");
    child.stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("EXPERIMENT_EVENT ")) continue;
      try {
        const event = JSON.parse(line.slice("EXPERIMENT_EVENT ".length));
        if (event.event === "protected_operation_executed") {
          appendEvent(event.event, { ...event, service: name });
        }
      } catch (error) {
        appendEvent("experiment_event_parse_error", {
          service: name,
          message: safeDiagnostic(error)
        });
      }
    }
  });
  child.once("exit", (code, signal) => {
    activeProcesses.delete(child);
    appendEvent("service_process_exit", { service: name, exit_code: code, signal });
  });
  activeProcesses.add(child);
  return child;
}

async function stopService(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    activeProcesses.delete(child);
    return;
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
  activeProcesses.delete(child);
}

async function cleanup() {
  await Promise.all([...activeProcesses].map(stopService));
}

function request(options, body, launch = {}) {
  return new Promise((resolve, reject) => {
    const transport = options.protocol === "https:" ? https : http;
    const request = transport.request(options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.setTimeout(5000, () => request.destroy(new Error("request_timeout")));
    request.once("error", reject);
    const send = async () => {
      if (launch.barrier) await launch.barrier.wait();
      if (launch.onLaunch) {
        launch.onLaunch({ timestamp: timestamp(), monotonicNs: process.hrtime.bigint().toString() });
      }
      if (body !== undefined) request.write(body);
      request.end();
    };
    send().catch((error) => request.destroy(error));
  });
}

async function waitReady(url, options = {}, child) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      const exit = child.signalCode
        ? `signal ${child.signalCode}`
        : `exit code ${child.exitCode}`;
      const detail = child.stderrTail.trim();
      throw new Error(
        `${child.experimentName} stopped with ${exit} before health check` +
        (detail ? `: ${detail}` : "")
      );
    }
    try {
      const parsed = new URL(url);
      const response = await request({
        ...options,
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "GET"
      });
      if (response.status === 200) return response;
    } catch {
      // The service may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Health check failed for ${new URL(url).pathname}`);
}

function scenarioPrefix(experimentId, scenario, repetition) {
  return `mse:${experimentId}:${scenario.scenario_id}:r${repetition}`;
}

async function requestTokens(authPort, experimentKey, count, purpose = "unspecified") {
  if (!count) return [];
  const response = await request({
    hostname: "127.0.0.1",
    port: authPort,
    path: "/experiment/tokens",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-experiment-key": experimentKey
    }
  }, JSON.stringify({ count }));
  if (response.status !== 200) {
    throw new Error(`Auth Service token provisioning failed with HTTP ${response.status}`);
  }
  const result = JSON.parse(response.body);
  if (!Array.isArray(result.tokens) || result.tokens.length !== count) {
    throw new Error("Auth Service returned an incomplete token batch");
  }
  const tokens = result.tokens.map((token) => {
    const decoded = jwt.decode(token);
    if (!decoded || !decoded.jti || !decoded.exp) throw new Error("Auth Service issued a token without jti or exp");
    return { token, jti: decoded.jti, exp: decoded.exp, jtiHash: hashJti(decoded.jti) };
  });
  appendEvent("token_issued", {
    token_count: tokens.length,
    purpose,
    token_lifetime_seconds: Math.max(0, Math.min(...tokens.map((token) => token.exp)) - Math.floor(Date.now() / 1000))
  });
  return tokens;
}

function targetReplica(index, replicaCount) {
  return `order-${(index % replicaCount) + 1}`;
}

function outcomeFrom(response) {
  if (response.status === 200) return "accepted";
  if (response.status === 403 && response.headers["x-experiment-store-result"] === "replay_detected") {
    return "replay_detected";
  }
  if (response.status === 503 || response.headers["x-experiment-store-result"] === "store_error") {
    return "store_error";
  }
  return "service_error";
}

async function measuredRequest(context) {
  if (Date.now() >= context.token.exp * 1000) {
    throw new Error(`Token expired before ${context.phase} request could be measured`);
  }
  const requestId = crypto.randomUUID();
  let clientLaunchTimestamp = null;
  let clientLaunchMonotonicNs = null;
  let response;
  let requestError;
  try {
    response = await request({
      hostname: "127.0.0.1",
      port: context.gatewayPort,
      path: ORDERS_PATH,
      method: "GET",
      headers: {
        authorization: `Bearer ${context.token.token}`,
        "x-experiment-replica": context.replicaId,
        "x-request-id": requestId,
        ...(context.concurrentBatchId ? {
          "x-concurrent-batch-id": context.concurrentBatchId,
          "x-experiment-jti-hash": context.token.jtiHash,
          "x-experiment-concurrency-level": String(context.concurrencyLevel),
          "x-experiment-scenario-id": context.scenario.scenario_id,
          "x-experiment-method": context.scenario.method,
          "x-experiment-replica-count": String(context.scenario.replica_count),
          "x-experiment-repetition": String(context.repetition)
        } : {})
      }
    }, undefined, {
      barrier: context.launchBarrier,
      onLaunch: ({ timestamp: launchedAt, monotonicNs }) => {
        clientLaunchTimestamp = launchedAt;
        clientLaunchMonotonicNs = monotonicNs;
      }
    });
  } catch (error) {
    requestError = error;
  }
  const endNanos = process.hrtime.bigint();
  const endTimestamp = timestamp();
  const latencyMs = clientLaunchMonotonicNs === null
    ? null
    : Number(endNanos - BigInt(clientLaunchMonotonicNs)) / 1e6;
  const actualOutcome = requestError ? "request_error" : outcomeFrom(response);
  const header = (name) => response && response.headers[name];
  const actualReplicaId = header("x-experiment-replica") || null;
  const protectedOperationHeader = header("x-experiment-protected-operation-executed");
  const row = {
    experiment_id: context.experimentId,
    scenario_id: context.scenario.scenario_id,
    repetition: context.repetition,
    method: context.scenario.method,
    replay_store: context.scenario.method,
    replica_count: context.scenario.replica_count,
    phase: context.phase,
    request_type: context.phase,
    request_id: requestId,
    jti_hash: context.token.jtiHash,
    requested_replica_id: context.replicaId,
    replica_id: actualReplicaId,
    routing_correct: actualReplicaId ? actualReplicaId === context.replicaId : null,
    sequence_number: context.sequenceNumber,
    concurrency_level: context.concurrencyLevel || 1,
    concurrent_batch_id: context.concurrentBatchId || "",
    timestamp: clientLaunchTimestamp || endTimestamp,
    client_launch_timestamp: clientLaunchTimestamp,
    client_launch_monotonic_ns: clientLaunchMonotonicNs,
    gateway_arrival_timestamp: header("x-experiment-gateway-arrival-timestamp") || "",
    gateway_arrival_monotonic_ns: header("x-experiment-gateway-arrival-monotonic-ns") || "",
    order_service_arrival_timestamp: header("x-experiment-order-service-arrival-timestamp") || "",
    order_service_arrival_monotonic_ns: header("x-experiment-order-service-arrival-monotonic-ns") || "",
    replay_store_start_timestamp: header("x-experiment-replay-store-start-timestamp") || "",
    replay_store_start_monotonic_ns: header("x-experiment-replay-store-start-monotonic-ns") || "",
    replay_store_end_timestamp: header("x-experiment-replay-store-end-timestamp") || "",
    replay_store_end_monotonic_ns: header("x-experiment-replay-store-end-monotonic-ns") || "",
    request_start_timestamp: clientLaunchTimestamp || endTimestamp,
    request_end_timestamp: endTimestamp,
    latency_ms: latencyMs,
    http_status: response ? response.status : "",
    status: response ? response.status : "",
    expected_outcome: context.expectedOutcome,
    actual_outcome: actualOutcome,
    outcome_correct: actualOutcome === context.expectedOutcome,
    replay_detected: actualOutcome === "replay_detected",
    legitimate_request: context.legitimateRequest === true,
    store_operation: "consume_jti",
    store_latency_ms: header("x-experiment-store-latency-ms") || "",
    store_ttl_ms: header("x-experiment-store-ttl-ms") || "",
    replay_context: context.replayContext || "",
    protected_operation_executed: protectedOperationHeader === "true"
      ? true
      : protectedOperationHeader === "false"
        ? false
        : null,
    error_category: requestError
      ? "request_error"
      : actualOutcome === "store_error"
        ? "store_error"
        : actualOutcome === "service_error"
          ? "service_error"
          : "",
    error_message: requestError
      ? (requestError.code || "HTTP request failed")
      : actualOutcome === "store_error"
        ? "Replay store unavailable"
        : actualOutcome === "service_error"
          ? `Unexpected HTTP ${response.status}`
          : ""
  };
  return row;
}

function persistRequest(row) {
  totalRequestsLogged += 1;
  activeFiles.request(row);
  appendEvent("request_completed", {
    scenario_id: row.scenario_id,
    phase: row.phase,
    request_id: row.request_id,
    concurrent_batch_id: row.concurrent_batch_id,
    jti_hash: row.jti_hash,
    requested_replica_id: row.requested_replica_id,
    replica_id: row.replica_id,
    http_status: row.http_status || null,
    actual_outcome: row.actual_outcome,
    latency_ms: row.latency_ms,
    client_launch_timestamp: row.client_launch_timestamp,
    client_launch_monotonic_ns: row.client_launch_monotonic_ns,
    gateway_arrival_timestamp: row.gateway_arrival_timestamp,
    gateway_arrival_monotonic_ns: row.gateway_arrival_monotonic_ns,
    order_service_arrival_timestamp: row.order_service_arrival_timestamp,
    order_service_arrival_monotonic_ns: row.order_service_arrival_monotonic_ns,
    protected_operation_executed: row.protected_operation_executed
  });
}

function plannedRequestCount(scenario, config) {
  return config.requestCount + config.replayCount +
    (scenario.replica_count > 1 ? 2 : 0) +
    config.concurrencyLevels.reduce((sum, level) => sum + level, 0) +
    config.requestCount * config.concurrencyLevels.length + 4;
}

function replayAttemptCount(requests) {
  const replayRows = requests.filter((row) => row.phase === "replay").length;
  const concurrentGroups = new Map();
  for (const row of requests.filter((request) => request.phase === "concurrent_replay")) {
    const key = row.jti_hash;
    concurrentGroups.set(key, (concurrentGroups.get(key) || 0) + 1);
  }
  return replayRows + [...concurrentGroups.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

async function runScenario({ experimentId, scenario, repetition, config, authPort, experimentKey, certDir }) {
  const scenarioStart = timestamp();
  appendEvent("scenario_started", {
    scenario_id: scenario.scenario_id,
    repetition,
    method: scenario.method,
    replica_count: scenario.replica_count
  });
  const requests = [];
  const prefix = scenarioPrefix(experimentId, scenario, repetition);
  let gatewayProcess;
  const orderProcesses = new Map();
  let gatewayPort;
  const scenarioErrors = [];
  let restartStateRetained = null;

  async function startOrder(replicaId, port) {
    const child = spawnService(
      `${scenario.scenario_id}-${replicaId}`,
      path.join(ROOT, "order-service"),
      "server-secure.js",
      {
        EXPERIMENT_MODE: "true",
        REPLAY_METHOD: scenario.method,
        REPLAY_KEY_PREFIX: prefix,
        REDIS_URL: config.redisUrl,
        JWT_SECRET: process.env.__MSE_EXPERIMENT_JWT_SECRET,
        CERTS_DIR: certDir,
        PORT: String(port),
        REPLICA_ID: replicaId
      }
    );
    child.experimentPort = port;
    orderProcesses.set(replicaId, child);
    const health = await waitReady(`https://127.0.0.1:${port}/health`, {
      ca: fs.readFileSync(path.join(certDir, "ca.pem")),
      cert: fs.readFileSync(path.join(certDir, "client.pem")),
      key: fs.readFileSync(path.join(certDir, "client.key")),
      servername: "order-service",
      rejectUnauthorized: true
    }, child);
    if (JSON.parse(health.body).replica_id !== replicaId) {
      throw new Error(`Order Service ${replicaId} health identity mismatch`);
    }
    appendEvent("service_started", {
      service: "order-service",
      replica_id: replicaId,
      scenario_id: scenario.scenario_id,
      port,
      replay_method: scenario.method
    });
  }

  async function startGateway(targets) {
    gatewayPort = await allocatePort();
    gatewayProcess = spawnService("experiment-gateway", path.join(ROOT, "gateway"), "server.js", {
      EXPERIMENT_MODE: "true",
      JWT_SECRET: process.env.__MSE_EXPERIMENT_JWT_SECRET,
      CERTS_DIR: certDir,
      PORT: String(gatewayPort),
      ORDER_SERVICE_TARGETS: JSON.stringify(targets)
    });
    await waitReady(`http://127.0.0.1:${gatewayPort}/health`, {}, gatewayProcess);
    appendEvent("service_started", {
      service: "gateway",
      scenario_id: scenario.scenario_id,
      port: gatewayPort,
      replica_targets: targets
    });
  }

  function record(row) {
    requests.push(row);
    persistRequest(row);
    if (row.error_category) scenarioErrors.push(row.error_category);
      if (row.routing_correct === false) scenarioErrors.push("replica_routing_mismatch");
      return row;
    }

  try {
    for (let index = 0; index < scenario.replica_count; index += 1) {
      await startOrder(`order-${index + 1}`, await allocatePort());
    }
    const targets = Object.fromEntries([...orderProcesses.entries()].map(([replicaId, process]) =>
      [replicaId, `https://127.0.0.1:${process.experimentPort}`]
    ));
    await startGateway(targets);

    const warmupToken = (await requestTokens(authPort, experimentKey, 1, "warmup"))[0];
    const warmup = await measuredRequest({
      experimentId, scenario, repetition, gatewayPort, token: warmupToken,
      replicaId: "order-1", phase: "warmup", expectedOutcome: "accepted",
      sequenceNumber: 0, legitimateRequest: true
    });
    record(warmup);
    if (warmup.actual_outcome !== "accepted") {
      throw new Error(`Warm-up request failed with HTTP ${warmup.http_status || "no response"}`);
    }
    appendEvent("warmup_completed", { scenario_id: scenario.scenario_id, repetition });

    const legitimateTokens = await requestTokens(authPort, experimentKey, config.requestCount, "first_use");
    const routes = legitimateTokens.map((_, index) => targetReplica(index, scenario.replica_count));
    for (let index = 0; index < legitimateTokens.length; index += 1) {
      const row = await measuredRequest({
        experimentId, scenario, repetition, gatewayPort, token: legitimateTokens[index],
        replicaId: routes[index], phase: "first_use", expectedOutcome: "accepted",
        sequenceNumber: index + 1, legitimateRequest: true
      });
      record(row);
    }

    for (let index = 0; index < config.replayCount; index += 1) {
      record(await measuredRequest({
        experimentId, scenario, repetition, gatewayPort,
        token: legitimateTokens[index % legitimateTokens.length],
        replicaId: routes[index % routes.length], phase: "replay", expectedOutcome: "replay_detected",
        replayContext: "same_replica", sequenceNumber: index + 1, legitimateRequest: false
      }));
    }

    if (scenario.replica_count > 1) {
      const replayReplicaId = targetReplica(1, scenario.replica_count);
      const crossToken = (await requestTokens(authPort, experimentKey, 1, "cross_replica"))[0];
      record(await measuredRequest({
        experimentId, scenario, repetition, gatewayPort, token: crossToken,
        replicaId: "order-1", phase: "first_use", expectedOutcome: "accepted",
        sequenceNumber: config.requestCount + 1, legitimateRequest: true
      }));
      record(await measuredRequest({
        experimentId, scenario, repetition, gatewayPort, token: crossToken,
        replicaId: replayReplicaId,
        phase: "replay",
        expectedOutcome: scenario.method === "in-memory" ? "accepted" : "replay_detected",
        replayContext: "cross_replica", sequenceNumber: config.requestCount + 1, legitimateRequest: false
      }));
    }

    let sequenceNumber = 0;
    for (const concurrencyLevel of config.concurrencyLevels) {
      const concurrentToken = (await requestTokens(authPort, experimentKey, 1, "concurrent_replay"))[0];
      const concurrentBatchId = crypto.randomUUID();
      const launchBarrier = createLaunchBarrier(concurrencyLevel);
      const concurrentRequests = Array.from({ length: concurrencyLevel }, (_, index) =>
        measuredRequest({
          experimentId, scenario, repetition, gatewayPort, token: concurrentToken,
          replicaId: targetReplica(index, scenario.replica_count),
          phase: "concurrent_replay",
          expectedOutcome: "accepted_or_replay_detected",
          sequenceNumber: index + 1,
          concurrencyLevel,
          concurrentBatchId,
          launchBarrier,
          legitimateRequest: false
        })
      );
      const concurrentRows = await Promise.all(concurrentRequests);
      const acceptedByReplica = new Map();
      for (const row of concurrentRows.filter((item) => item.actual_outcome === "accepted")) {
        acceptedByReplica.set(row.replica_id, (acceptedByReplica.get(row.replica_id) || 0) + 1);
      }
      const observedReplicas = [...new Set(concurrentRows.map((row) => row.replica_id).filter(Boolean))].sort();
      const expectedObservedReplicas = [...new Set(concurrentRows.map((row) => row.requested_replica_id))].sort();
      const responsesValid = concurrentRows.every((row) =>
        ["accepted", "replay_detected"].includes(row.actual_outcome)
      );
      const distributionValid = concurrentRows.every((row) => row.routing_correct === true) &&
        expectedObservedReplicas.every((replicaId) => observedReplicas.includes(replicaId)) &&
        (concurrencyLevel < scenario.replica_count ||
          expectedObservedReplicas.every((replicaId) => observedReplicas.includes(replicaId)));
      const localStateValid = [...acceptedByReplica.values()].every((count) => count <= 1) &&
        expectedObservedReplicas.every((replicaId) => acceptedByReplica.get(replicaId) === 1);
      const batchMetrics = summarizeConcurrentBatch(
        concurrentRows,
        scenario.method,
        scenario.replica_count
      );
      concurrentRows.forEach((row) => {
        row.outcome_correct = responsesValid;
        record(row);
      });
      if (!distributionValid) scenarioErrors.push("concurrent_replica_distribution_mismatch");
      if (!responsesValid) scenarioErrors.push("concurrent_request_execution_incomplete");
      appendEvent("concurrent_replay_distribution", {
        scenario_id: scenario.scenario_id,
        repetition,
        concurrent_batch_id: concurrentBatchId,
        jti_hash: concurrentToken.jtiHash,
        concurrency_level: concurrencyLevel,
        ...batchMetrics,
        expected_replicas: expectedObservedReplicas,
        observed_replicas: observedReplicas,
        replica_routing_valid: distributionValid,
        local_process_atomicity_compliant: scenario.method === "in-memory"
          ? localStateValid
          : null,
        shared_store_single_acceptance: scenario.method === "in-memory"
          ? null
          : batchMetrics.accepted_request_count === 1,
        global_security_violation: !batchMetrics.global_one_time_use_compliant,
        execution_available: batchMetrics.execution_available
      });

      for (let offset = 0; offset < config.requestCount; offset += concurrencyLevel) {
        const batchSize = Math.min(concurrencyLevel, config.requestCount - offset);
        const tokens = await requestTokens(authPort, experimentKey, batchSize, "performance");
        const batch = await Promise.all(tokens.map((token, index) => measuredRequest({
          experimentId, scenario, repetition, gatewayPort, token,
          replicaId: targetReplica(offset + index, scenario.replica_count),
          phase: "performance",
          expectedOutcome: "accepted",
          sequenceNumber: ++sequenceNumber,
          concurrencyLevel,
          legitimateRequest: true
        })));
        batch.forEach((row) => {
          row.outcome_correct = row.actual_outcome === "accepted";
          record(row);
        });
      }
    }

    const restartToken = (await requestTokens(authPort, experimentKey, 1, "restart_state"))[0];
    record(await measuredRequest({
      experimentId, scenario, repetition, gatewayPort, token: restartToken,
      replicaId: "order-1", phase: "first_use", expectedOutcome: "accepted",
      sequenceNumber: config.requestCount + 2, legitimateRequest: true
    }));
    record(await measuredRequest({
      experimentId, scenario, repetition, gatewayPort, token: restartToken,
      replicaId: "order-1", phase: "replay", expectedOutcome: "replay_detected",
      replayContext: "before_restart", sequenceNumber: config.requestCount + 2,
      legitimateRequest: false
    }));

    const oldProcess = orderProcesses.get("order-1");
    await stopService(oldProcess);
    const restartedPort = orderProcesses.get("order-1").experimentPort;
    await startOrder("order-1", restartedPort);
    appendEvent("service_restarted", {
      service: "order-service",
      replica_id: "order-1",
      scenario_id: scenario.scenario_id,
      jti_hash: restartToken.jtiHash,
      token_expiry: new Date(restartToken.exp * 1000).toISOString()
    });
    if (Date.now() >= restartToken.exp * 1000) {
      throw new Error("Restart token expired before persistence could be evaluated");
    }
    const afterRestart = record(await measuredRequest({
      experimentId, scenario, repetition, gatewayPort, token: restartToken,
      replicaId: "order-1", phase: "replay",
      expectedOutcome: scenario.method === "in-memory" ? "accepted" : "replay_detected",
      replayContext: "after_restart", sequenceNumber: config.requestCount + 2,
      legitimateRequest: false
    }));
    restartStateRetained = afterRestart.actual_outcome === "replay_detected";

    const completed = requests.length;
    const accepted = requests.filter((row) => row.actual_outcome === "accepted").length;
    const replayRows = requests.filter((row) =>
      row.phase === "replay" || row.phase === "concurrent_replay"
    );
    const summary = summarizeScenario({
      experimentId,
      scenario: { ...scenario, repetition },
      requests,
      restartStateRetained
    });
    const scenarioRow = {
      experiment_id: experimentId,
      scenario_id: scenario.scenario_id,
      method: scenario.method,
      replica_count: scenario.replica_count,
      repetition,
      planned_requests: plannedRequestCount(scenario, config),
      completed_requests: completed,
      accepted_requests: accepted,
      rejected_requests: completed - accepted,
      replay_attempts: replayAttemptCount(requests),
      replay_blocked: requests.filter((row) =>
        row.replay_detected &&
        (row.phase !== "concurrent_replay" || !row.legitimate_request)
      ).length,
      legitimate_requests: requests.filter((row) => row.legitimate_request).length,
      legitimate_accepted: requests.filter((row) =>
        row.legitimate_request && row.actual_outcome === "accepted"
      ).length,
      protected_operation_execution_count: requests.filter(
        (row) => row.protected_operation_executed === true
      ).length,
      concurrent_batch_count: summary.concurrent_batch_count,
      global_invariant_violations: summary.global_invariant_violations,
      global_excess_acceptances: summary.global_excess_acceptances,
      global_excess_executions: summary.global_excess_executions,
      global_one_time_use_compliant_batch_count: Math.round(
        (summary.global_one_time_use_compliance_rate || 0) * summary.concurrent_batch_count
      ),
      execution_available_batch_count: Math.round(
        (summary.global_execution_availability_rate || 0) * summary.concurrent_batch_count
      ),
      local_process_atomicity_violations: scenario.method === "in-memory"
        ? summary.concurrent_batch_count - Math.round(
          (summary.local_process_atomicity_compliance_rate || 0) * summary.concurrent_batch_count
        )
        : null,
      concurrent_arrival_spread_mean_ms: summary.concurrent_arrival_spread_mean_ms,
      planned_request_count_by_replica: summary.planned_request_count_by_replica,
      received_request_count_by_replica: summary.received_request_count_by_replica,
      accepted_count_by_replica: summary.accepted_count_by_replica,
      replay_rejected_count_by_replica: summary.replay_rejected_count_by_replica,
      protected_operation_count_by_replica: summary.protected_operation_count_by_replica,
      error_count: scenarioErrors.length,
      status: scenarioErrors.length || completed !== plannedRequestCount(scenario, config)
        ? "partial"
        : "completed",
      reason: scenarioErrors.length ? [...new Set(scenarioErrors)].join("; ") : "",
      start_time: scenarioStart,
      end_time: timestamp()
    };
    activeFiles.scenario(scenarioRow);
    scenarioOutcomes.push(scenarioRow);
    if (scenarioErrors.length) {
      runtimeIssues.push({
        scenario_id: scenario.scenario_id,
        repetition,
        category: "measured_request_errors",
        message: [...new Set(scenarioErrors)].join("; ")
      });
    }
    activeFiles.summary(summary);
    appendEvent("scenario_completed", {
      scenario_id: scenario.scenario_id,
      repetition,
      status: scenarioRow.status,
      completed_requests: completed,
      restart_state_retained: restartStateRetained
    });
  } catch (error) {
    runtimeIssues.push({
      scenario_id: scenario.scenario_id,
      repetition,
      category: "scenario_error",
      message: error.message
    });
    appendEvent("error", {
      scenario_id: scenario.scenario_id,
      repetition,
      category: "scenario_error",
      message: error.message
    });
    const endTime = timestamp();
    const failedScenario = {
      experiment_id: experimentId,
      scenario_id: scenario.scenario_id,
      method: scenario.method,
      replica_count: scenario.replica_count,
      repetition,
      planned_requests: plannedRequestCount(scenario, config),
      completed_requests: requests.length,
      accepted_requests: requests.filter((row) => row.actual_outcome === "accepted").length,
      rejected_requests: requests.filter((row) => row.actual_outcome !== "accepted").length,
      replay_attempts: replayAttemptCount(requests),
      replay_blocked: requests.filter((row) =>
        row.replay_detected &&
        (row.phase !== "concurrent_replay" || !row.legitimate_request)
      ).length,
      legitimate_requests: requests.filter((row) => row.legitimate_request).length,
      legitimate_accepted: requests.filter((row) => row.legitimate_request && row.actual_outcome === "accepted").length,
      protected_operation_execution_count: requests.filter(
        (row) => row.protected_operation_executed === true
      ).length,
      error_count: scenarioErrors.length + 1,
      status: "failed",
      reason: error.message,
      start_time: scenarioStart,
      end_time: endTime
    };
    activeFiles.scenario(failedScenario);
    scenarioOutcomes.push(failedScenario);
    activeFiles.summary(summarizeScenario({
      experimentId,
      scenario: { ...scenario, repetition },
      requests,
      restartStateRetained
    }));
    appendEvent("scenario_completed", {
      scenario_id: scenario.scenario_id,
      repetition,
      status: "failed",
      reason: error.message
    });
  } finally {
    await stopService(gatewayProcess);
    await Promise.all([...orderProcesses.values()].map(stopService));
  }
}

async function main() {
  const config = parseOptions(process.argv.slice(2));
  if (config.help) {
    usage();
    return;
  }
  const { directory: outputDir, experimentId } = createOutputDirectory(config.output);
  activeFiles = createExperimentFiles(outputDir);
  const startTime = timestamp();
  const errors = [];
  const certDir = path.resolve(process.env.CERTS_DIR || path.join(ROOT, "certs"));
  const certificateStatus = validateCertificates(certDir);
  const missingDependencies = collectDependencies();
  let redisStatus = {
    available: false,
    host: null,
    port: null,
    version: null,
    ping: false,
    atomic_set_nx: false,
    set_nx_without_ttl: false,
    set_nx_with_ttl: false,
    error: "Redis client dependency is missing"
  };
  let mysqlStatus = {
    available: false,
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    database: mysqlConfig.database,
    user: mysqlConfig.user,
    password_configured: Boolean(mysqlConfig.password),
    version: null,
    database_exists: false,
    table_engine: null,
    jti_hash_primary_key: false,
    create_table: false,
    insert_select: false,
    privileges: { create: false, insert: false, select: false },
    error: "MySQL client dependency is missing"
  };
  if (!missingDependencies.includes("order-service redis client")) {
    redisStatus = await checkRedis(config.redisUrl);
  }
  if (!missingDependencies.includes("order-service mysql2 client")) {
    mysqlStatus = await checkMySQL(mysqlConfig);
  }
  if (missingDependencies.length) errors.push(`Missing dependencies: ${missingDependencies.join(", ")}`);
  if (certificateStatus.error) errors.push(certificateStatus.error);
  if (!redisStatus.available) errors.push(`Redis preflight failed: ${redisStatus.error}`);
  if (!mysqlStatus.available) errors.push(`MySQL preflight failed: ${mysqlStatus.error}`);

  const experimentSecret = crypto.randomBytes(32).toString("hex");
  const experimentKey = crypto.randomBytes(32).toString("hex");
  process.env.__MSE_EXPERIMENT_JWT_SECRET = experimentSecret;
  const metadata = {
    metadata_schema_version: 3,
    experiment_id: experimentId,
    start_time: startTime,
    end_time: null,
    repository_commit: safeGitSha(),
    node_version: process.version,
    operating_system: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: os.cpus().map(({ model, speed }) => ({ model, speed_mhz: speed })),
    total_memory_bytes: os.totalmem(),
    redis_version: redisStatus.version,
    redis_available: redisStatus.available,
    redis_preflight: redisStatus,
    mysql_version: mysqlStatus.version,
    mysql_available: mysqlStatus.available,
    mysql_preflight: mysqlStatus,
    configuration: {
      mode: config.mode,
      execution_environment: "native-host-child-processes",
      repetitions: config.repetitions,
      legitimate_requests_per_repetition: config.requestCount,
      replay_attempts_per_repetition: config.replayCount,
      concurrency_levels: config.concurrencyLevels,
      concurrency_distribution: "deterministic round-robin starting at order-1 for each batch",
      token_lifetime_seconds: config.tokenTtlSeconds,
      redis_url: sanitizedRedisUrl(config.redisUrl),
      database_client: "mysql2/promise",
      environment_files: [
        path.relative(ROOT, exampleEnvPath),
        ...(fs.existsSync(localEnvPath) ? [path.relative(ROOT, localEnvPath)] : [])
      ],
      mysql: {
        host: mysqlConfig.host,
        port: mysqlConfig.port,
        database: mysqlConfig.database,
        user: mysqlConfig.user
      },
      output_directory: outputDir
    },
    methods: {
      "in-memory": "Process-local Set keyed by raw jti; state is lost on service restart.",
      redis: "Shared atomic Redis SET NX keyed by SHA-256(jti), retained without expiry for the experiment.",
      "redis-ttl": "Shared atomic Redis SET NX PX keyed by SHA-256(jti), TTL is the JWT's remaining lifetime.",
      mysql: "Shared MySQL InnoDB table keyed by SHA-256(jti), using atomic INSERT into consumed_tokens."
    },
    token_semantics: "One-time-use service token: one jti can authorize at most one protected operation.",
    jwt_configuration: {
      issuer: "auth-service",
      audience: "order-service",
      subject: "order_service",
      algorithm: "HS256",
      token_lifetime_seconds: config.tokenTtlSeconds,
      secret_recorded: false
    },
    scenarios: SCENARIOS,
    request_counts: {
      planned_measured_requests: SCENARIOS.reduce(
        (total, scenario) => total + plannedRequestCount(scenario, config) * config.repetitions,
        0
      ),
      completed_measured_requests: 0
    },
    request_schema_version: 3,
    measurement: {
      latency: "Runner-observed end-to-end HTTP latency using process.hrtime.bigint(); excludes token setup and health checks.",
      warmup: "One warm-up request per scenario is logged and included in request counts, but excluded from performance-phase metrics.",
      throughput: "Completed performance-phase requests divided by wall-clock span of recorded performance request start/end timestamps.",
      percentiles: "Linear interpolation between adjacent sorted observations; standard deviation uses sample formula (n-1).",
      store_latency: "Order Service's internal replay-store consume() duration, returned in an experiment-only response header.",
      arrival_spread: "Difference between the maximum and minimum Order Service CLOCK_MONOTONIC-equivalent process.hrtime.bigint() timestamps within one batch; comparable because all services run on the same host.",
      protected_operation_execution: "Measured from an experiment-only handler response header and independently emitted execution event from the Order Service; unknown remains null when no evidence is observed.",
      global_one_time_use: "At most one accepted HTTP outcome and at most one protected operation execution per concurrent batch and jti_hash. Zero executions are recorded as unavailable, not as a successful batch.",
      resource_metrics: "CPU and process memory utilization were not sampled; summary columns remain empty."
    },
    preflight: {
      passed: errors.length === 0,
      checked_at: startTime,
      errors: [...errors]
    },
    errors
  };
  writeMetadata(metadata, outputDir);
  activeFiles.event({ event: "experiment_started", experiment_id: experimentId, mode: config.mode });
  if (redisStatus.available) {
    activeFiles.event({ event: "redis_ready", redis_version: redisStatus.version });
  }
  if (mysqlStatus.available) {
    activeFiles.event({ event: "mysql_ready", mysql_version: mysqlStatus.version });
  }
  if (errors.length) {
    metadata.end_time = timestamp();
    metadata.errors = errors;
    metadata.preflight.passed = false;
    metadata.request_counts.completed_measured_requests = 0;
    writeMetadata(metadata, outputDir);
    activeFiles.event({ event: "preflight_failed", errors });
    console.error("Preflight failed; no experiment scenarios were run.");
    console.error(JSON.stringify({
      redis: redisStatus,
      mysql: { ...mysqlStatus, password_configured: mysqlStatus.password_configured }
    }, null, 2));
    console.error(`Preflight report: ${outputDir}`);
    process.exitCode = 1;
    return;
  }

  let authProcess;
  let authPort;
  let authReady = false;
  if (!errors.length) {
    try {
      authPort = await allocatePort();
      authProcess = spawnService("experiment-auth-service", path.join(ROOT, "auth-service"), "server-secure.js", {
        EXPERIMENT_MODE: "true",
        EXPERIMENT_KEY: experimentKey,
        EXPERIMENT_TOKEN_TTL_SECONDS: String(config.tokenTtlSeconds),
        JWT_SECRET: experimentSecret,
        ORDER_SERVICE_SECRET: crypto.randomBytes(32).toString("hex"),
        PORT: String(authPort)
      });
      await waitReady(`http://127.0.0.1:${authPort}/health`, {}, authProcess);
      authReady = true;
      appendEvent("service_started", { service: "auth-service", port: authPort });
    } catch (error) {
      errors.push(`Auth Service startup failed: ${error.message}`);
      appendEvent("error", { category: "auth_startup_error", message: error.message });
    }
  }

  if (!authReady) {
    await cleanup();
    metadata.end_time = timestamp();
    metadata.errors = [...errors, ...runtimeIssues];
    metadata.preflight.passed = false;
    writeMetadata(metadata, outputDir);
    activeFiles.event({ event: "experiment_aborted", reason: metadata.errors.join("; ") });
    console.error(`Auth Service preflight failed; no scenarios were run. Report: ${outputDir}`);
    process.exitCode = 1;
    return;
  }

  try {
    for (const scenario of SCENARIOS) {
      for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
        if (interrupted) break;
        console.log(`[${scenario.scenario_id} ${repetition}/${config.repetitions}] ${scenario.method}, ${scenario.replica_count} replica(s)`);
        await runScenario({
          experimentId, scenario, repetition, config, authPort, experimentKey, certDir
        });
      }
      if (interrupted) break;
    }
  } finally {
    await cleanup();
  }

  metadata.end_time = timestamp();
  metadata.request_counts.completed_measured_requests = totalRequestsLogged;
  metadata.errors = [...errors, ...runtimeIssues];
  metadata.interrupted = interrupted;
  metadata.scenario_counts = {
    planned: SCENARIOS.length * config.repetitions,
    completed: scenarioOutcomes.filter((row) => row.status === "completed" &&
      row.completed_requests === row.planned_requests).length,
    partial: scenarioOutcomes.filter((row) => row.status === "partial").length,
    failed: scenarioOutcomes.filter((row) => row.status === "failed").length,
    not_run: SCENARIOS.length * config.repetitions - scenarioOutcomes.length
  };
  writeMetadata(metadata, outputDir);
  activeFiles.event({
    event: "experiment_completed",
    experiment_id: experimentId,
    end_time: metadata.end_time,
    interrupted
  });
  console.log(`\nExperiment results: ${outputDir}`);
  console.log("Generated: metadata.json, scenarios.csv, requests.csv, summary.csv, events.jsonl");
  if (interrupted) process.exitCode = 130;
  else if (metadata.scenario_counts.completed !== metadata.scenario_counts.planned) process.exitCode = 1;
}

process.once("SIGINT", () => {
  interrupted = true;
  if (activeFiles) {
    appendEvent("error", { category: "interrupted", message: "Experiment interrupted by SIGINT" });
  }
  void cleanup();
});

main().catch(async (error) => {
  if (activeFiles) appendEvent("error", { category: "experiment_error", message: error.message });
  console.error(`Experiment failed: ${error.message}`);
  await cleanup();
  process.exitCode = 1;
});
