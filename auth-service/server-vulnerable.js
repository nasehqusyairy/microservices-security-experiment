const express = require("express");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());

// VULNERABLE: Hardcoded secret
const JWT_SECRET = "SUPER_SECRET";

// Static credentials
const VALID_CREDENTIALS = {
  order_service: "order_secret"
};

app.post("/service-token", (req, res) => {
  const clientId = req.headers["x-client-id"];
  const clientSecret = req.headers["x-client-secret"];

  if (!clientId || !clientSecret) {
    return res.status(400).send("Missing credentials");
  }

  if (VALID_CREDENTIALS[clientId] !== clientSecret) {
    return res.status(401).send("Invalid credentials");
  }

  // VULNERABLE: No expiration, no issuer, no audience
  const token = jwt.sign({
    typ: "service",
    service: clientId
  }, JWT_SECRET);

  res.send({ token });
});

app.get("/health", (req, res) => res.send({ status: "auth-service running (VULNERABLE)" }));

app.listen(3000, () => console.log("[VULNERABLE] Auth Service running on port 3000"));
