import {companyPolicyEnvironment} from '../financial-data/company-policy.ts';
import {assertDataTicker, requireDb} from '../core.ts';
import {normalizeTrackedTicker, parseTrackedTickers} from './config.ts';
import type {SecPipelineEnv} from '../operations.ts';
import {requestFinancialCollection} from '../financial-data/requests.ts';

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
 try{const result=await refreshSecBusinessFlow(env,ticker);return Response.json(result,{status:result.status==='maintenance'?409:202});}
 catch{return Response.json({error:'SEC financial collection request failed; previous disclosure retained'},{status:503});}
}
/** Preserve the old opt-in target and cadence, but share freshness, pending jobs and issuer locks. */
export async function runBusinessFlowBootstrap(env:SecPipelineEnv,fetcher:typeof fetch=fetch):Promise<{results:unknown[]}>{
 if(env.SEC_DATA_COLLECTION_ENABLED!=='true')return {results:[]};
 const targets=parseTrackedTickers((env as SecPipelineEnv & {SEC_BUSINESS_FLOW_BOOTSTRAP_TICKERS?:string}).SEC_BUSINESS_FLOW_BOOTSTRAP_TICKERS).slice(0,1);
 const results:unknown[]=[];
 env=await companyPolicyEnvironment(env);
 for(const ticker of targets){if(!env.SEC_DATA_TICKERS?.split(',').includes(ticker))continue;results.push(await requestFinancialCollection(collectionEnv(env),ticker,{maxAgeMs:86400000,fetcher}));}
 return {results};
}
