import test from 'node:test';
import assert from 'node:assert/strict';
import { RedisWaitReplayStore, RedisWaitAofReplayStore } from '../src/dpop.js';

function clientWith(responses) {
  const calls=[];
  return { calls, on(){}, async set(...args){calls.push(['SET',...args]);return 'OK'}, async sendCommand(args){calls.push(args);return responses.shift()} };
}
test('WAIT follows SET on the same connection and distinguishes insufficient acknowledgements', async()=>{
  const c=clientWith([0]);const store=new RedisWaitReplayStore(c,{prefix:'test',requiredReplicas:1,timeoutMs:250});
  const r=await store.consume('jti');
  assert.deepEqual(c.calls.map(x=>x[0]),['SET','WAIT']);
  assert.equal(r.outcome,'ACKNOWLEDGEMENT_INSUFFICIENT');assert.equal(r.acknowledgementCount,0);
});
test('WAIT returns FIRST_USE only after required replica acknowledgement', async()=>{
  const c=clientWith([1]);const r=await new RedisWaitReplayStore(c,{prefix:'test'}).consume('jti');
  assert.equal(r.outcome,'FIRST_USE');assert.equal(r.acknowledgementCount,1);
});
test('WAITAOF requires both local and replica AOF acknowledgement', async()=>{
  const c=clientWith([[1,0]]);const r=await new RedisWaitAofReplayStore(c,{prefix:'test'}).consume('jti');
  assert.deepEqual(c.calls.map(x=>x[0]),['SET','WAITAOF']);assert.equal(r.outcome,'ACKNOWLEDGEMENT_INSUFFICIENT');
  const ok=clientWith([[1,1]]);const success=await new RedisWaitAofReplayStore(ok,{prefix:'test'}).consume('jti');
  assert.equal(success.outcome,'FIRST_USE');assert.equal(success.localAof,1);assert.equal(success.replicaAof,1);
});
