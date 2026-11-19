import { createHash, randomUUID } from 'node:crypto';
import { calculateJwkThumbprint, compactVerify, decodeProtectedHeader, exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT } from 'jose';

const privateFields = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']);
const b64u = (b) => Buffer.from(b).toString('base64url');
export const accessTokenHash = (token) => b64u(createHash('sha256').update(token, 'ascii').digest());
export const ReplayOutcome = Object.freeze({ FIRST_USE: 'FIRST_USE', REPLAY: 'REPLAY', STORE_ERROR: 'STORE_ERROR', ACKNOWLEDGEMENT_INSUFFICIENT: 'ACKNOWLEDGEMENT_INSUFFICIENT', TIMEOUT: 'TIMEOUT' });
export const canonicalHtu = (value) => {
  const u = new URL(value);
  u.search = '';
  u.hash = '';
  return u.href;
};

export async function createClientKey() {
  const pair = await generateKeyPair('ES256');
  const jwk = await exportJWK(pair.publicKey);
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  return { ...pair, jwk, thumbprint: await calculateJwkThumbprint(jwk) };
}

export async function issueBoundAccessToken(key, secret, { issuer = 'mse-dpop-auth', audience = 'mse-dpop-api', ttlSeconds = 300 } = {}) {
  return new SignJWT({ scope: 'orders:read', cnf: { jkt: key.thumbprint } })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer(issuer).setAudience(audience)
    .setSubject('experiment-client').setJti(randomUUID()).setIssuedAt().setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

export async function createProof(key, { method, url, token, jti = randomUUID(), iat = Math.floor(Date.now() / 1000), changes = {} }) {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk };
  const claims = { jti, iat, htm: method.toUpperCase(), htu: canonicalHtu(url), ...(token ? { ath: accessTokenHash(token) } : {}), ...changes };
  return new SignJWT(claims).setProtectedHeader(header).sign(key.privateKey);
}

export class MemoryReplayStore {
  #used = new Set();
  async consume(id) {
    if (this.#used.has(id)) return { outcome: 'REPLAY' };
    this.#used.add(id);
    return { outcome: 'FIRST_USE', ack: 'process_memory' };
  }
}

export class RedisReplayStore {
  constructor(client, { prefix = 'mse:dpop', ttlSeconds = 360 } = {}) { this.client = client; this.prefix = prefix; this.ttlSeconds = ttlSeconds; this.client.on('error', () => {}); }
  async consume(id) {
    try {
      const digest = createHash('sha256').update(id).digest('hex');
      const result = await this.client.set(`${this.prefix}:${digest}`, '1', { NX: true, EX: this.ttlSeconds });
      return result === 'OK' ? { outcome: 'FIRST_USE', ack: 'primary_reply' } : { outcome: 'REPLAY' };
    } catch (error) { return { outcome: 'STORE_ERROR', error: error.code || 'redis_error' }; }
  }
}

export class RedisWaitReplayStore extends RedisReplayStore {
  constructor(client, options = {}) { super(client, options); this.requiredReplicas = options.requiredReplicas ?? 1; this.timeoutMs = options.timeoutMs ?? 1500; }
  async consume(id) {
    const key = `${this.prefix}:${createHash('sha256').update(id).digest('hex')}`;
    try {
      const inserted = await this.client.set(key, '1', { NX: true, EX: this.ttlSeconds });
      if (inserted !== 'OK') return { outcome: 'REPLAY' };
      const acknowledged = Number(await this.client.sendCommand(['WAIT', String(this.requiredReplicas), String(this.timeoutMs)]));
      if (acknowledged < this.requiredReplicas) return { outcome: 'ACKNOWLEDGEMENT_INSUFFICIENT', ack: 'wait', acknowledgementCount: acknowledged, required: this.requiredReplicas };
      return { outcome: 'FIRST_USE', ack: 'wait', acknowledgementCount: acknowledged, required: this.requiredReplicas };
    } catch (error) { return { outcome: error.name === 'TimeoutError' || error.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'STORE_ERROR', error: error.code || error.name || 'redis_error' }; }
  }
}

export class RedisWaitAofReplayStore extends RedisReplayStore {
  constructor(client, options = {}) { super(client, options); this.requiredLocal = options.requiredLocal ?? 1; this.requiredReplicas = options.requiredReplicas ?? 1; this.timeoutMs = options.timeoutMs ?? 2000; }
  async consume(id) {
    const key = `${this.prefix}:${createHash('sha256').update(id).digest('hex')}`;
    try {
      const inserted = await this.client.set(key, '1', { NX: true, EX: this.ttlSeconds });
      if (inserted !== 'OK') return { outcome: 'REPLAY' };
      const result = await this.client.sendCommand(['WAITAOF', String(this.requiredLocal), String(this.requiredReplicas), String(this.timeoutMs)]);
      const localAof = Number(result[0]), replicaAof = Number(result[1]);
      if (localAof < this.requiredLocal || replicaAof < this.requiredReplicas) return { outcome: 'ACKNOWLEDGEMENT_INSUFFICIENT', ack: 'waitaof', localAof, replicaAof, requiredLocal: this.requiredLocal, requiredReplicas: this.requiredReplicas };
      return { outcome: 'FIRST_USE', ack: 'waitaof', localAof, replicaAof, requiredLocal: this.requiredLocal, requiredReplicas: this.requiredReplicas };
    } catch (error) { return { outcome: error.name === 'TimeoutError' || error.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'STORE_ERROR', error: error.code || error.name || 'redis_error' }; }
  }
}

export async function validateRequest({ proof, authorization, method, url, store, secret, nowSeconds = Math.floor(Date.now() / 1000), maxAgeSeconds = 300 }) {
  const fail = (reason) => ({ ok: false, reason, operationExecuted: false });
  if (typeof proof !== 'string' || !proof) return fail('missing_proof');
  const authMatch = typeof authorization === 'string' ? /^DPoP\s+([^\s]+)$/i.exec(authorization) : null;
  if (!authMatch) return fail('authorization_scheme');
  const token = authMatch[1];
  let access;
  try { access = await jwtVerify(token, secret, { issuer: 'mse-dpop-auth', audience: 'mse-dpop-api', algorithms: ['HS256'] }); }
  catch { return fail('invalid_access_token'); }
  let header, claims, key;
  try {
    header = decodeProtectedHeader(proof);
    if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256' || !header.jwk || Object.keys(header.jwk).some((k) => privateFields.has(k))) return fail('invalid_proof_header');
    key = await importJWK(header.jwk, 'ES256');
    const verified = await compactVerify(proof, key, { algorithms: ['ES256'] });
    claims = JSON.parse(Buffer.from(verified.payload).toString('utf8'));
  } catch { return fail('invalid_proof_signature'); }
  if (!claims.jti || typeof claims.jti !== 'string' || claims.jti.length > 256) return fail('invalid_jti');
  if (claims.htm !== method.toUpperCase()) return fail('wrong_method');
  if (typeof claims.htu !== 'string' || claims.htu !== canonicalHtu(url)) return fail('wrong_uri');
  if (!Number.isInteger(claims.iat) || claims.iat > nowSeconds + 30 || nowSeconds - claims.iat > maxAgeSeconds) return fail('invalid_iat');
  if (claims.ath !== accessTokenHash(token)) return fail('wrong_ath');
  const thumbprint = await calculateJwkThumbprint(header.jwk);
  if (access.payload.cnf?.jkt !== thumbprint) return fail('key_binding_mismatch');
  const consumed = await store.consume(claims.jti);
  if (consumed.outcome === 'REPLAY') return { ok: false, reason: 'replay', operationExecuted: false, store: consumed };
  if (consumed.outcome !== 'FIRST_USE') return { ok: false, reason: consumed.outcome === 'ACKNOWLEDGEMENT_INSUFFICIENT' || consumed.outcome === 'TIMEOUT' ? consumed.outcome.toLowerCase() : 'store_error', operationExecuted: false, store: consumed };
  return { ok: true, reason: 'accepted', operationExecuted: true, store: consumed };
}

export async function validateTokenEndpointProof({ proof, method, url, store, nowSeconds = Math.floor(Date.now() / 1000), maxAgeSeconds = 300 }) {
  const fail=(reason)=>({ok:false,reason});
  if(typeof proof!=='string'||!proof)return fail('missing_proof');
  let header,claims;
  try{
    header=decodeProtectedHeader(proof);
    if(header.typ!=='dpop+jwt'||header.alg!=='ES256'||!header.jwk||Object.keys(header.jwk).some(k=>privateFields.has(k)))return fail('invalid_proof_header');
    const key=await importJWK(header.jwk,'ES256');
    const verified=await compactVerify(proof,key,{algorithms:['ES256']});
    claims=JSON.parse(Buffer.from(verified.payload).toString('utf8'));
  }catch{return fail('invalid_proof_signature');}
  if(!claims.jti||typeof claims.jti!=='string'||claims.jti.length>256)return fail('invalid_jti');
  if(claims.htm!==method.toUpperCase())return fail('wrong_method');
  if(typeof claims.htu!=='string'||claims.htu!==canonicalHtu(url))return fail('wrong_uri');
  if(!Number.isInteger(claims.iat)||claims.iat>nowSeconds+30||nowSeconds-claims.iat>maxAgeSeconds)return fail('invalid_iat');
  if(Object.hasOwn(claims,'ath'))return fail('unexpected_ath');
  const consumed=await store.consume(claims.jti);
  if(consumed.outcome==='REPLAY')return {ok:false,reason:'replay'};
  if(consumed.outcome!=='FIRST_USE')return {ok:false,reason:consumed.outcome==='ACKNOWLEDGEMENT_INSUFFICIENT'||consumed.outcome==='TIMEOUT'?consumed.outcome.toLowerCase():'store_error'};
  return {ok:true,jkt:await calculateJwkThumbprint(header.jwk),claims};
}
