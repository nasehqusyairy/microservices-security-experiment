const crypto = require("crypto");

class InMemoryReplayStore {
  constructor() {
    this.usedJtis = new Set();
  }

  async consume(jti) {
    if (this.usedJtis.has(jti)) return { outcome: "replay_detected" };
    this.usedJtis.add(jti);
    return { outcome: "accepted" };
  }

  clear() {
    this.usedJtis.clear();
  }
}

class RedisReplayStore {
  constructor(client, prefix) {
    this.client = client;
    this.prefix = prefix;
  }

  async consume(jti) {
    const key = this.keyFor(jti);
    const inserted = await this.client.set(key, "1", { NX: true });
    return { outcome: inserted === "OK" ? "accepted" : "replay_detected" };
  }

  keyFor(jti) {
    return `${this.prefix}:${crypto.createHash("sha256").update(jti).digest("hex")}`;
  }
}

class RedisTtlReplayStore extends RedisReplayStore {
  async consume(jti, expiresAt) {
    const remainingTtlMs = Math.floor(expiresAt * 1000 - Date.now());
    if (remainingTtlMs <= 0) {
      return { outcome: "store_error", errorCategory: "token_expired_before_store" };
    }

    const key = this.keyFor(jti);
    const inserted = await this.client.set(key, "1", {
      NX: true,
      PX: remainingTtlMs
    });
    return {
      outcome: inserted === "OK" ? "accepted" : "replay_detected",
      ttlMs: remainingTtlMs
    };
  }
}

module.exports = { InMemoryReplayStore, RedisReplayStore, RedisTtlReplayStore };
