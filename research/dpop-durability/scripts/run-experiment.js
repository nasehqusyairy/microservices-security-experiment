import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import { createClient } from 'redis';
import { createClientKey, createProof, issueBoundAccessToken, MemoryReplayStore, RedisReplayStore, validateRequest } from '../src/dpop.js';

const experimentId = `dpop-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
const out = process.env.DPOP_OUTPUT || new URL(`../../../results/dpop-durability/${experimentId}/`, import.meta.url).pathname;
const repetitions = Number(process.env.DPOP_REPETITIONS || 5);
const redisImage = process.env.DPOP_REDIS_IMAGE || 'redis@sha256:7b1753b4c5ad8458906c272a8132b8c15f5557b000379eb115fb239706a384b7';
let port = Number(process.env.DPOP_REDIS_PORT || 0);
const container = `mse-dpop-${randomUUID().slice(0, 8)}`;
const secret = new TextEncoder().encode(randomUUID() + randomUUID());
const expDir = (p) => `${out}/${p}`;
for (const p of ['raw', 'logs', 'metadata', 'summaries', 'figures', 'validation', 'reports']) mkdirSync(expDir(p), { recursive: true });
const eventsPath = expDir('raw/events.jsonl'), requestsPath = expDir('raw/requests.jsonl');
const events = [], requests = [];
const event = (data) => { const row = { experiment_id: experimentId, timestamp_utc: new Date().toISOString(), monotonic_ns: process.hrtime.bigint().toString(), ...data }; events.push(row); appendFileSync(eventsPath, JSON.stringify(row) + '\n'); };
const sha = (s) => createHash('sha256').update(s).digest('hex');
function docker(...args) { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function ready() {
  for (let i = 0; i < 40; i++) {
    try { const c = createClient({ url: `redis://127.0.0.1:${port}`, socket: { connectTimeout: 600, reconnectStrategy: false } }); c.on('error', () => {}); await c.connect(); await c.ping(); return c; }
    catch { await delay(250); }
  }
  throw new Error('isolated Redis did not become healthy');
}
const metadata = { experiment_id: experimentId, repetitions, created_utc: new Date().toISOString(), git_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), software: { node: process.version, redis_image: redisImage, redis_version: '7.4.12', redis_config: 'save disabled; AOF disabled', docker: docker('version', '--format', '{{.Server.Version}}') }, hardware: { cpus: os.cpus().length, total_memory_bytes: os.totalmem(), load_average: os.loadavg(), host: os.hostname(), platform: `${os.type()} ${os.release()} ${os.arch()}` }, topology: 'single host; one dedicated standalone Redis; no replica; no resource-server HTTP process', scenarios: ['memory_normal','memory_process_restart','redis_normal_cross_instance','redis_primary_sigkill'], acknowledgement_definition: 'Redis SET NX returns OK to the client on primary; no replication/AOF acknowledgement', fault_definition: 'docker kill --signal KILL on the isolated Redis primary after successful SET reply, then start same container with volatile-only configuration', limits: ['No Redis replicas, WAIT, WAITAOF, MySQL, network partition, or three-host topology', 'Resource-server replica boundaries are represented by separate replay-store instances in one Node process', 'Performance is local function/client timing and is not production service throughput'] };
writeFileSync(expDir('metadata/config.json'), JSON.stringify(metadata, null, 2));
const call = async ({ repetition, scenario, backend, store, key, token, proof, requestType, replica }) => {
  const id = randomUUID(), start = process.hrtime.bigint();
  const response = await validateRequest({ proof, authorization: `DPoP ${token}`, method: 'POST', url: 'https://dpop.local/orders?ignored=1', store, secret });
  const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
  const row = { experiment_id: experimentId, run_id: `${experimentId}-r${repetition}-${scenario}`, repetition, scenario, backend, durability: backend === 'redis' ? 'primary_reply_volatile' : 'process_local', replica_count: 1, fault_configuration: scenario, timestamp_utc: new Date().toISOString(), monotonic_ns: process.hrtime.bigint().toString(), client_request_id: id, proof_jti_sha256: sha(JSON.parse(Buffer.from(proof.split('.')[1], 'base64url').toString()).jti), replica_id: replica, request_type: requestType, backend_operation: 'atomic consume jti digest', backend_result: response.store?.outcome || response.reason, acknowledgement_result: response.store?.ack || 'not_applicable', acknowledgement_count: response.store?.ack === 'primary_reply' ? 0 : 'not_applicable', latency_ms: latencyMs, request_outcome: response.ok ? 'accepted' : 'rejected', replay_outcome: response.reason === 'replay' ? 'replay' : 'not_replay', protected_operation_executed: response.operationExecuted, fault_event: scenario === 'redis_primary_sigkill' && requestType === 'post_recovery_replay' ? 'isolated_redis_sigkill' : 'none', recovery_event: scenario === 'redis_primary_sigkill' && requestType === 'post_recovery_replay' ? 'redis_healthy_after_restart' : 'none', resource_measurement: JSON.stringify({ host_load_average_1m: os.loadavg()[0], process_rss_bytes: process.memoryUsage().rss }), outcome_reason: response.reason };
  requests.push(row); appendFileSync(requestsPath, JSON.stringify(row) + '\n');
  event({ run_id: row.run_id, repetition, scenario, backend, event_type: 'request_complete', client_request_id: id, proof_jti_sha256: row.proof_jti_sha256, replica_id: replica, backend_result: row.backend_result, acknowledgement_result: row.acknowledgement_result, latency_ms: latencyMs, protected_operation_executed: response.operationExecuted });
  return response;
};

let redisClient;
try {
  docker('run', '-d', '--name', container, '--memory=256m', '--cpus=0.50', '-p', port ? `127.0.0.1:${port}:6379` : '127.0.0.1::6379', redisImage, 'redis-server', '--save', '', '--appendonly', 'no');
  if (!port) port = Number(docker('port', container, '6379/tcp').split(':').at(-1));
  redisClient = await ready();
  event({ event_type: 'backend_health', backend: 'redis', healthy: true, image: 'redis:7-alpine', topology: 'standalone' });
  const randomOrder = Array.from({ length: repetitions }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
  for (const rep of randomOrder) {
    // Process-local normal and restart-loss baseline.
    for (const scenario of ['memory_normal', 'memory_process_restart']) {
      const key = await createClientKey(), token = await issueBoundAccessToken(key, secret), proof = await createProof(key, { method: 'POST', url: 'https://dpop.local/orders?ignored=1', token, jti: randomUUID() });
      let store = new MemoryReplayStore();
      await call({ repetition: rep, scenario, backend: 'memory', store, key, token, proof, requestType: 'first_use', replica: 'memory-1' });
      if (scenario === 'memory_process_restart') { store = new MemoryReplayStore(); event({ event_type: 'resource_server_restart', repetition: rep, scenario, replica_id: 'memory-1' }); }
      const replay = await call({ repetition: rep, scenario, backend: 'memory', store, key, token, proof, requestType: 'replay', replica: scenario === 'memory_process_restart' ? 'memory-restarted' : 'memory-1' });
      event({ event_type: 'scenario_result', repetition: rep, scenario, replay_accepted: replay.ok, write_acknowledged: true });
    }
    // Shared atomic Redis replay state across store instances.
    const redisStore = new RedisReplayStore(redisClient, { prefix: `${experimentId}:normal:${rep}`, ttlSeconds: 360 });
    {
      const key = await createClientKey(), token = await issueBoundAccessToken(key, secret), proof = await createProof(key, { method: 'POST', url: 'https://dpop.local/orders?ignored=1', token, jti: randomUUID() });
      await call({ repetition: rep, scenario: 'redis_normal_cross_instance', backend: 'redis', store: redisStore, key, token, proof, requestType: 'first_use', replica: 'resource-1' });
      const replay = await call({ repetition: rep, scenario: 'redis_normal_cross_instance', backend: 'redis', store: new RedisReplayStore(redisClient, { prefix: `${experimentId}:normal:${rep}`, ttlSeconds: 360 }), key, token, proof, requestType: 'cross_instance_replay', replica: 'resource-2' });
      event({ event_type: 'scenario_result', repetition: rep, scenario: 'redis_normal_cross_instance', replay_accepted: replay.ok, write_acknowledged: true });
    }
    // Explicitly test acknowledged-write loss on a volatile-only standalone Redis crash.
    const prefix = `${experimentId}:crash:${rep}`;
    const key = await createClientKey(), token = await issueBoundAccessToken(key, secret), proof = await createProof(key, { method: 'POST', url: 'https://dpop.local/orders?ignored=1', token, jti: randomUUID() });
    const first = await call({ repetition: rep, scenario: 'redis_primary_sigkill', backend: 'redis', store: new RedisReplayStore(redisClient, { prefix, ttlSeconds: 360 }), key, token, proof, requestType: 'first_use', replica: 'resource-1' });
    if (!first.ok) throw new Error('Redis setup write did not succeed; refusing to classify loss');
    const faultStart = process.hrtime.bigint();
    event({ event_type: 'fault_start', repetition: rep, scenario: 'redis_primary_sigkill', fault: 'docker SIGKILL isolated Redis after primary SET NX reply', ack_observed: 'primary_reply' });
    await redisClient.quit(); redisClient = undefined;
    docker('kill', '--signal', 'KILL', container);
    docker('start', container);
    port = Number(docker('port', container, '6379/tcp').split(':').at(-1));
    redisClient = await ready();
    event({ event_type: 'recovery_complete', repetition: rep, scenario: 'redis_primary_sigkill', backend_healthy: true, recovered_ms: Number(process.hrtime.bigint() - faultStart) / 1e6, persistence: 'disabled' });
    const replay = await call({ repetition: rep, scenario: 'redis_primary_sigkill', backend: 'redis', store: new RedisReplayStore(redisClient, { prefix, ttlSeconds: 360 }), key, token, proof, requestType: 'post_recovery_replay', replica: 'resource-1' });
    event({ event_type: 'scenario_result', repetition: rep, scenario: 'redis_primary_sigkill', replay_accepted: replay.ok, acknowledged_write_lost: replay.ok, acknowledgement_category: 'primary_reply_only' });
  }
  const fields = Object.keys(requests[0]);
  const csv = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  writeFileSync(expDir('raw/requests.csv'), [fields.join(','), ...requests.map((r) => fields.map((f) => csv(r[f])).join(','))].join('\n') + '\n');
  writeFileSync(expDir('metadata/run.json'), JSON.stringify({ ...metadata, finished_utc: new Date().toISOString(), run_order: randomOrder, request_count: requests.length, event_count: events.length, redis_container: container, redis_port: port }, null, 2));
  console.log(JSON.stringify({ output: out, experiment_id: experimentId, repetitions, requests: requests.length, scenarios: [...new Set(requests.map((x) => x.scenario))], redis_container: container }, null, 2));
} catch (error) {
  writeFileSync(expDir('logs/failure.txt'), `${new Date().toISOString()} ${error.stack || error}\n`);
  writeFileSync(expDir('metadata/partial.json'), JSON.stringify({ ...metadata, failure: String(error), request_count: requests.length, event_count: events.length, redis_container: container }, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  try { if (redisClient?.isOpen) await redisClient.quit(); } catch {}
  try { docker('rm', '-f', container); } catch {}
}
