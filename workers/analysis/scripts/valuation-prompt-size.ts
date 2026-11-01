/**
 * Measures the fixed prompt material of one valuation run (system prompts and the three openings) on a published report's
 * facts, so two method versions can be compared on the same company. Tokens are estimated at four characters each.
 *
 *   node --experimental-strip-types --no-warnings workers/analysis/scripts/valuation-prompt-size.ts /path/to/orcl_before.json
 */
import { readFileSync } from "node:fs";
import type { ValuationDimension, ValuationEvidence, ValuationPublication } from "../../../shared/analysis-contract/valuation.ts";
import type { ValuationState } from "../src/valuation/tools.ts";
import * as workflow from "../src/valuation/workflow.ts";

const report = (JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { report: ValuationPublication }).report;
const model = report.model!;
const input = {
  ticker: report.ticker, cik: report.cik, companyName: report.companyName, currency: report.currency, financialPeriodEnd: report.financialPeriodEnd, incomeModel: "operating",
  facts: report.facts, distributions: report.distributions, diagnostics: report.diagnostics, documents: new Array(12).fill(null).map((_, i) => ({ documentId: `d${i}`, accession: "", form: "10-Q", docType: "primary", filedAt: "2026-09-11", reportDate: "2026-08-31", url: "" })),
  guidance: null, transcripts: [], missing: [], fingerprint: "f", data: { quarters: [], history: null, capital: null, fundamentals: null, guidance: null },
  rpo: { asOf: "2026-08-31", currency: "USD", total: "664000000000", buckets: [{ start: "2026-09-01", months: 12, share: "0.13", amount: null }, { start: "2027-09-01", months: 24, share: "0.37", amount: null }, { start: "2029-09-01", months: 24, share: "0.34", amount: null }], source: { accession: "", url: "", filedAt: "", form: "10-Q" } },
  lifecycle: "build", peers: [], peerBasis: "none", trailingQuarters: [],
};
const state = {
  input, researchAsOf: report.researchAsOf, now: report.generatedAt, quote: report.quote,
  riskFree: { value: model.discountRate.components.riskFree ?? 0.05, date: "2026-10-27", label: "CBOE 10-Year Treasury Note Yield", sourceUrl: "" },
  beta: { beta: model.discountRate.components.beta ?? 1.8, observations: 104, from: "2024-10-28", to: "2026-10-26", index: "^GSPC", sourceUrl: "" },
  peerMultiples: null, multipleHistory: null,
  evidence: new Map<string, ValuationEvidence>(report.evidence.map(e => [e.evidenceId, e])), hits: [], used: { finds: 0, reads: 0, searches: 0, webReads: 0, transcripts: 0 },
  dimensions: new Map<ValuationDimension["key"], ValuationDimension>(report.dimensions.map(d => [d.key, d])), researchDone: true,
  calc: { request: null as never, result: model }, modelGaps: [], insufficient: null, assumptionsDone: true, redTeam: null, composed: null, cancelled: false,
} as unknown as ValuationState;
const w = workflow as unknown as { RESEARCH_SYSTEM: string; ASSUME_SYSTEM: string; COMPOSE_SYSTEM: string; VALUATION_VERSION: string; openingResearch(s: ValuationState): string; openingAssume(s: ValuationState, prior: unknown): string; openingCompose(s: ValuationState): string; priorRequest(s: ValuationState): unknown };
const prior = w.priorRequest(state);
const parts = { researchSystem: w.RESEARCH_SYSTEM, researchOpening: w.openingResearch(state), assumeSystem: w.ASSUME_SYSTEM, assumeOpening: w.openingAssume(state, prior), composeSystem: w.COMPOSE_SYSTEM, composeOpening: w.openingCompose(state) };
const chars = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.length]));
const total = Object.values(chars).reduce((a, b) => a + b, 0);
console.log(JSON.stringify({ version: w.VALUATION_VERSION, chars, totalChars: total, estimatedTokens: Math.round(total / 4) }, null, 1));
