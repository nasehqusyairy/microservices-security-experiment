import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientKey, createProof, issueBoundAccessToken, MemoryReplayStore, validateRequest } from '../src/dpop.js';

const secret = new TextEncoder().encode('test-only-secret-at-least-32-bytes-long');
const method = 'POST';
const url = 'https://api.example.test/orders?trace=abc';
async function fixture({ key, claims = {}, tokenKey, token: suppliedToken, jti } = {}) {
  key ||= await createClientKey();
  const token = suppliedToken || await issueBoundAccessToken(tokenKey || key, secret);
  const proof = await createProof(key, { method, url, token, ...(jti ? { jti } : {}), changes: claims });
  return { key, token, proof };
}
const check = (f, store = new MemoryReplayStore(), options = {}) => validateRequest({ proof: f.proof, authorization: `DPoP ${f.token}`, method, url, store, secret, ...options });

test('accepts a valid proof, rejects identical proof and permits a new proof', async () => {
  const f = await fixture(), store = new MemoryReplayStore();
  assert.equal((await check(f, store)).ok, true);
  assert.equal((await check(f, store)).reason, 'replay');
  const next = await fixture({ key: f.key, token: f.token });
  assert.equal((await check(next, store)).ok, true);
});
test('rejects same jti even when represented by a newly signed proof', async () => {
  const f = await fixture({ jti: 'same-jti' }), store = new MemoryReplayStore();
  assert.equal((await check(f, store)).ok, true);
  const g = await fixture({ key: f.key, token: f.token, jti: 'same-jti' });
  assert.equal((await check(g, store)).reason, 'replay');
});
test('rejects a modified signature', async () => {
  const f = await fixture(); f.proof = `${f.proof.slice(0, -1)}${f.proof.endsWith('A') ? 'B' : 'A'}`;
  assert.equal((await check(f)).reason, 'invalid_proof_signature');
});
test('rejects wrong htm and htu', async () => {
  const f = await fixture({ claims: { htm: 'GET' } });
  assert.equal((await check(f)).reason, 'wrong_method');
  const g = await fixture({ claims: { htu: 'https://api.example.test/elsewhere' } });
  assert.equal((await check(g)).reason, 'wrong_uri');
});
test('rejects stale and future iat', async () => {
  const old = await fixture({ claims: { iat: Math.floor(Date.now() / 1000) - 400 } });
  assert.equal((await check(old)).reason, 'invalid_iat');
  const future = await fixture({ claims: { iat: Math.floor(Date.now() / 1000) + 60 } });
  assert.equal((await check(future)).reason, 'invalid_iat');
});
test('rejects incorrect ath', async () => {
  const f = await fixture({ claims: { ath: 'wrong' } });
  assert.equal((await check(f)).reason, 'wrong_ath');
});
test('rejects an access token bound to a different key', async () => {
  const other = await createClientKey();
  const f = await fixture({ tokenKey: other });
  assert.equal((await check(f)).reason, 'key_binding_mismatch');
});
test('requires DPoP authorization and does not consume state for malformed traffic', async () => {
  const f = await fixture(), store = new MemoryReplayStore();
  assert.equal((await validateRequest({ proof: f.proof, authorization: `Bearer ${f.token}`, method, url, store, secret })).reason, 'authorization_scheme');
  assert.equal((await validateRequest({ proof: 'garbage', authorization: `DPoP ${f.token}`, method, url, store, secret })).ok, false);
  assert.equal((await check(f, store)).ok, true);
});
test('concurrent identical requests execute the protected operation at most once', async () => {
  const f = await fixture(), store = new MemoryReplayStore();
  const results = await Promise.all(Array.from({ length: 32 }, () => check(f, store)));
  assert.equal(results.filter((x) => x.ok).length, 1);
  assert.equal(results.filter((x) => x.reason === 'replay').length, 31);
  assert.equal(results.filter((x) => x.operationExecuted).length, 1);
});
