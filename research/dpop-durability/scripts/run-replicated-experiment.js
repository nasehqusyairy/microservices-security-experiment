import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID, randomInt, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import { createClient } from 'redis';
import { createClientKey, createProof, issueBoundAccessToken, RedisReplayStore, RedisWaitReplayStore, RedisWaitAofReplayStore, validateRequest } from '../src/dpop.js';

const id = `dpop-repl-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
const root = process.env.DPOP_OUTPUT || new URL(`../../../results/dpop-durability/${id}/`, import.meta.url).pathname;
const repetitions = Number(process.env.DPOP_REPETITIONS || 5), secret = new TextEncoder().encode(randomUUID() + randomUUID());
const redisImage = process.env.DPOP_REDIS_IMAGE || 'redis@sha256:7b1753b4c5ad8458906c272a8132b8c15f5557b000379eb115fb239706a384b7';
for (const d of ['raw', 'logs', 'metadata', 'summaries', 'figures', 'validation', 'reports']) mkdirSync(`${root}/${d}`, { recursive: true });
const eventsFile = `${root}/raw/events.jsonl`, requestsFile = `${root}/raw/requests.jsonl`, events = [], requests = [];
let activeContainers = [], activeNetwork, client;
const event = (x) => { const r = { experiment_id: id, timestamp_utc: new Date().toISOString(), monotonic_ns: process.hrtime.bigint().toString(), ...x }; events.push(r); appendFileSync(eventsFile, JSON.stringify(r) + '\n') };
const sh = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const digest = (s) => createHash('sha256').update(s).digest('hex');
async function connect(endpoint) {
  const address = String(endpoint).includes(':') ? String(endpoint) : `127.0.0.1:${endpoint}`;
  const c = createClient({ url: `redis://${address}`, socket: { connectTimeout: 800, reconnectStrategy: false } }); c.on('error', () => { });
  for (let i = 0; i < 50; i++) { try { if (!c.isOpen) await c.connect(); await c.ping(); return c } catch { await delay(100) } }
  throw new Error(`Redis not healthy on mapped port ${port}`);
}
const hostPort = (name) => Number(sh('port', name, '6379/tcp').split(':').at(-1));
async function waitInfo(c, predicate, desc) { for (let i = 0; i < 80; i++) { try { const info = await c.info('replication'); if (predicate(info)) return info } catch { } await delay(100) } throw new Error(`timed out waiting for ${desc}`) }
function startRedis(name, alias, net, { aof = false, replica = false } = {}) {
  const args = ['run', '-d', '--name', name, '--memory=128m', '--cpus=0.25', '--network', net, '--network-alias', alias, '-p', '127.0.0.1::6379', redisImage, 'redis-server', '--save', '', '--appendonly', aof ? 'yes' : 'no'];
  if (aof) args.push('--appendfsync', 'always');
  if (replica) args.push('--replicaof', 'dpop-primary', '6379');
  sh(...args); activeContainers.push(name); return hostPort(name);
}
async function recordRequest({ rep, scenario, backend, replica, store, proof, token, kind }) {
  const requestId = randomUUID(), t0 = process.hrtime.bigint();
  const result = await validateRequest({ proof, authorization: `DPoP ${token}`, method: 'POST', url: 'https://dpop.local/orders', store, secret });
  const latency = Number(process.hrtime.bigint() - t0) / 1e6, jti = JSON.parse(Buffer.from(proof.split('.')[1], 'base64url').toString()).jti;
  const r = { experiment_id: id, run_id: `${id}-r${rep}-${scenario}`, repetition: rep, scenario, backend, durability: backend, replica_count: 2, fault_configuration: scenario, timestamp_utc: new Date().toISOString(), monotonic_ns: process.hrtime.bigint().toString(), client_request_id: requestId, proof_jti_sha256: digest(jti), replica_id: replica, request_type: kind, backend_operation: 'SET NX EX + configured acknowledgement', backend_result: result.store?.outcome || result.reason, acknowledgement_result: result.store?.ack || 'not_applicable', acknowledgement_count: result.store?.acknowledgementCount ?? (result.store?.ack === 'waitaof' ? result.store.replicaAof : (result.store?.ack === 'primary_reply' ? 0 : 'not_applicable')), local_aof_ack_count: result.store?.localAof ?? 'not_applicable', required_acknowledgement: result.store?.ack === 'waitaof' ? `local=${result.store.requiredLocal},replica=${result.store.requiredReplicas}` : (result.store?.required ?? result.store?.requiredReplicas ?? 'primary_reply'), latency_ms: latency, request_outcome: result.ok ? 'accepted' : 'rejected', replay_outcome: result.reason === 'replay' ? 'replay' : 'not_replay', protected_operation_executed: result.operationExecuted, fault_event: 'none', recovery_event: 'none', resource_measurement: JSON.stringify({ host_load_average_1m: os.loadavg()[0], runner_rss_bytes: process.memoryUsage().rss }), outcome_reason: result.reason };
  requests.push(r); appendFileSync(requestsFile, JSON.stringify(r) + '\n'); event({ run_id: r.run_id, repetition: rep, scenario, event_type: 'request_complete', client_request_id: requestId, proof_jti_sha256: r.proof_jti_sha256, replica_id: replica, backend_result: r.backend_result, acknowledgement_result: r.acknowledgement_result, acknowledgement_count: r.acknowledgement_count, latency_ms: latency, protected_operation_executed: result.operationExecuted }); return result;
}
const baseMeta = { experiment_id: id, created_utc: new Date().toISOString(), repetitions, git_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version, docker: sh('version', '--format', '{{.Server.Version}}'), redis_image: redisImage, redis_version: '7.4.12', redis_image_digest: 'sha256:7b1753b4c5ad8458906c272a8132b8c15f5557b000379eb115fb239706a384b7', hardware: { cpus: os.cpus().length, total_memory_bytes: os.totalmem(), platform: `${os.type()} ${os.release()} ${os.arch()}` }, topology: 'single Linux host; isolated two-node Redis primary/replica containers; manually promoted replica; not Sentinel/Cluster; application verifier in Node runner', acknowledgement_semantics: { primary_only: 'SET NX returns OK; no replica confirmation', wait: 'SET then WAIT 1 1500 on same Redis connection; check actual replica count', wait_insufficient: 'replica detached; WAIT 1 250 returns actual count, fail closed unless >=1', waitaof: 'AOF enabled with appendfsync always on both nodes; SET then WAITAOF 1 1 2000 on same connection; check local and replica counts' }, fault: 'docker SIGKILL primary after recorded acknowledgement; manually promote the only replica with REPLICAOF NO ONE; replay identical proof to promoted replica', limitations: ['same-host replication and shared kernel/storage', 'no Sentinel or Redis Cluster automatic failover', 'no real network partition; replication is administratively detached for primary-only/insufficient-ack cases', 'no MySQL or three resource-service processes'] };
writeFileSync(`${root}/metadata/config.json`, JSON.stringify(baseMeta, null, 2));
const scenarios = ['primary_only_detached', 'wait_replica_acked', 'wait_ack_insufficient', 'waitaof_local_replica_acked'];

try {
  const runOrder = [];
  for (let rep = 1; rep <= repetitions; rep++) {
    const ordered = [...scenarios]; for (let i = ordered.length - 1; i > 0; i--) { const j = randomInt(i + 1);[ordered[i], ordered[j]] = [ordered[j], ordered[i]]; } runOrder.push({ repetition: rep, scenarios: ordered });
    for (const scenario of ordered) {
      const net = `${id}-${rep}-${scenario}`.slice(0, 63), primary = `${net}-p`, replica = `${net}-r`;
      activeNetwork = net; sh('network', 'create', net);
      const isAof = scenario === 'waitaof_local_replica_acked';
      const pPort = startRedis(primary, 'dpop-primary', net, { aof: isAof });
      const rPort = startRedis(replica, 'dpop-replica', net, { aof: isAof, replica: true });
      let pc = await connect(pPort), rc = await connect(rPort);
      await waitInfo(rc, x => x.includes('master_link_status:up') && x.includes('master_sync_in_progress:0'), 'replica synchronization');
      event({ repetition: rep, scenario, event_type: 'backend_health', primary_healthy: true, replica_healthy: true, replication_link: 'up', aof: isAof, appendfsync: isAof ? 'always' : 'not_enabled' });
      if (scenario === 'primary_only_detached' || scenario === 'wait_ack_insufficient') {
        if (rc.isOpen) await rc.quit(); rc = undefined;
        sh('network', 'disconnect', net, replica);
        // Drop the existing TCP replication session after the peer is isolated;
        // this makes the controlled link fault observable without waiting for
        // kernel TCP timeout while the replica remains in replica role.
        sh('exec', replica, 'redis-cli', 'client', 'kill', 'type', 'master');
        let replicaStatus = '';
        for (let n = 0; n < 80; n++) { try { replicaStatus = sh('exec', replica, 'redis-cli', 'info', 'replication'); if (replicaStatus.includes('role:slave') && replicaStatus.includes('master_link_status:down')) break } catch { } await delay(100) }
        if (!replicaStatus.includes('role:slave') || !replicaStatus.includes('master_link_status:down')) throw new Error('replica link was not verified down after network detach');
        event({ repetition: rep, scenario, event_type: 'replication_detached', mechanism: 'docker network disconnect replica and close replication session', replica_role: 'slave', replica_link_status: 'down', network_partition: false });
      }
      const key = await createClientKey(), token = await issueBoundAccessToken(key, secret), proof = await createProof(key, { method: 'POST', url: 'https://dpop.local/orders', token, jti: randomUUID() });
      const prefix = `${id}:${rep}:${scenario}`;
      let store;
      if (scenario === 'wait_replica_acked' || scenario === 'wait_ack_insufficient') store = new RedisWaitReplayStore(pc, { prefix, ttlSeconds: 360, requiredReplicas: 1, timeoutMs: scenario === 'wait_ack_insufficient' ? 250 : 1500 });
      else if (isAof) store = new RedisWaitAofReplayStore(pc, { prefix, ttlSeconds: 360, requiredLocal: 1, requiredReplicas: 1, timeoutMs: 2000 });
      else store = new RedisReplayStore(pc, { prefix, ttlSeconds: 360 });
      const first = await recordRequest({ rep, scenario, backend: scenario, replica: 'primary', store, proof, token, kind: 'first_use' });
      if (scenario === 'primary_only_detached' && !first.ok) throw new Error('primary-only write did not receive primary acknowledgement');
      if (scenario === 'wait_replica_acked' && (!first.ok || first.store.acknowledgementCount < 1)) throw new Error('WAIT did not meet the required replica acknowledgement');
      if (scenario === 'wait_ack_insufficient' && (first.ok || first.reason !== 'acknowledgement_insufficient' || first.operationExecuted)) throw new Error('insufficient WAIT acknowledgement did not fail closed');
      if (isAof && (!first.ok || first.store.localAof < 1 || first.store.replicaAof < 1)) throw new Error('WAITAOF did not meet local and replica fsync acknowledgement requirements');
      event({ repetition: rep, scenario, event_type: 'acknowledgement_observed', acknowledgement_result: first.store?.ack || 'primary_reply', acknowledgement_count: first.store?.acknowledgementCount ?? 0, acknowledged_write: !!first.ok, operation_executed: first.operationExecuted });
      const faultStart = process.hrtime.bigint(); event({ repetition: rep, scenario, event_type: 'fault_start', fault: 'SIGKILL primary after acknowledgement result', acknowledgement_result: first.store?.ack || 'primary_reply' });
      if (pc.isOpen) await pc.quit(); if (rc?.isOpen) await rc.quit(); pc = undefined; rc = undefined;
      sh('kill', '--signal', 'KILL', primary);
      event({ repetition: rep, scenario, event_type: 'primary_sigkill_completed', container: primary, exit_status: 'docker kill succeeded' });
      if (scenario === 'primary_only_detached' || scenario === 'wait_ack_insufficient') {
        sh('network', 'connect', '--alias', 'dpop-replica', net, replica);
        event({ repetition: rep, scenario, event_type: 'replica_network_restored', replica_container: replica });
      }
      const replicaIp = scenario === 'primary_only_detached' || scenario === 'wait_ack_insufficient' ? sh('inspect', '--format', `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, replica) : null;
      const promoted = await connect(replicaIp ? `${replicaIp}:6379` : rPort); await promoted.sendCommand(['REPLICAOF', 'NO', 'ONE']);
      await waitInfo(promoted, x => x.includes('role:master'), 'manual replica promotion');
      const recoveryMs = Number(process.hrtime.bigint() - faultStart) / 1e6;
      event({ repetition: rep, scenario, event_type: 'recovery_complete', backend_healthy: true, promoted_replica: 'replica', recovery_ms: recoveryMs, promotion: 'manual REPLICAOF NO ONE' });
      const replayStore = new RedisReplayStore(promoted, { prefix, ttlSeconds: 360 });
      const replay = await recordRequest({ rep, scenario, backend: scenario, replica: 'promoted-replica', store: replayStore, proof, token, kind: 'post_failover_replay' });
      const lost = !!first.store && first.store.outcome === 'FIRST_USE' && replay.ok;
      event({ repetition: rep, scenario, event_type: 'scenario_result', replay_accepted: replay.ok, acknowledged_write_lost: lost, first_acknowledged: first.store?.outcome === 'FIRST_USE', protected_operations: (first.operationExecuted ? 1 : 0) + (replay.operationExecuted ? 1 : 0) });
      if (promoted.isOpen) await promoted.quit();
      client = undefined; activeContainers = []; sh('rm', '-f', primary, replica); sh('network', 'rm', net); activeNetwork = undefined;
    }
  }
  const headers = Object.keys(requests[0]), quote = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
  writeFileSync(`${root}/raw/requests.csv`, [headers.join(','), ...requests.map(r => headers.map(k => quote(r[k])).join(','))].join('\n') + '\n');
  const runMeta = { ...baseMeta, finished_utc: new Date().toISOString(), request_count: requests.length, event_count: events.length, scenarios, run_order: runOrder };
  writeFileSync(`${root}/metadata/run.json`, JSON.stringify(runMeta, null, 2));
  console.log(JSON.stringify({ output: root, experiment_id: id, repetitions, requests: requests.length, scenarios }, null, 2));
} catch (e) {
  for (const name of activeContainers) { try { const logs = execFileSync('docker', ['logs', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); appendFileSync(`${root}/logs/docker-${name}.log`, logs) } catch { } }
  writeFileSync(`${root}/logs/failure.txt`, `${new Date().toISOString()} ${e.stack || e}\n`);
  writeFileSync(`${root}/metadata/partial.json`, JSON.stringify({ ...baseMeta, failure: String(e), request_count: requests.length, event_count: events.length }, null, 2)); console.error(e); process.exitCode = 1;
} finally {
  try { if (client?.isOpen) await client.quit() } catch { }
  for (const name of activeContainers) { try { sh('rm', '-f', name) } catch { } }
  if (activeNetwork) try { sh('network', 'rm', activeNetwork) } catch { }
}
