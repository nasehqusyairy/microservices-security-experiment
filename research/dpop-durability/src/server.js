import { createServer as createHttpServer } from 'node:http';
import { issueBoundAccessToken, MemoryReplayStore, validateRequest, validateTokenEndpointProof } from './dpop.js';

const json=(res,status,payload)=>{const body=JSON.stringify(payload);res.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(body),'cache-control':'no-store'});res.end(body)};
const errorStatus=(reason)=>reason==='store_error'||reason==='acknowledgement_insufficient'?503:reason==='timeout'?504:401;

export function createResourceServer({secret,resourceStore,tokenProofStore=new MemoryReplayStore(),accessTokenTtlSeconds=300}={}){
  if(!secret||!resourceStore)throw new Error('secret and resourceStore are required');
  let protectedOperations=0;
  const server=createHttpServer(async(req,res)=>{
    try{
      if(req.method==='GET'&&req.url==='/health')return json(res,200,{healthy:true});
      const rawDpopHeaders=[];
      for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='dpop')rawDpopHeaders.push(req.rawHeaders[i+1]);
      if(rawDpopHeaders.length>1)return json(res,401,{error:'invalid_dpop_proof',reason:'duplicate_dpop_header'});
      const proof=rawDpopHeaders[0];
      const host=req.headers.host;
      if(!host)return json(res,400,{error:'invalid_request'});
      const targetUrl=`http://${host}${req.url}`;
      const path=new URL(targetUrl).pathname;
      if(req.method==='POST'&&req.url==='/token'){
        const checked=await validateTokenEndpointProof({proof,method:req.method,url:targetUrl,store:tokenProofStore});
        if(!checked.ok)return json(res,errorStatus(checked.reason),{error:'invalid_dpop_proof',reason:checked.reason});
        const token=await issueBoundAccessToken({thumbprint:checked.jkt},secret,{ttlSeconds:accessTokenTtlSeconds});
        return json(res,200,{access_token:token,token_type:'DPoP',expires_in:accessTokenTtlSeconds});
      }
      if(req.method==='POST'&&path==='/orders'){
        const checked=await validateRequest({proof,authorization:req.headers.authorization,method:req.method,url:targetUrl,store:resourceStore,secret});
        if(!checked.ok)return json(res,errorStatus(checked.reason),{error:checked.reason==='replay'?'invalid_dpop_proof':'invalid_token',reason:checked.reason});
        protectedOperations++;
        return json(res,201,{created:true,operation_id:protectedOperations});
      }
      return json(res,404,{error:'not_found'});
    }catch{return json(res,500,{error:'internal_error'});}
  });
  return {server,get protectedOperations(){return protectedOperations;}};
}
