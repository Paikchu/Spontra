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

1. **Curated** (D1 `valuation_company_inputs.peers_json`, edited in the admin's whitelist row under 估值输入): the set an admin picks for a company, equal weights. `peerBasis: "curated"`. No company is listed in code; a company without a row starts at the pairs.
2. **Pairs** (business tags, `docs/peer-similarity-design.md`): direct and partial pairs; a whole-company pair weighs 1 (basis `ranking`), a segment pair weighs tier (direct 1, partial 0.5) × own unit exposure × peer unit exposure (basis `unit`). Adjacent pairs carry nothing.
3. **Category**: companies sharing an industry category, equal weights.

`buildPeerFundamentals` then drops peers that are loss-making (trailing operating income ≤ 0), have EBITDA ≤ 0 or lack a figure the multiples need, with a note each. `peerMultiplesOf` takes the weights and computes weighted quartiles (equal weights reproduce the linear quartiles); `PeerMultiples.weights` and `basis` are published.

### 3b. Management targets and the management case

D1 `valuation_company_inputs.targets_json` stores management's public targets as cited facts (metric, fiscal year, value, GAAP/non-GAAP basis, floor/target/derived, source ids with URLs), edited in the admin's whitelist row under 估值输入 and validated on save (`workers/analysis/src/valuation/curated.ts`). The fiscal-year end that places each target comes from the company's filings, not the stored set; a set whose `asOf` is more than 540 days before the research date, or a company whose filings give no fiscal-year end, gets no management case, and the run's prompt says why. They are:

- registered as evidence at the start of a run (`registerManagementEvidence`, kind `web`, one passage per source), so the research, the scenarios and the report can cite them; listed in the research and assumption openings; part of the input fingerprint;
- turned by `shared/analysis-runtime/valuation/management.ts` into a deterministic **reference scenario** on the model's own rate, shares, bridge, horizon, tax and sales-to-capital: revenue runs geometrically through the total-revenue targets (a fiscal year lands on the first forecast year ending at or after it), then fades straight to the terminal growth; a non-GAAP margin target is brought to the calculator's basis by deducting the trailing `sbc_ttm / revenue_ttm`; build capex comes from the gross capex targets less maintenance (D&A scaled with revenue) and the growth reinvestment, and in a year with a free-cash-flow floor the sales-to-capital rises so the floor is met; the build ends inside the horizon. Published as `model.references[0]` with its own forward-multiple triangulation; never part of the range;
- the source of a **gate** `management_targets`: the base revenue path more than 25% under a total-revenue target, or more than 10% above one, is flagged (`management_target_gap`), never failed;
- the **timing** of the prior's build capex (`priorRequest({ capexShape })`): the plan's shape (peak in any year), scaled to the taper's total so the amount stays history-derived; the workflow keeps the shape only while the prior still passes every gate.

The calculator now rejects a `buildCapex` path whose last year is still positive (the build must end inside the horizon); non-monotone shapes are allowed.

### 6. Reassessment on a method change

A version bump (`VALUATION_VERSION`, `CALCULATOR_VERSION`, `VALUATION_INPUT_VERSION`) changes every switched-on company's fingerprint at once. `workers/analysis/src/valuation/reassess.ts` holds such a run back when the published report was written under an older method on the same financial period and the company is not marked to reassess (`valuation_company_inputs.reassess`, the admin's 估值输入 "方法更新时自动重估"; migration 0043 marked ORCL, the former `VALUATION_REASSESS_TICKERS`). New material (a later period), a marked company, or a manual admin run goes ahead. The pipeline task logs `skipped: "method change held back"` with the versions.

### Data correction

Alphabet's `ConvertiblePreferredStockNonredeemableOrRedeemableIssuerOptionValue` line (6.25% mandatory convertible preferred issued June 2026, carrying $18.0B, inside stockholders' equity) was grouped `redeemable` because the rule matched "Nonredeemable". The equity rule now excludes that concept (`equityGroupOf`); the `preferred_stock` fact was and is correct as a claim ahead of common.

## v3: judged weights and the management scenario (2026-11-02, `valuation.v5` / `valuation.calc.v4`, branch `feat/valuation-v3`)

Source of the change: the first live ORCL run under v2 (2026-11-01) set the triangulation weights to dcf 1 / ev_ebitda_forward 0 / pe_forward 0, so the published base was the DCF alone ($96.19) while the forward multiples ($250 / $293) were shown at weight 0; the management case ($228.81) sat in `model.references` outside the result; `model.consensus` was null without a reason; the scenario probabilities were null.

### Judgements the model must make (tool schema, every field required)

`calculate_valuation` takes no optional argument and defaults nothing. A missing or malformed field is a zod schema error returned to the model as the tool's observation (`tools/registry.ts`), which the model corrects and resubmits. Required, beyond the v2 arguments:

- `methodWeights.{dcf, ev_ebitda_forward, pe_forward}`: `{ weight ≥ 0, rationale (60–1500 chars), evidenceIds (≥ 1 registered id) }`, the three weights summing to 1 within `WEIGHT_SUM_TOLERANCE` (1e-6). The prompt explains what each method captures (DCF: the company's own projected cash flows, sensitive to the terminal value and build capex; forward multiples: the peers' market pricing of post-forecast growth and returns, a check on the terminal value) and asks for the weights to be judged from the business, life-cycle stage, build phase, backlog/RPO, margin path and industry outlook. There are no bounds, no company-specific rules and no code default on the published path (`methodWeightsOf` keeps the life-cycle defaults only for the code-only prior and the dry run).
- `scenarioProbabilities.{bear, base, management, bull}`: `{ probability ≥ 0, rationale, evidenceIds }`, summing to 1. With a curated target set the management entry must cite management's registered target evidence (`documentId = management:<ticker>`; `registerEvidence` now keeps that id for management passages); without one it must be 0 with the rationale "no target set".
- `discountRate.{riskFree, beta, equityRiskPremium, costOfDebt, taxRate, equityWeight}`: `{ value, source (text), evidenceIds }`; `wacc` needs every value, `cost_of_equity` the first three (the others null with the reason as source). The rate is always computed from the components; a stated rate is no longer accepted. The sources are published as `discountRate.sources`.
- `scenarios.{bear, base, bull}.assumptions.{revenue, margin, capex}`: `{ rationale, evidenceIds }`; `triggers` and `invalidation` at least one each; `evidenceIds` at least one.
- `managementComparison`: `{ explanation (40–1500 chars), evidenceIds }`, required when the company has a target set and null otherwise (the rows are computed by `managementComparisonRows`).
- `consensus`: `{ status: "cited", mean, low, high, count, asOf, evidenceId, source }` or `{ status: "unavailable", reason (≥ 20 chars) }`.
- `midYear` (boolean) and `forwardYears` (1–5).

Other tools audited in the same pass: `submit_dimension` now requires a `goingConcern` assessment for financialResilience (unresolved / resolved / unknown); `compose_valuation` requires at least one catalyst, one counter-evidence item and model notes of at least 120 characters; `declare_model_insufficient` requires at least one missing fact id; the counter-evidence reviewer's JSON reply is parsed through `RED_TEAM_SCHEMA` (a half-formed reply is no review). Every rationale is stored in the payload (`model.methodWeights`, `model.scenarioProbabilities`, `scenarios.*.assumptions`, `managementComparison`, `consensusNote`, `discountRate.sources`) and appended by code to `sections.modelNotes` under "JUDGEMENTS." (`judgementLines`), so a report never carries a weight without its reason; their evidence ids join the published evidence set.

### What the calculator does with them (`valuation.calc.v4`)

1. **Per-scenario method values.** Each of bear, base and bull is valued on its own path three ways: the DCF (unchanged), and the forward EV/EBITDA and P/E at the peers' median applied to that path's year-`forwardYears` EBITDA and core EPS (net claims rolled forward by that path's cash flows). `scenarios.*.valuation = { methods, weights, perShare }`: the judged weights renormalized over the methods that have a value on the path, and the weighted per-share value. A method the path cannot apply (no peers, EBITDA or EPS ≤ 0, an equity-level model) leaves its weight to the others; when no weighted method applies the DCF stands alone.
2. **The range is method-weighted.** `range.low / base / high` are the bear / base / bull weighted values; the DCF per-share values stay visible in `scenarios.*.result.perShare`. The weighted values must keep the bear ≤ base ≤ bull order (`scenario_order`), and a negative one fails `non_negative_scenarios`. The football field (`methods`, `triangulation`) is still the base path at the peers' p25 / median / p75.
3. **The management scenario is in the result.** `model.managementScenario` (superseding `references`, which the reader still accepts) is the v2 management case (`managementDrivers`: cited revenue, margin, capex and cash-flow targets on the base case's rate, shares, bridge, horizon, tax and sales-to-capital) valued like the researched scenarios, with its own football field, the judged probability and the management evidence ids. It is never the base.
4. **Expected value over four scenarios.** `range.expected = Σ p_k × perShare_k` over bear, base, management and bull. Without a management scenario its probability must be 0 (a positive one is rejected with the reason). `expectedUpside` follows.
5. **Headline, verdict and margin of safety stay on the base.** `range.base` (the base case's method-weighted value) is the headline; `marginOfSafety`, `baseUpside`, `dimensionCeilings` and `verdictOf` use it; the expected value is published beside it (`expected`, `expectedUpside`). Reasons: the base case is the researched central case whose inputs are verified against the facts and gated (RPO floor, cited inputs, terminal share, management targets); the expected value mixes in management's own plan at a judged probability, which should inform the reader and the dimension scores but not flip the verdict on its own; and the verdict rule of the design (`marginOfSafety ≤ 0 → not_supported`) is defined on the base. The sensitivities, the terminal share and the market-implied growth remain on the base DCF (a limitation line says so).
6. **Gates.** `method_unavailable` (flag): a method with judged weight > 0 that the base path could not apply, with the reason and the weight spread. `method_zero_weight` (flag, soft): a usable method at weight 0; the rationale must say why; never fails. `consensus_unavailable` (flag): emitted whenever no consensus target is given, with detail `consensus unavailable: <reason>`; the existing `consensus_divergence` applies when one is. Gap codes `method_unavailable`, `method_zero_weight` and `unverified_consensus` carry them into `gaps`.
7. **Comparison and note.** `model.managementComparison = { rows (per total-revenue target: year, FY, target, base, gap), explanation, evidenceIds }`; `model.consensusNote = { status, source, reason }`.

Contract additions are optional and the reader (`read.ts`) still parses v1–v3 payloads (`references` included). The translation rules treat the new `rationale`, `explanation` and `reason` fields as prose and skip `source`, `basis`, `detail`, `notes`.

### Reassessment

Both `VALUATION_VERSION` (`valuation.v5`, the prompts and tools changed) and `CALCULATOR_VERSION` (`valuation.calc.v4`) move. The deploy's `task.version_changed` fan-out reaches every switched-on company; `methodChangeHeldBack` holds every company with a report on unchanged material except those marked to reassess (`ORCL`). One ORCL run: the version event and any fingerprint trigger inside the five-minute debounce collapse into the same `pipeline_due` row; while the Workflow instance runs, later triggers return "later" (`driveWorkflow`), and once it has published, the stored fingerprint equals the current one.

### Frontend (business site, this repository)

`ValuationPanel` shows, when the payload carries them: the methods table (low / base / high on the base path, the judged weight and its rationale with citations), the scenario table with the DCF and the weighted value per scenario, the management row, the probabilities with their rationales and the expected value, the comparable set (basis, tickers, quartiles), the model checks (status and detail), management's targets against the base path with the explanation, and the consensus or "consensus unavailable" with the reason; the model detail adds the path assumptions, the management scenario's narrative and sources, and the discount-rate sources. Older payloads render as before.

## Acceptance

- `npm run test:analysis`, `npm run typecheck`, `tsc --noEmit -p workers/analysis/tsconfig.json` green.
- Existing stored publications (`valuation.calc.v1`, 5-year paths) still read through `readValuationPublication`.
- Rerun drift of the deterministic part is 0 (pure function); the LLM part is to be measured on the next two production runs (target ≤ 5%).
- Gate pass rate ≥ 80% on first calculation, measured over the next ten production runs.
- ORCL dry run: no negative scenario, terminal share ≤ 80%, base value inside the consensus range when the base path respects the RPO floor; GOOGL dry run: methods within 2× of each other.
- ORCL dry run with the extensions: curated peers resolve (`peerBasis: "curated"`), the management case computes from the cited targets with no failed gate, and `management_targets` passes or flags with the figures.
