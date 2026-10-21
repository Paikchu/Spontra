import type { BusinessFlowQuarter } from "../../../../shared/analysis-contract/business-flow.ts";
import type { CapitalQuarter, CashFlowStatement } from "../../../../shared/analysis-contract/capital-structure.ts";
import type { AnalysisFinding, FindingsPublication } from "../../../../shared/analysis-contract/findings.ts";
import type { FindingData } from "../../../../shared/analysis-runtime/findings.ts";

/** Eight quarters of a small company with one business and a capex surge in the newest quarter. */
export const ENDS = ["2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];
export const PERIOD = ENDS.at(-1)!;
const amount = (v: number) => ({ value: String(v), basis: "reported" as const, definition: "", comparabilityKey: null, sourceIds: ["s1"] });
function quarter(end: string, i: number): BusinessFlowQuarter {
  const revenue = 100 + i * 5, cloud = 40 + i * 4;
  return {
    id: end, label: end, periodStart: null, periodEnd: end, periodType: "3M", currency: "USD", scale: 1e6, basisLabel: "", reportedAt: null,
    figures: { revenue: amount(revenue), cost: amount(revenue * 0.4), gross: amount(revenue * 0.6), operating: amount(revenue * 0.3), net: amount(revenue * 0.2) },
    segments: [{ id: "cloud", name: "Cloud", revenue: amount(cloud), description: "", products: [], customers: null, monetization: null, disclosure: "", sourceIds: ["s1"] }],
    segmentsComplete: true, sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/x", publishedAt: null } as BusinessFlowQuarter["sources"][number]],
  };
}
const source = { accession: "0001", url: "https://www.sec.gov/x", filedAt: "2026-07-30", form: "10-Q" };
function cashFlow(end: string, capex: number): CashFlowStatement {
  return {
    periodStart: end, periodEnd: end, currency: "USD", basis: "reported",
    operating: { total: "30000000000", lines: null }, investing: { total: String(-capex), lines: [{ id: "c", label: "Capex", concept: "x", group: "capex", value: String(-capex) }] },
    financing: { total: "-1000000000", lines: [] }, fxEffect: null, netChange: "0", supplemental: [], sources: [source],
  } as CashFlowStatement;
}
function capitalQuarter(end: string, i: number): CapitalQuarter {
  return { periodEnd: end, cashFlow: cashFlow(end, i === 7 ? 40e9 : 10e9), yearToDate: null, balanceSheet: {
    asOf: end, currency: "USD", assets: [{ id: "cash", label: "Cash", concept: "x", group: "cash", value: "50000000000" }], liabilities: [{ id: "d", label: "Debt", concept: "x", group: "debt", value: String(20e9 + i * 1e9) }],
    equity: [], totals: { assets: "200000000000", liabilities: "80000000000", equity: "120000000000", currentAssets: null, currentLiabilities: null }, source,
  }, rpo: null } as CapitalQuarter;
}
export const data: FindingData = { quarters: ENDS.map(quarter), history: null, capital: { schemaVersion: "capital-structure.v1", ticker: "TEST", quarters: ENDS.map(capitalQuarter) }, fundamentals: null, guidance: null };
export const finding: AnalysisFinding = {
  id: "capex-fcf", kind: "risk", severity: 3, title: "Capex of $40.0 billion outruns operating cash flow",
  judgment: { text: "Capex was $40.0 billion in the newest quarter against operating cash flow of $30.0 billion, so free cash flow turned negative at $10.0 billion below zero. The next report should show whether capex eases.", sourceIds: ["s1"] },
  evidence: [{ ref: { capital: "capex" }, periodEnd: PERIOD, span: "quarter", compare: "yoy" }, { ref: { capital: "operatingCashFlow" }, periodEnd: PERIOD, span: "quarter" }, { ref: { capital: "freeCashFlow" }, periodEnd: PERIOD, span: "quarter" }],
  anchors: { view: "cash", nodeIds: [], metrics: [], capital: ["capex"] },
  lens: { type: "compare_bars", refs: [{ capital: "operatingCashFlow" }, { capital: "capex" }, { capital: "freeCashFlow" }], span: "quarter" },
  watch: { ref: { capital: "capex" }, condition: "Capex below operating cash flow would show the build is a phase.", horizon: "next_quarter", compare: "yoy" },
};
export const publication: FindingsPublication = { schemaVersion: "findings.v1", ticker: "TEST", periodEnd: PERIOD, generatedAt: "2026-07-31T00:00:00Z", model: "test", findings: [finding], sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/x", kind: "sec", publishedAt: null }] };
