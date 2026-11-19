import { createClient } from 'redis';
import { createResourceServer } from '../src/server.js';
import { MemoryReplayStore, RedisReplayStore } from '../src/dpop.js';

const secret=process.env.DPOP_TOKEN_SECRET;
if(!secret||secret.length<32)throw new Error('Set DPOP_TOKEN_SECRET to at least 32 characters.');
let store=new MemoryReplayStore(),redis;
if(process.env.REDIS_URL){
  redis=createClient({url:process.env.REDIS_URL,socket:{reconnectStrategy:false}});redis.on('error',()=>{});await redis.connect();
  store=new RedisReplayStore(redis,{prefix:process.env.DPOP_REPLAY_PREFIX||'mse:dpop:http',ttlSeconds:360});
}
const app=createResourceServer({secret:new TextEncoder().encode(secret),resourceStore:store});
const port=Number(process.env.PORT||3000);
app.server.listen(port,'127.0.0.1',()=>process.stdout.write(`DPoP research server listening on 127.0.0.1:${port}\n`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.server.close(()=>{redis?.quit();process.exit(0)}));
