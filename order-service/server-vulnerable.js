const express = require("express");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());

// VULNERABLE: Hardcoded secret
const JWT_SECRET = "SUPER_SECRET";

function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).send("No token provided");

  const token = authHeader.split(" ")[1];

  try {
    // VULNERABLE: Only verifies signature, no issuer/audience/expiry enforcement
    const decoded = jwt.verify(token, JWT_SECRET);
    req.decoded = decoded;
    next();
  } catch (err) {
    return res.status(401).send("Invalid token");
  }
}

app.get("/orders", verifyToken, (req, res) => {
  // VULNERABLE: No service identity check
  res.json({
    message: "Orders retrieved successfully",
    orders: [
      { id: 1, item: "Laptop", amount: 1200 },
      { id: 2, item: "Phone", amount: 800 },
      { id: 3, item: "Tablet", amount: 450 }
    ],
    authenticated_as: req.decoded.service
  });
});

app.get("/health", (req, res) => res.send({ status: "order-service running (VULNERABLE)" }));

app.listen(4000, () => console.log("[VULNERABLE] Order Service running on port 4000"));
