/**
 * Evidence of successful, genuinely mutual, authenticated TLS communication
 * between a properly-credentialed client and the Order Service.
 *
 * Uses the same client.key/client.pem/ca.pem the gateway uses, to prove the
 * happy path works end-to-end and that the earlier attack script's failure
 * was due to the missing certificate, not a broken server.
 */
const https = require("https");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

const certDir = path.join(__dirname, "../certs");
const JWT_SECRET = process.env.JWT_SECRET || "UltraSecureSecret123!XYZ";

const token = jwt.sign(
  { typ: "service", service: "order_service" },
  JWT_SECRET,
  { expiresIn: "60s", issuer: "auth-service", audience: "order-service" }
);

const options = {
  hostname: "localhost",
  port: 4000,
  path: "/orders",
  method: "GET",
  key: fs.readFileSync(path.join(certDir, "client.key")),
  cert: fs.readFileSync(path.join(certDir, "client.pem")),
  ca: fs.readFileSync(path.join(certDir, "ca.pem")),
  headers: { Authorization: `Bearer ${token}` }
};

console.log("=== mTLS SUCCESS CHECK: valid client certificate + valid JWT ===\n");

const req = https.request(options, (res) => {
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => {
    console.log(`[*] HTTP status: ${res.statusCode}`);
    console.log(`[*] Body: ${data}`);
    console.log(res.statusCode === 200
      ? "\n[RESULT] Genuine mutual TLS + valid application token succeeded end-to-end"
      : "\n[RESULT] Unexpected failure - check that docker-compose.secure.yml is running");
  });
});

req.on("error", (err) => console.log("[ERROR]", err.message));
req.end();
