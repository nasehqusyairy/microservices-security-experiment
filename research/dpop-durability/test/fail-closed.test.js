import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientKey, createProof, issueBoundAccessToken, MemoryReplayStore, validateRequest } from '../src/dpop.js';

test('rejected proofs and replay-store errors never execute the protected operation', async () => {
  const secret = new TextEncoder().encode('test-only-secret-at-least-32-bytes-long');
  const key = await createClientKey();
  const token = await issueBoundAccessToken(key, secret);
  const proof = await createProof(key, { method: 'POST', url: 'https://api.example.test/orders', token });
  const base = { proof, method: 'POST', url: 'https://api.example.test/orders', secret };
  const missing = await validateRequest({ ...base, authorization: '', store: new MemoryReplayStore() });
  assert.equal(missing.operationExecuted, false);
  const down = await validateRequest({ ...base, authorization: `dpop ${token}`, store: { consume: async () => ({ outcome: 'STORE_ERROR', error: 'offline' }) } });
  assert.equal(down.reason, 'store_error');
  assert.equal(down.operationExecuted, false);
  const accepted = await validateRequest({ ...base, authorization: `DPoP ${token}`, store: new MemoryReplayStore() });
  assert.equal(accepted.operationExecuted, true);
});
