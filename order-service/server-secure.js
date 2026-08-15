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

// Token tracking for replay protection.
// LIMITATION (documented, not hidden): this is an in-memory Set. It is
// reset on process restart and is not shared across multiple replicas of
// this service. It is adequate for demonstrating the replay-protection
// mechanism in this single-instance testbed, but it is NOT a production
// replay-protection design - see manuscript Section 5.5 / Appendix note.
const usedTokens = new Set();

setInterval(() => {
  usedTokens.clear();
  console.log("[INFO] Token store cleared");
}, 5 * 60 * 1000);

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
      return res.status(403).send("Forbidden: invalid service identity");
    }

    if (usedTokens.has(token)) {
      return res.status(403).send("Token already used - replay attack detected");
    }

    usedTokens.add(token);
    req.decoded = decoded;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).send("Token expired");
    }
    return res.status(401).send("Invalid token");
  }
}

app.get("/orders", verifyClientCertificate, verifyToken, (req, res) => {
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

app.get("/health", (req, res) => res.send({ status: "order-service running (SECURE)" }));

const certDir = path.join(__dirname, "../certs");
const orderKey = path.join(certDir, "order.key");
const orderPem = path.join(certDir, "order.pem");
const caPem = path.join(certDir, "ca.pem");

if (!(fs.existsSync(orderKey) && fs.existsSync(orderPem) && fs.existsSync(caPem))) {
  console.error("[FATAL] mTLS certificates not found under /certs. Refusing to start without mTLS.");
  process.exit(1);
}

https.createServer({
  key: fs.readFileSync(orderKey),
  cert: fs.readFileSync(orderPem),
  ca: fs.readFileSync(caPem),
  requestCert: true,
  rejectUnauthorized: true
}, app).listen(4000, () => {
  console.log("[SECURE] Order Service running on port 4000 with mandatory mTLS");
});
