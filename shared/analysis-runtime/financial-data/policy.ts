import type { FinancialUniverse, FinancialIssuer } from '../../analysis-contract/complete-business-flow.ts';
export interface FinancialPolicy { dataTickers:Set<string>; aiTickers:Set<string>; aiEnabled:boolean; }
function tickers(text:string|undefined):Set<string>{const entries=(text??'').split(/[,\n]/).map(s=>s.trim().toUpperCase()).filter(Boolean);if(entries.some(s=>!/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)))throw new Error('Invalid ticker policy');return new Set(entries);}
export function aiIsEnabled(env:{SEC_AI_ENABLED?:string}):boolean{const value=env.SEC_AI_ENABLED?.trim().toLowerCase();if(value===undefined)return true;if(value==='true')return true;if(value==='false')return false;throw new Error('Invalid AI enable policy');}
export function financialPolicy(env:{SEC_DATA_TICKERS?:string;SEC_AI_TICKERS?:string;SEC_AI_ENABLED?:string;SEC_TRACKED_TICKERS?:string}):FinancialPolicy{
 const aiEnabled=aiIsEnabled(env);
 return {dataTickers:tickers(env.SEC_DATA_TICKERS??env.SEC_TRACKED_TICKERS),aiTickers:tickers(env.SEC_AI_TICKERS??env.SEC_TRACKED_TICKERS),aiEnabled};
}
export const allowData=(policy:FinancialPolicy,ticker:string)=>policy.dataTickers.has(ticker.toUpperCase());
export const allowAi=(policy:FinancialPolicy,ticker:string,complete:boolean)=>complete&&policy.aiEnabled&&policy.aiTickers.has(ticker.toUpperCase());
/** An empty universe is explicit and never replaced by a guessed or stale constituent list. */
export function validateUniverse(value:FinancialUniverse):FinancialIssuer[]{
 if(value.schemaVersion!=='financial-universe.v1'||!/^\d{4}-\d{2}-\d{2}$/.test(value.asOf)||!/^https:\/\//.test(value.sourceUrl)||!value.id)throw new Error('Invalid versioned universe');
 const issuers=new Map<string,FinancialIssuer>(),owners=new Map<string,string>();
 for(const issuer of value.issuers){if(!/^\d{10}$/.test(issuer.cik)||!issuer.name||!issuer.tickers.length)throw new Error('Invalid issuer');const clean=[...tickers(issuer.tickers.join(','))];for(const t of clean){if(owners.has(t)&&owners.get(t)!==issuer.cik)throw new Error('Ticker has conflicting CIK');owners.set(t,issuer.cik);}const existing=issuers.get(issuer.cik);if(existing&&existing.industry!==issuer.industry)throw new Error('Conflicting industry');issuers.set(issuer.cik,{...issuer,tickers:[...new Set([...(existing?.tickers??[]),...clean])]});}
 return [...issuers.values()];
}
