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
const certDir = path.join(__dirname, "../certs");
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

const ORDER_SERVICE_TARGET = "https://order-service:4000";

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
  verifyToken,
  createProxyMiddleware({
    target: ORDER_SERVICE_TARGET,
    changeOrigin: true,
    agent: mtlsAgent,
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

app.listen(5000, () => console.log("[SECURE] API Gateway running on port 5000 (mTLS to order-service enabled)"));
