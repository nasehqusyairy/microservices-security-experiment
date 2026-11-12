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

class MySQLReplayStore {
  constructor(pool, tableName = "consumed_tokens") {
    this.pool = pool;
    this.tableName = tableName;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    const createTableSql = `
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        jti_hash CHAR(64) NOT NULL PRIMARY KEY,
        expires_at BIGINT NOT NULL,
        consumed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `;
    await this.pool.query(createTableSql);
    this.initialized = true;
  }

  async consume(jti, expiresAt) {
    const jtiHash = crypto.createHash("sha256").update(String(jti)).digest("hex");
    try {
      await this.initialize();
      await this.pool.execute(`INSERT INTO ${this.tableName} (jti_hash, expires_at) VALUES (?, ?)`, [
        jtiHash,
        Number(expiresAt)
      ]);
      return { outcome: "accepted", jtiHash, expiresAt };
    } catch (error) {
      if (error && (error.code === "ER_DUP_ENTRY" || error.errno === 1062 || error.code === "23505")) {
        return { outcome: "replay_detected", jtiHash, expiresAt };
      }
      return {
        outcome: "store_error",
        errorCategory: error && error.code ? error.code : "database_error",
        message: error && error.message ? error.message : "Database replay store failed"
      };
    }
  }
}

module.exports = {
  InMemoryReplayStore,
  RedisReplayStore,
  RedisTtlReplayStore,
  MySQLReplayStore
};
