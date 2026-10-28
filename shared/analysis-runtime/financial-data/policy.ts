/**
 * One company, one ticker: a second share class resolves to the class the data is kept under, so a URL, a list
 * entry, a peer reference or a search for the other class reaches the same filings and figures. A share class is
 * written with a dot (BRK.B), as EDGAR's issuer directory keys it; the dash some listings use reads as the same ticker.
 */
export const TICKER_ALIASES:Readonly<Record<string,string>>={GOOG:'GOOGL'};
export const canonicalTicker=(ticker:string):string=>{const t=ticker.trim().toUpperCase().replaceAll('-','.');return TICKER_ALIASES[t]??t;};
/** A ticker as every entry point accepts it, after `canonicalTicker`. */
export const TICKER_PATTERN=/^[A-Z][A-Z0-9.-]{0,11}$/;
/** The canonical ticker, or '' when the value is not one. */
export const normalizeTicker=(value:string|null|undefined):string=>{const ticker=canonicalTicker(String(value??''));return TICKER_PATTERN.test(ticker)?ticker:'';};
export class TickerListError extends Error{
 readonly invalidEntries:string[];
 constructor(invalidEntries:string[]){super(`Ticker list contains invalid ticker(s): ${invalidEntries.join(', ')}`);this.invalidEntries=invalidEntries;this.name='TickerListError';}
}
/** A comma- or newline-separated ticker list: canonical, sorted, each once. An entry that is not a ticker fails the list. */
export function tickerList(text:string|null|undefined):string[]{
 const entries=String(text??'').split(/[,\n]+/).map(s=>s.trim()).filter(Boolean).map(canonicalTicker);
 const invalid=entries.filter(t=>!TICKER_PATTERN.test(t));if(invalid.length)throw new TickerListError([...new Set(invalid)]);
 return [...new Set(entries)].sort();
}
export function aiIsEnabled(env:{SEC_AI_ENABLED?:string}):boolean{const value=env.SEC_AI_ENABLED?.trim().toLowerCase();if(value===undefined)return true;if(value==='true')return true;if(value==='false')return false;throw new Error('Invalid AI enable policy');}
/** The companies whose financial data is collected, as the environment lists them (company-policy.ts applies the admin's whitelist to it). */
export const dataTickers=(env:{SEC_DATA_TICKERS?:string}):Set<string>=>new Set(tickerList(env.SEC_DATA_TICKERS));
export const allowData=(tickers:ReadonlySet<string>,ticker:string)=>tickers.has(canonicalTicker(ticker));
