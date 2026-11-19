import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createClientKey, createProof, MemoryReplayStore } from '../src/dpop.js';
import { createResourceServer } from '../src/server.js';

test('HTTP token endpoint binds the key and protected operation is executed once per proof',async(t)=>{
  const secret=new TextEncoder().encode('test-only-secret-at-least-32-bytes-long');
  const app=createResourceServer({secret,resourceStore:new MemoryReplayStore()});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  const key=await createClientKey();
  const tokenProof=await createProof(key,{method:'POST',url:`${origin}/token`});
  const tokenResponse=await fetch(`${origin}/token`,{method:'POST',headers:{DPoP:tokenProof}});
  assert.equal(tokenResponse.status,200);
  const tokenBody=await tokenResponse.json();
  assert.equal(tokenBody.token_type,'DPoP');assert.ok(tokenBody.access_token);

  const proof=await createProof(key,{method:'POST',url:`${origin}/orders?trace=ignored`,token:tokenBody.access_token});
  const send=(dpop)=>fetch(`${origin}/orders?trace=ignored`,{method:'POST',headers:{Authorization:`DPoP ${tokenBody.access_token}`,DPoP:dpop}});
  assert.equal((await send(proof)).status,201);
  assert.equal((await send(proof)).status,401);
  const newProof=await createProof(key,{method:'POST',url:`${origin}/orders`,token:tokenBody.access_token});
  assert.equal((await send(newProof)).status,201);
  const wrongMethod=await createProof(key,{method:'GET',url:`${origin}/orders`,token:tokenBody.access_token});
  assert.equal((await send(wrongMethod)).status,401);
  assert.equal(app.protectedOperations,2);
});
