import {companyPolicyEnvironment} from '../financial-data/company-policy.ts';
import {assertDataTicker, requireDb} from '../core.ts';
import {normalizeTrackedTicker} from './config.ts';
import type {SecPipelineEnv} from '../operations.ts';
import {requestFinancialCollection} from '../financial-data/requests.ts';
import {emit} from '../pipeline/outbox.ts';

const collectionEnv=(env:SecPipelineEnv)=>({DB:requireDb(env),SEC_USER_AGENT:env.SEC_USER_AGENT,SEC_DATA_TICKERS:env.SEC_DATA_TICKERS,SEC_TRACKED_TICKERS:env.SEC_TRACKED_TICKERS});

/** The legacy entry point now submits to the canonical collector; it never writes the legacy cache. */
export async function refreshSecBusinessFlow(env:SecPipelineEnv,ticker:string,fetcher:typeof fetch=fetch){
 env=await companyPolicyEnvironment(env);
 assertDataTicker(env,ticker);
 return requestFinancialCollection(collectionEnv(env),ticker,{fetcher});
}
export async function handleBusinessFlowRefresh(request:Request,env:SecPipelineEnv):Promise<Response>{
 if(request.method!=='POST')return new Response('Not found',{status:404});
 if(!env.SEC_REFRESH_KEY||request.headers.get('x-sec-refresh-key')!==env.SEC_REFRESH_KEY)return Response.json({error:'Unauthorized'},{status:401});
 const ticker=normalizeTrackedTicker(new URL(request.url).pathname.split('/').at(-1));if(!ticker)return Response.json({error:'Invalid ticker'},{status:400});
 env=await companyPolicyEnvironment(env);
 try{assertDataTicker(env,ticker);}catch{return Response.json({error:'Ticker is not tracked'},{status:403});}
 if(env.SEC_DATA_COLLECTION_ENABLED!=='true')return Response.json({error:'Financial data collector is paused; use authenticated admin maintenance for a one-off task.'},{status:409});
 try{const result=await refreshSecBusinessFlow(env,ticker);
  // The queued job is run by the collect task; ask for it now.
  if(result.status==='queued'||result.status==='pending')await emit(env,[{type:'collection.requested',ticker}]);
  return Response.json(result,{status:result.status==='maintenance'?409:202});}
 catch{return Response.json({error:'SEC financial collection request failed; previous disclosure retained'},{status:503});}
}
