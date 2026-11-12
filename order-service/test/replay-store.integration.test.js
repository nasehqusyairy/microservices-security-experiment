const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mysql = require("mysql2/promise");
const { createClient } = require("redis");
const {
  MySQLReplayStore,
  RedisReplayStore,
  RedisTtlReplayStore
} = require("../replay-stores");

const enabled = process.env.REPLAY_STORE_INTEGRATION === "true";
const uniqueJti = () => `integration-${crypto.randomUUID()}`;

test("native Redis SET NX admits exactly one concurrent consumer", { skip: !enabled }, async () => {
  const client = createClient({
    url: process.env.REDIS_URL || "redis://127.0.0.1:6379",
    socket: { reconnectStrategy: () => false }
  });
  client.on("error", () => {});
  await client.connect();
  const store = new RedisReplayStore(client, `mse-integration:${crypto.randomUUID()}`);
  const jti = uniqueJti();
  try {
    const results = await Promise.all(Array.from({ length: 100 }, () => store.consume(jti)));
    assert.equal(results.filter((result) => result.outcome === "accepted").length, 1);
    assert.equal(results.filter((result) => result.outcome === "replay_detected").length, 99);
  } finally {
    await client.del(store.keyFor(jti));
    await client.quit();
  }
});

test("native Redis TTL SET NX admits exactly one concurrent consumer", { skip: !enabled }, async () => {
  const client = createClient({
    url: process.env.REDIS_URL || "redis://127.0.0.1:6379",
    socket: { reconnectStrategy: () => false }
  });
  client.on("error", () => {});
  await client.connect();
  const store = new RedisTtlReplayStore(client, `mse-integration-ttl:${crypto.randomUUID()}`);
  const jti = uniqueJti();
  try {
    const expiry = Math.floor(Date.now() / 1000) + 60;
    const results = await Promise.all(
      Array.from({ length: 100 }, () => store.consume(jti, expiry))
    );
    assert.equal(results.filter((result) => result.outcome === "accepted").length, 1);
    assert.equal(results.filter((result) => result.outcome === "replay_detected").length, 99);
    assert.ok(results.find((result) => result.outcome === "accepted").ttlMs > 0);
  } finally {
    await client.del(store.keyFor(jti));
    await client.quit();
  }
});

test("native MySQL INSERT admits exactly one concurrent consumer", { skip: !enabled }, async () => {
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    database: process.env.MYSQL_DATABASE || "mse",
    user: process.env.MYSQL_USER || "mse_runner",
    password: process.env.MYSQL_PASSWORD || "",
    connectionLimit: 20,
    connectTimeout: 5000
  });
  const store = new MySQLReplayStore(pool);
  const jti = uniqueJti();
  const hash = crypto.createHash("sha256").update(jti).digest("hex");
  try {
    await store.initialize();
    const expiry = Math.floor(Date.now() / 1000) + 60;
    const results = await Promise.all(
      Array.from({ length: 100 }, () => store.consume(jti, expiry))
    );
    assert.equal(results.filter((result) => result.outcome === "accepted").length, 1);
    assert.equal(results.filter((result) => result.outcome === "replay_detected").length, 99);
  } finally {
    await pool.execute("DELETE FROM consumed_tokens WHERE jti_hash = ?", [hash]);
    await pool.end();
  }
});
