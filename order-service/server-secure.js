/**
 * Order Service (Phase 2 / SECURE)
 *
 * TLS ROLES (see gateway/server.js header comment for full explanation):
 *   - This service ONLY accepts genuine mutual TLS connections. It requires
 *     the caller (the API Gateway) to present a client certificate signed
 *     by the shared CA, AND it checks the certificate's Common Name (CN)
 *     against an allow-list. requestCert+rejectUnauthorized alone proves
 *     "signed by our CA"; the CN check proves "signed for THIS caller",
 *     which is what stops a different service on the same CA from
 *     impersonating the gateway.
 *   - Unlike the previous version, this file no longer falls back to plain
 *     HTTP when certificates are missing. A silent HTTP fallback in a
 *     component described as "mTLS-protected" is exactly the kind of gap
 *     the editor flagged - the service now refuses to start instead.
 */
const express = require("express");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("redis");
const mysql = require("mysql2/promise");
const {
  InMemoryReplayStore,
  RedisReplayStore,
  RedisTtlReplayStore,
  MySQLReplayStore
} = require("./replay-stores");
const { createReplayMiddleware } = require("./replay-auth");

const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("[FATAL] JWT_SECRET is not set. Refusing to start with no secret.");
  process.exit(1);
}

const experimentMode = process.env.EXPERIMENT_MODE === "true";
const replayMethod = process.env.REPLAY_METHOD || "in-memory";
const replayPrefix = process.env.REPLAY_KEY_PREFIX || "microservices:replay";
let replayStore;
let redisClient;
let mysqlPool;

if (replayMethod === "in-memory") {
  replayStore = new InMemoryReplayStore();
  if (!experimentMode) {
    setInterval(() => {
      replayStore.clear();
      console.log("[INFO] Token store cleared");
    }, 5 * 60 * 1000);
  }
} else if (replayMethod === "redis" || replayMethod === "redis-ttl") {
  redisClient = createClient({
    url: process.env.REDIS_URL || "redis://127.0.0.1:6379",
    socket: {
      connectTimeout: 2000,
      reconnectStrategy: () => false
    }
  });
  redisClient.on("error", () => {
    console.error(JSON.stringify({
      event: "redis_connection_error",
      category: "replay_store_unavailable",
      message: "Redis connection error"
    }));
  });
  replayStore = replayMethod === "redis"
    ? new RedisReplayStore(redisClient, replayPrefix)
    : new RedisTtlReplayStore(redisClient, replayPrefix);
} else if (replayMethod === "mysql") {
  mysqlPool = mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    database: process.env.MYSQL_DATABASE || "mse",
    user: process.env.MYSQL_USER || "mse_runner",
    password: process.env.MYSQL_PASSWORD || "",
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
    connectTimeout: Number(process.env.MYSQL_CONNECT_TIMEOUT_MS || 5000),
    multipleStatements: false
  });
  replayStore = new MySQLReplayStore(mysqlPool, "consumed_tokens");
} else {
  console.error(`[FATAL] Unsupported REPLAY_METHOD: ${replayMethod}`);
  process.exit(1);
}

// Allow-list of client certificate Common Names permitted to call this
// service. In this testbed only the gateway calls the Order Service directly.
const ALLOWED_CLIENT_CNS = (process.env.ALLOWED_CLIENT_CNS || "gateway-client").split(",");

function verifyClientCertificate(req, res, next) {
  const cert = req.socket.getPeerCertificate();
  if (!req.socket.authorized) {
    return res.status(401).send(
      `mTLS client certificate rejected: ${req.socket.authorizationError || "not presented"}`
    );
  }
  if (!cert || !cert.subject || !ALLOWED_CLIENT_CNS.includes(cert.subject.CN)) {
    return res.status(403).send("mTLS client certificate CN not authorized for this service");
  }
  req.clientCertCN = cert.subject.CN;
  next();
}

const verifyToken = createReplayMiddleware({ jwtSecret: JWT_SECRET, replayStore, experimentMode });

app.use((req, res, next) => {
  if (experimentMode) {
    res.set("X-Experiment-Replica", process.env.REPLICA_ID || "order-1");
    const gatewayArrivalTimestamp = req.get("x-experiment-gateway-arrival-timestamp");
    const gatewayArrivalMonotonicNs = req.get("x-experiment-gateway-arrival-monotonic-ns");
    if (gatewayArrivalTimestamp) {
      res.set("X-Experiment-Gateway-Arrival-Timestamp", gatewayArrivalTimestamp);
    }
    if (gatewayArrivalMonotonicNs) {
      res.set("X-Experiment-Gateway-Arrival-Monotonic-Ns", gatewayArrivalMonotonicNs);
    }
  }
  next();
});

app.get("/orders", verifyClientCertificate, verifyToken, (req, res) => {
  if (experimentMode) {
    const executionTimestamp = new Date().toISOString();
    const executionMonotonicNs = process.hrtime.bigint().toString();
    const execution = {
      event: "protected_operation_executed",
      timestamp: executionTimestamp,
      monotonic_ns: executionMonotonicNs,
      request_id: req.get("x-request-id") || null,
      concurrent_batch_id: req.get("x-concurrent-batch-id") || null,
      jti_hash: crypto.createHash("sha256").update(req.decoded.jti).digest("hex"),
      replica_id: process.env.REPLICA_ID || "order-1",
      concurrency_level: Number(req.get("x-experiment-concurrency-level")) || null,
      scenario_id: req.get("x-experiment-scenario-id") || null,
      method: req.get("x-experiment-method") || null,
      replica_count: Number(req.get("x-experiment-replica-count")) || null,
      repetition: Number(req.get("x-experiment-repetition")) || null
    };
    process.stdout.write(`EXPERIMENT_EVENT ${JSON.stringify(execution)}\n`);
    res.set("X-Experiment-Protected-Operation-Executed", "true");
  }
  res.json({
    message: "Orders retrieved successfully",
    orders: [
      { id: 1, item: "Laptop", amount: 1200 },
      { id: 2, item: "Phone", amount: 800 },
      { id: 3, item: "Tablet", amount: 450 }
    ],
    authenticated_as: req.decoded.service,
    mtls_client_cn: req.clientCertCN
  });
});

app.get("/health", (req, res) => res.send({
  status: "order-service running (SECURE)",
  replica_id: process.env.REPLICA_ID || "order-1",
  replay_method: replayMethod
}));

const certDir = process.env.CERTS_DIR || path.join(__dirname, "../certs");
const orderKey = path.join(certDir, "order.key");
const orderPem = path.join(certDir, "order.pem");
const caPem = path.join(certDir, "ca.pem");

if (!(fs.existsSync(orderKey) && fs.existsSync(orderPem) && fs.existsSync(caPem))) {
  console.error("[FATAL] mTLS certificates not found under /certs. Refusing to start without mTLS.");
  process.exit(1);
}

async function start() {
  if (redisClient) await redisClient.connect();
  if (mysqlPool) {
    await replayStore.initialize();
  }

  const server = https.createServer({
    key: fs.readFileSync(orderKey),
    cert: fs.readFileSync(orderPem),
    ca: fs.readFileSync(caPem),
    requestCert: true,
    rejectUnauthorized: true
  }, app);

  const port = Number(process.env.PORT || 4000);
  const host = experimentMode ? "127.0.0.1" : "0.0.0.0";
  server.listen(port, host, () => {
    console.log(`[SECURE] Order Service ${process.env.REPLICA_ID || "order-1"} running on port ${port} with mandatory mTLS`);
  });

  const shutdown = async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (redisClient && redisClient.isOpen) await redisClient.quit();
    if (mysqlPool) await mysqlPool.end();
  };
  const handleShutdown = () => {
    shutdown().catch((error) => {
      console.error(`[FATAL] Order Service shutdown failed: ${error.message}`);
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", handleShutdown);
  process.once("SIGINT", handleShutdown);
}

start().catch((error) => {
  console.error(`[FATAL] Order Service startup failed: ${error.message}`);
  process.exit(1);
});
