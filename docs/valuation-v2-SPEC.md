# Valuation v2: multi-method, build-phase aware, gated

Status: implemented on `feat/valuation-v2` (2026-11-01). Supersedes the single-model parts of
[valuation-methodology-optimization.md](valuation-methodology-optimization.md); everything it does not mention stays as specified there.
Source of the defect list: the 2026-10-31 comparison against sell-side practice (ORCL base $30 vs 43-analyst mean $236; terminal value 128% of operating value; bear case negative).

## Scope

In scope: the deterministic calculator, the material pack, the assumption tool and prompts, the publication contract (additive only), unit tests, and a local dry run on ORCL and GOOGL.
Out of scope: SOTP, non-USD markets, REIT/insurance models, daily repricing, and any frontend change (`model` keeps every existing field; new fields are optional).

## Modules

| Module | File | What changes |
| --- | --- | --- |
| Calculator | `shared/analysis-runtime/valuation/calculator.ts` | `valuation.calc.v2`: 5–10 year horizon; build capex ahead of revenue; terminal FCF from a normalized margin; mid-year option; RPO revenue floor; forward EV/EBITDA and P/E cross-check; triangulation; sanity gates; cited-input verification; implied-multiple history |
| Contract | `shared/analysis-contract/valuation.ts` | optional `methods`, `triangulation`, `gates`, `anchors`, `verification` on `ValuationModelResult`; optional fcff driver fields; new gap codes |
| Read | `shared/analysis-runtime/valuation/read.ts` | accepts the optional fields; old payloads still parse |
| Input | `workers/analysis/src/valuation/input.ts` | facts `rpo_total`, `rpo_next_12m_share`, `preferred_stock`, `minority_interest`; life-cycle classification; peer fundamentals (not in the fingerprint) |
| Market | `workers/analysis/src/valuation/market.ts` | weekly close history (implied-multiple history) and peer quotes |
| Tools | `workers/analysis/src/valuation/tools.ts` | `calculate_valuation` accepts horizon 5–10, build capex, normalized terminal margin, consensus, method weights; returns methods, gates, verification; shorter outputs |
| Workflow | `workers/analysis/src/valuation/workflow.ts` | `valuation.v4`; RPO-anchored 7-year prior for build-phase companies; prompts trimmed; assumption opening no longer repeats the research opening |

## Approach

1. **Horizon and build phase.** An fcff path may run 5 to 10 years (all arrays one length). `path.buildCapex[t]` is capital spent ahead of revenue (capacity under construction); it is reinvestment the sales-to-capital term does not see. `terminalOperatingMargin` lets the terminal NOPAT come from a normalized margin when the last forecast year still carries build-phase depreciation. Reinvestment from revenue growth is never negative beyond a year's depreciation (unchanged).
2. **RPO anchor.** `rpoRevenueFloor` spreads the disclosed RPO buckets over forecast years (a bucket of *m* months starting *s* months after the period end is spread evenly over the years it covers; an open "thereafter" bucket is spread over the remaining horizon). The floor is contracted revenue only; a base revenue path below the floor in any year raises the `rpo_floor_breached` gate. The prior uses `max(history median, floor-implied growth)` for years one and two.
3. **Cross-check.** `forwardMultipleValue` applies peer multiples (p25 / median / p75 of the ranking peers' TTM EV/EBITDA and core P/E) to the base path's FY+3 EBITDA and core EPS, discounts them back at the shared rate and applies the same bridge and shares. Core earnings exclude securities gains: `(EBIT − net interest) × (1 − tax)`.
4. **Triangulation.** `triangulate` weights the DCF and the two multiple methods (default weights by life cycle: build 0.5 / 0.3 / 0.2, growth 0.6 / 0.25 / 0.15, mature 0.7 / 0.15 / 0.15) into a football-field range and reports method dispersion (max / min of method bases).
5. **Gates.** `sanityGates` returns pass / flag / fail per gate. Fails reject the calculation inside the tool so the model must revise: terminal share > 100%, any scenario below zero, terminal growth above the risk-free rate, cited inputs that contradict facts beyond tolerance. Flags only annotate: terminal share > 80%, terminal growth > 3%, implied EV/EBITDA outside the company's own two-year range, method dispersion > 2×, RPO floor breached, base more than 50% away from the consensus mean. Consensus divergence is flagged, never forced.
6. **Verification.** `verifyCitedInputs` checks `revenue0`, the bridge, shares and tax against the registered facts (0.5% on revenue, 2% on the bridge, preferred and minority claims must be included when the facts carry them). A mismatch is a fail gate with the exact numbers.
7. **Tokens.** The assumption opening sends a model fact subset instead of the whole research opening; evidence excerpts and red-team payloads are shorter; filing reads are 5 000 characters; the calculator's reply is compact. Target 30% fewer input tokens per run on fixed prompt material.

## Extensions (2026-11-01, second commit on the branch)

### 3a. Comparable sets

`shared/analysis-runtime/valuation/peers.ts` chooses the cross-check's peers in priority order, each source counting only when it gives at least two companies the projection carries:

1. **Curated** (`workers/analysis/src/valuation/curated/peer-map.json`): the hand-picked set per company, equal weights. `peerBasis: "curated"`.
2. **Pairs** (business tags, `docs/peer-similarity-design.md`): direct and partial pairs; a whole-company pair weighs 1 (basis `ranking`), a segment pair weighs tier (direct 1, partial 0.5) × own unit exposure × peer unit exposure (basis `unit`). Adjacent pairs carry nothing.
3. **Category**: companies sharing an industry category, equal weights.

`buildPeerFundamentals` then drops peers that are loss-making (trailing operating income ≤ 0), have EBITDA ≤ 0 or lack a figure the multiples need, with a note each. `peerMultiplesOf` takes the weights and computes weighted quartiles (equal weights reproduce the linear quartiles); `PeerMultiples.weights` and `basis` are published.

### 3b. Management targets and the management case

`workers/analysis/src/valuation/curated/management-targets.json` stores management's public targets as cited facts (metric, fiscal year, value, GAAP/non-GAAP basis, floor/target/derived, source ids with URLs). They are:

- registered as evidence at the start of a run (`registerManagementEvidence`, kind `web`, one passage per source), so the research, the scenarios and the report can cite them; listed in the research and assumption openings; part of the input fingerprint;
- turned by `shared/analysis-runtime/valuation/management.ts` into a deterministic **reference scenario** on the model's own rate, shares, bridge, horizon, tax and sales-to-capital: revenue runs geometrically through the total-revenue targets (a fiscal year lands on the first forecast year ending at or after it), then fades straight to the terminal growth; a non-GAAP margin target is brought to the calculator's basis by deducting the trailing `sbc_ttm / revenue_ttm`; build capex comes from the gross capex targets less maintenance (D&A scaled with revenue) and the growth reinvestment, and in a year with a free-cash-flow floor the sales-to-capital rises so the floor is met; the build ends inside the horizon. Published as `model.references[0]` with its own forward-multiple triangulation; never part of the range;
- the source of a **gate** `management_targets`: the base revenue path more than 25% under a total-revenue target, or more than 10% above one, is flagged (`management_target_gap`), never failed;
- the **timing** of the prior's build capex (`priorRequest({ capexShape })`): the plan's shape (peak in any year), scaled to the taper's total so the amount stays history-derived; the workflow keeps the shape only while the prior still passes every gate.

The calculator now rejects a `buildCapex` path whose last year is still positive (the build must end inside the horizon); non-monotone shapes are allowed.

### 6. Reassessment on a method change

A version bump (`VALUATION_VERSION`, `CALCULATOR_VERSION`, `VALUATION_INPUT_VERSION`) changes every switched-on company's fingerprint at once. `workers/analysis/src/valuation/reassess.ts` holds such a run back when the published report was written under an older method on the same financial period and the company is not in `VALUATION_REASSESS_TICKERS` (wrangler var; `*` for all, unset for none). New material (a later period), a listed company, or a manual admin run goes ahead. The pipeline task logs `skipped: "method change held back"` with the versions.

### Data correction

Alphabet's `ConvertiblePreferredStockNonredeemableOrRedeemableIssuerOptionValue` line (6.25% mandatory convertible preferred issued June 2026, carrying $18.0B, inside stockholders' equity) was grouped `redeemable` because the rule matched "Nonredeemable". The equity rule now excludes that concept (`equityGroupOf`); the `preferred_stock` fact was and is correct as a claim ahead of common.

## Acceptance

- `npm run test:analysis`, `npm run typecheck`, `tsc --noEmit -p workers/analysis/tsconfig.json` green.
- Existing stored publications (`valuation.calc.v1`, 5-year paths) still read through `readValuationPublication`.
- Rerun drift of the deterministic part is 0 (pure function); the LLM part is to be measured on the next two production runs (target ≤ 5%).
- Gate pass rate ≥ 80% on first calculation, measured over the next ten production runs.
- ORCL dry run: no negative scenario, terminal share ≤ 80%, base value inside the consensus range when the base path respects the RPO floor; GOOGL dry run: methods within 2× of each other.
- ORCL dry run with the extensions: curated peers resolve (`peerBasis: "curated"`), the management case computes from the cited targets with no failed gate, and `management_targets` passes or flags with the figures.
