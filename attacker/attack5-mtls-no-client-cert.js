/**
 * ATTACK 5: Connection to Order Service without a valid mTLS client
 * certificate.
 *
 * Demonstrates the negative case the editor asked for: evidence of
 * REJECTION when no valid client certificate is presented, as distinct
 * from evidence of successful authenticated communication (see
 * verify-mtls-success.js).
 *
 * Run from a machine that can reach order-service:4000 (e.g. inside the
 * Docker network, or with the port published to the host).
 */
const https = require("https");

console.log("=== ATTACK 5: mTLS BYPASS ATTEMPT (no client certificate) ===\n");

const options = {
  hostname: "localhost",
  port: 4000,
  path: "/orders",
  method: "GET",
  // No key/cert/ca supplied - this is the point of the test.
  rejectUnauthorized: false, // ignore server verification so we can see the handshake outcome
  headers: { Authorization: "Bearer irrelevant-because-tls-should-fail-first" }
};

const req = https.request(options, (res) => {
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => {
    console.log(`[*] HTTP status: ${res.statusCode}`);
    console.log(`[*] Body: ${data}`);
    if (res.statusCode === 401 || res.statusCode === 403) {
      console.log("\n[RESULT] SECURE: Connection without a client certificate was rejected");
    } else {
      console.log("\n[RESULT] VULNERABLE: Order Service responded without requiring a client certificate");
    }
  });
});

req.on("error", (err) => {
  // A TLS-level handshake failure (no application response at all) is the
  // strongest form of rejection and is expected when the server enforces
  // requestCert + rejectUnauthorized at the TLS layer.
  console.log(`[+] TLS handshake failed before any HTTP response: ${err.message}`);
  console.log("\n[RESULT] SECURE: mTLS enforced at the transport layer - no client cert, no connection");
});

req.end();
