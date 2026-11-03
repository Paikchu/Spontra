# Current-price valuation guide

The product compares a dated reference close with an evidence-backed range of present equity values. It does not promise a future price or infer a buy/sell recommendation from the research score.

## Contract and ownership

`ValuationModelResult.fairValueRange` is immutable research: independent lower/upper normal operating cases, the existing base, their calculated values, assumptions, reasons and evidence. `model.range` retains bear/base/bull stress-scenario semantics. No fixed percentage band or renamed stress endpoints is accepted.

The calculator uses the same model, horizon, rate, equity bridge, shares and judged method weights for all normal cases. It rejects unordered bounds, nonfinite results, contradictory cited facts, failed gates and a positive-weight method missing in any normal case. It does not silently sort cases or redistribute an unavailable method to manufacture a normal range.

Enterprise and equity claims retain their own discount basis. FCFF and an EV/EBITDA exit reference use WACC: each interim FCFF is discounted at its own date, exit enterprise value is discounted at the exit date, and the current asset/claim bridge is applied afterward. A forward P/E share-price reference uses the cost of equity from the same capital-cost components. Peer and subject normalized earnings both deduct interest before tax; missing interest excludes P/E only. The P/E reference does not separately model interim dividends or financing changes and is not a complete FCFE valuation.

`ValuationResponse.priceGuide` is a separate dated comparison tied to `reportVersionId`. A valid range plus a usable, same-currency quote produces below/within/above and arithmetic value gaps. Missing evidence, unfinished review, stale or missing prices and an updating report produce unavailable with a typed reason. These gaps are value comparisons, not expected holding-period returns.

Current reads use the newer of the immutable report quote and the independent stored close. The existing schedule refreshes closes for visible companies with usable published ranges; it does not call a model or rewrite research. Historical versions compare against their own frozen quote at their research date. The reader labels the quote date and keeps the research date separate.

## Research and publishing

The assumptions agent supplies normal boundaries with full drivers and evidence, or explicitly declares that the normal range cannot be supported. The report preserves the pressure scenarios and management reference independently. Qualitative confidence is not a statistical coverage probability.

New research does not become ready without a completed counter-evidence review and without resolving decisive contradictions in its assumptions. A negative valuation conclusion alone is not a failure. Failed/incomplete candidates cannot replace an existing ready report.

Evidence collection and recording the research conclusions have separate execution budgets. If collection reaches its limit, a bounded finalization phase can reread registered excerpts and financial facts, submit the remaining dimensions, and finish research. It cannot search, read new sources or access historical outcomes. Missing support remains a null score and a named gap. Collection failures and cancellation stop immediately; an unfinished finalization never advances into assumptions. Historical artifacts retain the collection stop reason separately from the final research status.

Assumptions are submitted as shared parameters followed by one complete path per stage: base, bear, bull, normal lower and normal upper. The final tool assembles the original calculation request and applies the same formulas and cross-case checks. No path is filled by copying another. An accepted parameter or path edit clears the previous calculation, valuation score, quarterly forecast and review so they must be confirmed again. This keeps a long model reply from becoming a prerequisite for running the calculation.

Registered evidence keeps the excerpt presented by the reader, including its selected table focus. A new excerpt-format identity preserves existing report evidence while allowing quotations beyond the old shortened preview to be checked against the text actually read.

Changes to the latest attempt also update the public resource revision, including incomplete attempts that retain the previous report. Completion time belongs to the attempt; the immutable report keeps its original research time.

## ORCL evaluation

The current run uses current disclosed evidence and freezes a reference close. Historical evaluation reconstructs the latest four full quarterly/annual disclosures separately. Every source must have been available by its declared cutoff; companyfacts records are selected by filing time and accession, not only fiscal period end. Daily prices are cut before weekly aggregation; management targets and peers cannot come from later disclosures. Outcomes are stored separately and never supplied to the research run.

The replay is a reconstruction using the current method, not a claim that an identical forecast was issued historically. Current-model training knowledge may still introduce hindsight bias. Evaluation distinguishes financial forecast errors, dated price-position outcomes, sample size and windows not yet mature. Four observations do not establish a general accuracy rate, and later market prices are not ground truth for intrinsic value.

The runnable historical harness and its frozen inputs are the audit evidence. Existing dry-run/replay scripts using latest files are not point-in-time backtests.
