const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");

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

app.post("/service-token", (req, res) => {
  const clientId = req.headers["x-client-id"];
  const clientSecret = req.headers["x-client-secret"];

  if (!clientId || !clientSecret) {
    return res.status(400).send("Missing credentials");
  }

  if (!VALID_CREDENTIALS[clientId] || VALID_CREDENTIALS[clientId] !== clientSecret) {
    return res.status(401).send("Invalid credentials");
  }

  // SECURE: env secret + expiration + issuer + audience
  const token = jwt.sign(
    { typ: "service", service: clientId },
    JWT_SECRET,
    {
      expiresIn: "60s",
      issuer: "auth-service",
      audience: "order-service"
    }
  );

  res.send({ token });
});

app.get("/health", (req, res) => res.send({ status: "auth-service running (SECURE)" }));

app.listen(3000, () => console.log("[SECURE] Auth Service running on port 3000"));
