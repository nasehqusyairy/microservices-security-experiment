const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const net = require("net");

const app = express();
app.use(express.json());

// SECURE: Secret from environment variable
const JWT_SECRET = process.env.JWT_SECRET || "FallbackSecretChangeInProd";
const ORDER_SERVICE_SECRET = process.env.ORDER_SERVICE_SECRET || "order_secret";

const VALID_CREDENTIALS = {
  order_service: ORDER_SERVICE_SECRET
};

// Rate limiting: max 3 attempts per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: "Too many requests - rate limit exceeded"
});

app.use("/service-token", limiter);

function issueToken(clientId, expiresIn = "60s") {
  return jwt.sign(
    { typ: "service", service: clientId },
    JWT_SECRET,
    {
      subject: clientId,
      jwtid: crypto.randomUUID(),
      expiresIn,
      issuer: "auth-service",
      audience: "order-service"
    }
  );
}

app.post("/service-token", (req, res) => {
  const clientId = req.headers["x-client-id"];
  const clientSecret = req.headers["x-client-secret"];

  if (!clientId || !clientSecret) {
    return res.status(400).send("Missing credentials");
  }

  if (!VALID_CREDENTIALS[clientId] || VALID_CREDENTIALS[clientId] !== clientSecret) {
    return res.status(401).send("Invalid credentials");
  }

  res.send({ token: issueToken(clientId) });
});

app.post("/experiment/tokens", (req, res) => {
  const remoteAddress = req.socket.remoteAddress || "";
  const isLoopback =
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1" ||
    (net.isIP(remoteAddress) === 4 && remoteAddress.startsWith("127."));
  const experimentKey = process.env.EXPERIMENT_KEY;

  if (
    process.env.EXPERIMENT_MODE !== "true" ||
    !isLoopback ||
    !experimentKey ||
    req.get("x-experiment-key") !== experimentKey
  ) {
    return res.sendStatus(404);
  }

  const count = req.body && req.body.count;
  if (!Number.isInteger(count) || count < 1 || count > 10000) {
    return res.status(400).send("count must be an integer between 1 and 10000");
  }

  const expiresIn = Number(process.env.EXPERIMENT_TOKEN_TTL_SECONDS || 300);
  if (!Number.isInteger(expiresIn) || expiresIn < 30 || expiresIn > 3600) {
    return res.status(500).send("Invalid experiment token lifetime configuration");
  }

  res.send({ tokens: Array.from({ length: count }, () => issueToken("order_service", `${expiresIn}s`)) });
});

app.get("/health", (req, res) => res.send({ status: "auth-service running (SECURE)" }));

const port = Number(process.env.PORT || 3000);
const host = process.env.EXPERIMENT_MODE === "true" ? "127.0.0.1" : "0.0.0.0";
app.listen(port, host, () => console.log(`[SECURE] Auth Service running on port ${port}`));
