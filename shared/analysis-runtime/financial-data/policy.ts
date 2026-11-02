/**
 * A ticker as typed, in the one spelling every store keys on: upper case, a share class written with a dot (BRK.B), as
 * EDGAR's issuer directory keys it; the dash some listings use reads as the same ticker. Which class a company's data
 * is kept under is the issuer directory's to say (catalog/issuer-directory.ts `primaryTicker`), not code's.
 */
export const canonicalTicker=(ticker:string):string=>ticker.trim().toUpperCase().replaceAll('-','.');
/** A ticker as every entry point accepts it, after `canonicalTicker`. */
export const TICKER_PATTERN=/^[A-Z][A-Z0-9.-]{0,11}$/;
/** The canonical ticker, or '' when the value is not one. */
export const normalizeTicker=(value:string|null|undefined):string=>{const ticker=canonicalTicker(String(value??''));return TICKER_PATTERN.test(ticker)?ticker:'';};
class TickerListError extends Error{
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
