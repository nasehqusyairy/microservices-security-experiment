import { createClientKey, createProof } from './dpop.js';
import { pathToFileURL } from 'node:url';

export async function runDpopClient(origin,{method='POST',path='/orders'}={}){
  const key=await createClientKey();
  const tokenUrl=new URL('/token',origin).href;
  const tokenProof=await createProof(key,{method:'POST',url:tokenUrl});
  const tokenResponse=await fetch(tokenUrl,{method:'POST',headers:{DPoP:tokenProof}});
  if(!tokenResponse.ok)throw new Error(`token endpoint returned HTTP ${tokenResponse.status}`);
  const {access_token:token}=await tokenResponse.json();
  const resourceUrl=new URL(path,origin).href;
  const proof=await createProof(key,{method,url:resourceUrl,token});
  const response=await fetch(resourceUrl,{method,headers:{Authorization:`DPoP ${token}`,DPoP:proof}});
  return {status:response.status,body:await response.json()};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const origin=process.argv[2]||'http://127.0.0.1:3000';
  runDpopClient(origin).then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1});
}
