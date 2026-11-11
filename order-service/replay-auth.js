const jwt = require("jsonwebtoken");

function createReplayMiddleware({ jwtSecret, replayStore, experimentMode = false }) {
  return async function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).send("No token provided");

    const [scheme, token] = authHeader.split(" ");
    if (scheme !== "Bearer" || !token) {
      return res.status(401).send("Malformed authorization header");
    }

    let decoded;
    try {
      decoded = jwt.verify(token, jwtSecret, {
        issuer: "auth-service",
        audience: "order-service"
      });
    } catch (error) {
      if (error.name === "TokenExpiredError") return res.status(401).send("Token expired");
      return res.status(401).send("Invalid token");
    }

    if (
      decoded.service !== "order_service" ||
      typeof decoded.jti !== "string" ||
      !decoded.jti ||
      !Number.isInteger(decoded.exp)
    ) {
      return res.status(403).send("Forbidden: invalid service identity or token claims");
    }

    const startedAt = process.hrtime.bigint();
    let result;
    try {
      result = await replayStore.consume(decoded.jti, decoded.exp);
    } catch (error) {
      const storeLatencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      console.error(JSON.stringify({
        event: "replay_store_error",
        category: "replay_store_unavailable",
        message: "Replay state could not be stored or checked"
      }));
      if (experimentMode) {
        res.set("X-Experiment-Store-Result", "store_error");
        res.set("X-Experiment-Store-Latency-Ms", String(storeLatencyMs));
      }
      return res.status(503).send("Replay protection unavailable");
    }

    const storeLatencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (experimentMode) {
      res.set("X-Experiment-Store-Result", result.outcome);
      res.set("X-Experiment-Store-Latency-Ms", String(storeLatencyMs));
      if (result.ttlMs !== undefined) {
        res.set("X-Experiment-Store-Ttl-Ms", String(result.ttlMs));
      }
    }

    if (result.outcome === "store_error") {
      console.error(JSON.stringify({
        event: "replay_store_error",
        category: result.errorCategory || "replay_store_error",
        message: "Replay state could not be stored or checked"
      }));
      return res.status(result.errorCategory === "token_expired_before_store" ? 401 : 503)
        .send("Replay protection unavailable");
    }
    if (result.outcome === "replay_detected") {
      return res.status(403).send("Token already used - replay detected");
    }

    req.decoded = decoded;
    next();
  };
}

module.exports = { createReplayMiddleware };
