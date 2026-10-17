
export interface FinancialPolicy { dataTickers:Set<string>; aiTickers:Set<string>; aiEnabled:boolean; }
/**
 * One company, one ticker: a second share class resolves to the class the data is kept under, so a URL, a list
 * entry, a peer reference or a search for the other class reaches the same filings and figures.
 */
export const TICKER_ALIASES:Readonly<Record<string,string>>={GOOG:'GOOGL'};
export const canonicalTicker=(ticker:string):string=>{const t=ticker.trim().toUpperCase();return TICKER_ALIASES[t]??t;};
function tickers(text:string|undefined):Set<string>{const entries=(text??'').split(/[,\n]/).map(s=>canonicalTicker(s)).filter(Boolean);if(entries.some(s=>!/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)))throw new Error('Invalid ticker policy');return new Set(entries);}
export function aiIsEnabled(env:{SEC_AI_ENABLED?:string}):boolean{const value=env.SEC_AI_ENABLED?.trim().toLowerCase();if(value===undefined)return true;if(value==='true')return true;if(value==='false')return false;throw new Error('Invalid AI enable policy');}
export function financialPolicy(env:{SEC_DATA_TICKERS?:string;SEC_AI_TICKERS?:string;SEC_AI_ENABLED?:string;SEC_TRACKED_TICKERS?:string}):FinancialPolicy{
 const aiEnabled=aiIsEnabled(env);
 return {dataTickers:tickers(env.SEC_DATA_TICKERS??env.SEC_TRACKED_TICKERS),aiTickers:tickers(env.SEC_AI_TICKERS??env.SEC_TRACKED_TICKERS),aiEnabled};
}
export const allowData=(policy:FinancialPolicy,ticker:string)=>policy.dataTickers.has(ticker.toUpperCase());
