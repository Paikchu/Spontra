# Deterministic financial collection

The public business map reads `/api/v1/companies/{ticker}/business-flow` via the existing Web proxy. It never initiates generation. Only complete, source-traced two-quarter income snapshots are published; staged records are not exposed. Failed updates keep the previous complete snapshot with `outdated` and failure reasons. A verified complete legacy SEC snapshot remains usable during rollout.

Configuration (Git-controlled Wrangler variables):
- `SEC_DATA_TICKERS`: collection allowlist, initially ORCL,NVDA,MSFT,AAPL,JPM,BRK.B,ADSK,NET. This is a bounded initial collection scope, not a claimed full S&P500 constituent universe.
- `SEC_AI_TICKERS`: independent AI allowlist, initially the existing ORCL,ADSK,NET.
- `SEC_AI_ENABLED`: true/false; false prevents new SEC/company/memory analysis starts, including manual starts. Previously issued/in-flight requests cannot be recalled.
- `SEC_DATA_COLLECTION_ENABLED`: independent opt-in collection; false pauses this collector.
- Unspecified new lists preserve legacy `SEC_TRACKED_TICKERS`; explicitly empty lists stay empty.

The existing 10-minute cron processes at most one data job/document batch. It discovers issuer identity from SEC's directory, fetches at most two filing primaries and up to two same-filing Exhibit 99 links per primary, throttles reads, stages progress, and resumes on later ticks. One refresh per configured issuer per day. No model key or workflow binding is passed to the data task. `financial-data` logs carry ticker, publication result, public reason codes and `modelCalls:0`; the independent pre-existing AI cron tasks retain their own policy.

Migration `0013_complete_financial_snapshots.sql` is applied by the existing Pipeline CI migration command. Tables contain only collection jobs, staged public SEC quarters, immutable complete versions and the current pointer. Leases prevent expired owners and older generations from changing the pointer. Normal continuation is not a failed retry. Exhausted failed/crashed jobs terminate.

Validated public disclosures: ORCL direct operating-expense profile, Microsoft standard gross-profit profile (2026-03-31/2025-12-31), JPMorgan net-financial-revenue profile (2026-06-30/2026-03-31). JPM expenses include reported noninterest expense and credit-loss provision; interest already deducted in net revenue is not double-counted. Oracle tag/table profile reads actual amounts, never substitutes fixed fixture values for other issuers. Full source hashes/URLs accompany trimmed regression fixtures.

Known limits are honest unavailable/preparing states: generic unrecognized custom tags/tables, ambiguous/nonreconciling department dimensions, unresolved restatements, signed-loss/expense-reversal layouts, and unsupported cumulative/Q4 derivation. A newer annual filing's required quarter cannot be silently replaced by two older quarters: `LATEST_PERIOD_NOT_COLLECTED`. Company-total business nodes explicitly say department mapping is unverified, not that the company failed to disclose departments. Cross-fiscal-year department comparisons are not assumed comparable.

A versioned issuer-universe contract and CIK dedup validator exist in shared contracts/runtime; no guessed 500-company membership list or production full-universe task is created. Three disclosure structures are verified, not every company/industry or every latest filing. Rendering uses the pinned ECharts Sankey library and the existing schema/graph conservation checks.

## Quarterly revenue history

`financial-data/history.ts` advances only on idle ticks of the same data cron (nothing claimable or due for the complete snapshot), at most three filings per tick, refreshed daily per issuer. It reads the last ~820 days of 10-Q, 10-K and 8-K Item 2.02 filings (≤14) through the same throttled SEC reader and `extractDisclosedQuarters`; each 10-Q also yields its year-ago comparative. A fourth quarter is derived only as same-concept, same-dimension full year minus nine-month cumulative from filings without a restatement flag, labelled `derived` with its formula, and never replaces a directly reported quarter. Per period, the newest filing wins (it carries the current presentation). Quarters are kept only when three months long, positive, and businesses sum to revenue.

Storage is the existing `sec_cache` table (`sec:revenue-history:v1:<cik>` plus a cursor key); no migration. The business-flow read adds an optional `history` (`revenue-history.v1`, newest eight quarters), anchored with the verified snapshot quarters; a missing or invalid record never affects the snapshot. Different business presentations across filings are not reconciled: the map shows those quarters as company total or as gaps.
