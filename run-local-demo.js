#!/usr/bin/env node
/**
 * Local Test Runner
 * Starts services locally and runs all attacks automatically.
 * Demonstrates both VULNERABLE and SECURE behavior.
 * 
 * Usage: node run-local-demo.js
 * Requirements: Node.js 16+, npm packages installed in each service folder
 */

const { spawn, execSync } = require("child_process");
const http = require("http");
const https = require("https");
const fs = require("fs");
const tls = require("tls");
const path = require("path");

const ROOT = __dirname;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeRequest(options, body = null) {
  return new Promise((resolve) => {
    const transport = options.protocol === "https:" ? https : http;
    const req = transport.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", (e) => resolve({ status: 0, body: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

function installDeps(serviceDir) {
  try {
    console.log(`  Installing dependencies in ${path.basename(serviceDir)}...`);
    execSync("npm install --silent", { cwd: serviceDir, stdio: "ignore" });
  } catch (e) {
    console.log(`  Warning: npm install failed in ${serviceDir}`);
  }
}

async function waitForService(port, requestOptions = {}, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    const r = await makeRequest({
      ...requestOptions,
      hostname: "localhost",
      port,
      path: "/health",
      method: "GET"
    });
    if (r.status === 200) return true;
    await wait(500);
  }
  return false;
}

let processes = [];

function startProcess(name, cwd, script, env = {}) {
  const proc = spawn("node", [script], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stdout.on("data", (d) => {
    const line = d.toString().trim();
    if (line) console.log(`  [${name}] ${line}`);
  });
  proc.stderr.on("data", (d) => {
    const line = d.toString().trim();
    if (line && !line.includes("DeprecationWarning")) {
      console.log(`  [${name}:ERR] ${line}`);
    }
  });
  processes.push(proc);
  return proc;
}

function cleanup() {
  console.log("\n[*] Stopping all services...");
  processes.forEach((p) => { try { p.kill(); } catch (_) {} });
}

process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);

async function runPhase(phaseName, authScript, orderScript, envVars = {}) {
  const jwt = require("jsonwebtoken");

  console.log(`\n${"═".repeat(64)}`);
  console.log(`  ${phaseName}`);
  console.log(`${"═".repeat(64)}\n`);

  // Kill any previous processes
  processes.forEach((p) => { try { p.kill(); } catch (_) {} });
  processes = [];
  await wait(500);

  const isSecure = phaseName.includes("SECURE");
  const certDir = path.join(ROOT, "certs");
  const requiredCerts = ["ca.pem", "client.pem", "client.key", "order.pem", "order.key"];
  const missingCerts = requiredCerts.filter((file) => !fs.existsSync(path.join(certDir, file)));

  if (isSecure && missingCerts.length > 0) {
    console.log(
      `[ERROR] SECURE phase requires mTLS certificates. Missing: ${missingCerts.join(", ")}. ` +
      "Run 'npm run certs' first."
    );
    return false;
  }

  if (isSecure) {
    const certificatePairs = [
      { name: "client", cert: "client.pem", key: "client.key" },
      { name: "order service", cert: "order.pem", key: "order.key" }
    ];

    for (const pair of certificatePairs) {
      try {
        tls.createSecureContext({
          cert: fs.readFileSync(path.join(certDir, pair.cert)),
          key: fs.readFileSync(path.join(certDir, pair.key))
        });
      } catch (error) {
        console.log(
          `[ERROR] Invalid ${pair.name} mTLS certificate/key: ${error.message}. ` +
          "Regenerate the certificates with 'npm run certs'."
        );
        return false;
      }
    }
  }

  const orderRequestOptions = isSecure
    ? {
        protocol: "https:",
        ca: fs.readFileSync(path.join(certDir, "ca.pem")),
        cert: fs.readFileSync(path.join(certDir, "client.pem")),
        key: fs.readFileSync(path.join(certDir, "client.key")),
        servername: "order-service"
      }
    : {};

  // Start services
  console.log("[*] Starting services...");
  startProcess("auth", path.join(ROOT, "auth-service"), authScript, envVars);
  await wait(800);
  startProcess("order", path.join(ROOT, "order-service"), orderScript, envVars);
  await wait(800);

  // Wait for services
  const authOk = await waitForService(3000);
  const orderOk = await waitForService(4000, orderRequestOptions);

  if (!authOk || !orderOk) {
    console.log("[ERROR] Services failed to start. Check the service errors above.");
    return false;
  }

  console.log("[+] Services ready\n");

  const SECRET = envVars.JWT_SECRET || "SUPER_SECRET";

  // ── Test 1: Token Forgery ────────────────────────────────────────────────
  console.log("┌─ ATTACK 1: TOKEN FORGERY");
  const forgedToken = jwt.sign({ typ: "service", service: "attacker" }, "SUPER_SECRET");
  const r1 = await makeRequest({
    ...orderRequestOptions,
    hostname: "localhost", port: 4000, path: "/orders", method: "GET",
    headers: { Authorization: `Bearer ${forgedToken}` }
  });

  if (r1.status === 200) {
    console.log("│  [!] VULNERABLE: Forged token accepted - unauthorized access achieved");
    try { console.log("│  Orders: " + JSON.parse(r1.body).message); } catch (_) {}
  } else {
    console.log(`│  [+] SECURE: Forged token rejected - HTTP ${r1.status}: ${r1.body}`);
  }
  console.log("└─\n");

  // ── Test 2: Brute Force ──────────────────────────────────────────────────
  console.log("┌─ ATTACK 2: BRUTE-FORCE");
  const guesses = ["123456", "admin", "password", "order_secret", "SecureOrderSecret!456"];
  let found = false;

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
      console.log(`│  [+] SECURE: Rate limited after attempt - HTTP 429 Too Many Requests`);
      found = true;
      break;
    } else if (r.status === 200) {
      console.log(`│  [!] VULNERABLE: Credential found: "${guess}"`);
      found = true;
      break;
    } else {
      console.log(`│  [-] Attempt failed: "${guess}" (HTTP ${r.status})`);
      await wait(150);
    }
  }

  if (!found) console.log("│  [-] Wordlist exhausted without success");
  console.log("└─\n");

  // ── Test 3: Replay Attack ────────────────────────────────────────────────
  console.log("┌─ ATTACK 3: REPLAY ATTACK");

  // First get a valid token
  const authR = await makeRequest({
    hostname: "localhost", port: 3000, path: "/service-token", method: "POST",
    headers: {
      "x-client-id": "order_service",
      "x-client-secret": isSecure ? (envVars.ORDER_SERVICE_SECRET || "order_secret") : "order_secret",
      "Content-Type": "application/json"
    }
  });

  let capturedToken;
  if (authR.status === 200) {
    try { capturedToken = JSON.parse(authR.body).token; } catch (_) {}
  } else if (authR.status === 429) {
    // Rate limit hit from previous test - use a forged token for replay test
    capturedToken = jwt.sign({ typ: "service", service: "order_service" }, "SUPER_SECRET");
    console.log("│  (Using forged token for replay test - auth was rate limited)");
  }

  if (capturedToken) {
    for (let i = 1; i <= 3; i++) {
      const rr = await makeRequest({
        ...orderRequestOptions,
        hostname: "localhost", port: 4000, path: "/orders", method: "GET",
        headers: { Authorization: `Bearer ${capturedToken}` }
      });
      if (rr.status === 200) {
        console.log(`│  [!] Replay ${i}: ACCEPTED (VULNERABLE)`);
      } else {
        console.log(`│  [+] Replay ${i}: BLOCKED - ${rr.body} (SECURE)`);
      }
      await wait(200);
    }
  }
  console.log("└─\n");

  // ── Test 4: Weak Validation ──────────────────────────────────────────────
  console.log("┌─ ATTACK 4: WEAK TOKEN VALIDATION");
  const manipulated = jwt.sign(
    { typ: "service", service: "attacker", role: "admin" },
    "SUPER_SECRET"
  );

  const r4 = await makeRequest({
    ...orderRequestOptions,
    hostname: "localhost", port: 4000, path: "/orders", method: "GET",
    headers: { Authorization: `Bearer ${manipulated}` }
  });

  if (r4.status === 200) {
    console.log("│  [!] VULNERABLE: Manipulated claims accepted");
  } else {
    console.log(`│  [+] SECURE: Manipulated claims rejected - HTTP ${r4.status}: ${r4.body}`);
  }
  console.log("└─");
  return true;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  MICROSERVICES SECURITY RESEARCH - LOCAL DEMO                ║");
  console.log("║  Securing Inter-Service Communication in Containerised        ║");
  console.log("║  Microservice Architectures                                   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  // Install dependencies
  console.log("\n[*] Installing dependencies...");
  installDeps(path.join(ROOT, "auth-service"));
  installDeps(path.join(ROOT, "order-service"));
  installDeps(path.join(ROOT, "attacker"));

  // Phase 1: Vulnerable
  const vulnerablePhaseOk = await runPhase(
    "PHASE 1: VULNERABLE SYSTEM (No Security Controls)",
    "server-vulnerable.js",
    "server-vulnerable.js"
  );
  if (!vulnerablePhaseOk) throw new Error("Vulnerable phase failed; see the error above.");

  await wait(1000);

  // Phase 2: Secure
  const securePhaseOk = await runPhase(
    "PHASE 2: SECURE SYSTEM (Layered Security Framework)",
    "server-secure.js",
    "server-secure.js",
    {
      JWT_SECRET: "UltraSecureSecret123!XYZ",
      ORDER_SERVICE_SECRET: "SecureOrderSecret!456"
    }
  );
  if (!securePhaseOk) throw new Error("Secure phase failed; see the error above.");

  console.log(`\n${"═".repeat(64)}`);
  console.log("  DEMONSTRATION COMPLETE");
  console.log(`${"═".repeat(64)}`);
  console.log("\nSummary of mitigations implemented:");
  console.log("  ✓ JWT Hardening (env secrets, expiry, issuer, audience)");
  console.log("  ✓ Rate Limiting (3 requests/min on auth endpoint)");
  console.log("  ✓ Replay Protection (token tracking with Set)");
  console.log("  ✓ Service Identity Verification");
  console.log("  ✓ Strict Claim Validation");
  console.log("\nFor Docker deployment, see docker-compose.secure.yml");
  console.log("For mTLS setup, run: bash certs/generate-certs.sh\n");

  cleanup();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
