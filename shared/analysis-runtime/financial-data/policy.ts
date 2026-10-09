
export interface FinancialPolicy { dataTickers:Set<string>; aiTickers:Set<string>; aiEnabled:boolean; }
function tickers(text:string|undefined):Set<string>{const entries=(text??'').split(/[,\n]/).map(s=>s.trim().toUpperCase()).filter(Boolean);if(entries.some(s=>!/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)))throw new Error('Invalid ticker policy');return new Set(entries);}
export function aiIsEnabled(env:{SEC_AI_ENABLED?:string}):boolean{const value=env.SEC_AI_ENABLED?.trim().toLowerCase();if(value===undefined)return true;if(value==='true')return true;if(value==='false')return false;throw new Error('Invalid AI enable policy');}
export function financialPolicy(env:{SEC_DATA_TICKERS?:string;SEC_AI_TICKERS?:string;SEC_AI_ENABLED?:string;SEC_TRACKED_TICKERS?:string}):FinancialPolicy{
 const aiEnabled=aiIsEnabled(env);
 return {dataTickers:tickers(env.SEC_DATA_TICKERS??env.SEC_TRACKED_TICKERS),aiTickers:tickers(env.SEC_AI_TICKERS??env.SEC_TRACKED_TICKERS),aiEnabled};
}
export const allowData=(policy:FinancialPolicy,ticker:string)=>policy.dataTickers.has(ticker.toUpperCase());
