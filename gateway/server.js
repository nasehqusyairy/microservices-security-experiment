/**
 * API Gateway (Phase 2 / SECURE)
 *
 * TLS ROLES IN THIS SYSTEM (documented per Editor Decision, point 1):
 *   1. EDGE TLS      - Nginx terminates TLS from external clients (HTTPS).
 *   2. INTERNAL mTLS - Gateway -> Order Service uses genuine mutual TLS:
 *                      the gateway presents a client certificate signed by
 *                      the local CA, and the Order Service verifies it
 *                      (requestCert + rejectUnauthorized + CN check).
 *                      Without this file's https.Agent block, the previous
 *                      version silently talked to the Order Service over
 *                      plain HTTP even though the Order Service itself was
 *                      mTLS-capable - i.e. mTLS was configured but never
 *                      actually used. That gap is fixed below.
 */
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const jwt = require("jsonwebtoken");
const https = require("https");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("[FATAL] JWT_SECRET is not set. Refusing to start with no secret.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// mTLS client identity: the gateway authenticates itself to the Order
// Service using a client certificate signed by the shared CA.
// ---------------------------------------------------------------------------
const certDir = process.env.CERTS_DIR || path.join(__dirname, "../certs");
const clientKeyPath = path.join(certDir, "client.key");
const clientCertPath = path.join(certDir, "client.pem");
const caPath = path.join(certDir, "ca.pem");

const mtlsEnabled =
  fs.existsSync(clientKeyPath) && fs.existsSync(clientCertPath) && fs.existsSync(caPath);

if (!mtlsEnabled) {
  console.error(
    "[FATAL] mTLS client certificate/key/CA not found under /certs. " +
    "The SECURE gateway requires mTLS to reach the Order Service and will not " +
    "silently downgrade to plaintext HTTP."
  );
  process.exit(1);
}

const mtlsAgent = new https.Agent({
  key: fs.readFileSync(clientKeyPath),
  cert: fs.readFileSync(clientCertPath),
  ca: fs.readFileSync(caPath),
  // Verify the Order Service's certificate is signed by our CA and matches
  // the hostname we intended to reach (genuine mutual authentication, not
  // just "some TLS").
  rejectUnauthorized: true,
  servername: "order-service"
});

const experimentMode = process.env.EXPERIMENT_MODE === "true";
let orderServiceTargets = { "order-1": "https://order-service:4000" };
if (experimentMode && process.env.ORDER_SERVICE_TARGETS) {
  try {
    orderServiceTargets = JSON.parse(process.env.ORDER_SERVICE_TARGETS);
  } catch (error) {
    console.error("[FATAL] ORDER_SERVICE_TARGETS must be a JSON object.");
    process.exit(1);
  }
  if (
    !orderServiceTargets ||
    typeof orderServiceTargets !== "object" ||
    Array.isArray(orderServiceTargets) ||
    Object.values(orderServiceTargets).some((target) => typeof target !== "string" || !target.startsWith("https://"))
  ) {
    console.error("[FATAL] Experiment order-service targets must be HTTPS URLs.");
    process.exit(1);
  }
}
const defaultReplicaId = Object.keys(orderServiceTargets)[0];

app.use((req, res, next) => {
  if (experimentMode && req.path === "/orders") {
    req.experimentGatewayArrival = {
      timestamp: new Date().toISOString(),
      monotonicNs: process.hrtime.bigint().toString()
    };
    req.headers["x-experiment-gateway-arrival-timestamp"] =
      req.experimentGatewayArrival.timestamp;
    req.headers["x-experiment-gateway-arrival-monotonic-ns"] =
      req.experimentGatewayArrival.monotonicNs;
  }
  next();
});

// ---------------------------------------------------------------------------
// JWT verification middleware (application-layer authorization, separate
// from the transport-layer identity established by mTLS above)
// ---------------------------------------------------------------------------
function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).send("No token provided");

  const token = authHeader.split(" ")[1];
  if (!token) return res.status(401).send("Malformed authorization header");

  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: "auth-service",
      audience: "order-service"
    });

    if (decoded.service !== "order_service") {
      return res.status(403).send("Forbidden: unauthorized service");
    }

    req.decoded = decoded;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") return res.status(401).send("Token expired");
    return res.status(401).send("Invalid token");
  }
}

// Route: proxy /orders to order-service over mTLS after JWT verification
app.use(
  "/orders",
  (req, res, next) => {
    const requestedReplica = experimentMode
      ? req.get("x-experiment-replica") || defaultReplicaId
      : defaultReplicaId;
    if (!Object.hasOwn(orderServiceTargets, requestedReplica)) {
      return res.status(400).send("Unknown experiment replica");
    }
    req.experimentReplica = requestedReplica;
    next();
  },
  verifyToken,
  createProxyMiddleware({
    target: orderServiceTargets[defaultReplicaId],
    changeOrigin: true,
    agent: mtlsAgent,
    router: (req) => orderServiceTargets[req.experimentReplica],
    on: {
      error: (err, req, res) => {
        console.error("Proxy error (mTLS handshake or upstream failure):", err.message);
        res.status(502).send("Bad gateway");
      }
    }
  })
);

// Route: proxy /auth to auth-service (no token needed to get a token)
app.use(
  "/auth",
  createProxyMiddleware({
    target: "http://auth-service:3000",
    changeOrigin: true,
    pathRewrite: { "^/auth": "" }
  })
);

app.get("/health", (req, res) => {
  res.send({ status: "gateway running", mtls_to_order_service: mtlsEnabled, timestamp: new Date().toISOString() });
});

const port = Number(process.env.PORT || 5000);
const host = experimentMode ? "127.0.0.1" : "0.0.0.0";
app.listen(port, host, () => console.log(`[SECURE] API Gateway running on port ${port} (mTLS to order-service enabled)`));
