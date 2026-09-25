// Current single-user mandate: fund positions are paused, underlying companies remain eligible.
// Explicit instrument classification: STK in the broker snapshot also includes ETFs.
// Keep this list separate from SEC lookup failures (a missing CIK does not prove ETF status).
export const PAUSED_RESEARCH_FUNDS = new Set(["BOXX", "DRAM", "VOO"]);
export const isResearchEligible = (ticker: string): boolean => !PAUSED_RESEARCH_FUNDS.has(ticker.toUpperCase());
