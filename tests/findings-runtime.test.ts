import test from "node:test";
import assert from "node:assert/strict";
import { ORCL_FINDINGS } from "../workers/pipeline/src/findings/authored/ORCL";
import { evidenceCandidates, numberSupported, proseNumbers, readFindingsPublication, resolveRef, shiftPeriod, verifyFindings, type FindingData } from "../shared/analysis-runtime/findings";
import type { BusinessFlowQuarter } from "../shared/analysis-contract/business-flow";
import type { RevenueHistory } from "../shared/analysis-contract/revenue-history";
import type { PublicCapitalStructure } from "../shared/analysis-contract/capital-structure";
import type { GuidancePublication } from "../shared/analysis-contract/guidance";

/* A compact two-year Oracle: quarterly revenue by business, FY2026 and FY2025 cash flow, and the capex guidance. */
const ends = ["2024-08-31", "2024-11-30", "2025-02-28", "2025-05-31", "2025-08-31", "2025-11-30", "2026-02-28", "2026-05-31", "2026-08-31"];
const revenue = [13307, 14059, 14130, 15903, 14926, 16058, 17190, 19184, 19345];
const cloud = [5623, 5937, 6210, 6737, 7186, 7977, 8914, 9913, 11607];
const software = [5766, 6064, 5926, 6968, 5721, 5877, 6119, 6824, 5550];
const net = [2927, 3151, 2936, 3427, 2927, 6135, 3721, 4304, 4760];
const amount = (value: number, basis: "reported" | "derived" = "reported") => ({ value: String(value * 1e6), basis, definition: "x", comparabilityKey: "x", sourceIds: ["s"] });
const quarter = (i: number): BusinessFlowQuarter => ({
  id: ends[i], label: ends[i], periodStart: shiftPeriod(ends[i], -3), periodEnd: ends[i], periodType: "3M", currency: "USD", scale: 1, basisLabel: "GAAP", reportedAt: ends[i], incomeModel: "direct_operating",
  figures: { revenue: amount(revenue[i]), net: amount(net[i]), operating: amount(Math.round(revenue[i] * 0.3)) },
  segments: [
    { id: "cloud", name: "云服务", revenue: amount(cloud[i]), description: "", products: [], customers: null, monetization: null, disclosure: "reported", sourceIds: ["s"], ...(i >= 6 ? { children: [{ id: "CloudInfrastructure", name: "云基础设施", revenue: amount(5787) }, { id: "CloudApplications", name: "云应用", revenue: amount(cloud[i] - 5787) }] } : {}) },
    { id: "software", name: "软件", revenue: amount(software[i]), description: "", products: [], customers: null, monetization: null, disclosure: "reported", sourceIds: ["s"] },
    { id: "HardwareRevenues", name: "硬件", revenue: amount([655, 728, 703, 850, 670, 776, 714, 924, 774][i]), description: "", products: [], customers: null, monetization: null, disclosure: "reported", sourceIds: ["s"] },
    { id: "SalesRevenueServicesNet", name: "服务", revenue: amount([1263, 1330, 1291, 1348, 1349, 1428, 1443, 1523, 1414][i]), description: "", products: [], customers: null, monetization: null, disclosure: "reported", sourceIds: ["s"] },
  ],
  segmentsComplete: true, sources: [{ id: "s", title: "10-K", url: "https://www.sec.gov/x" }],
} as unknown as BusinessFlowQuarter);
const quarters = ends.map((_, i) => quarter(i));
const history: RevenueHistory = { schemaVersion: "revenue-history.v1", ticker: "ORCL", updatedAt: "2026-10-01", quarters: quarters.map(q => ({
  periodStart: q.periodStart, periodEnd: q.periodEnd, currency: "USD", scale: 1, revenue: q.figures.revenue!.value, basis: "reported",
  segments: q.segments.map(s => ({ id: s.id, name: s.name, value: s.revenue!.value, ...(s.children ? { children: s.children.map(c => ({ id: c.id, name: c.name, value: c.revenue.value })) } : {}) })),
  source: { accession: "0001", url: "https://www.sec.gov/x", filedAt: q.periodEnd, form: "10-Q" },
})) };
const statement = (start: string, end: string, operating: number, capex: number, debt: number) => ({
  periodStart: start, periodEnd: end, currency: "USD", basis: "reported" as const,
  operating: { total: String(operating * 1e6), lines: [] }, investing: { total: String(-capex * 1e6), lines: [{ id: "capex", label: "Capital expenditures", concept: "x", group: "capex" as const, value: String(-capex * 1e6) }] },
  financing: { total: String(debt * 1e6), lines: [{ id: "debt", label: "Borrowings", concept: "x", group: "debtIssued" as const, value: String(debt * 1e6) }] },
  fxEffect: null, netChange: "0", supplemental: [], sources: [{ accession: "0001", url: "https://www.sec.gov/x", filedAt: end, form: "10-K" }],
});
const balance = (asOf: string, assets: number) => ({ asOf, currency: "USD", assets: [], liabilities: [], equity: [], totals: { assets: String(assets * 1e6), liabilities: "0", equity: "0", currentAssets: null, currentLiabilities: null }, source: { accession: "0001", url: "https://www.sec.gov/x", filedAt: asOf, form: "10-K" } });
const rpo = (asOf: string, total: number, buckets: Array<[string, number | null, string]>) => ({ asOf, currency: "USD", total: String(total * 1e6), buckets: buckets.map(([start, months, share]) => ({ start, months, share, amount: null })), source: { accession: "0001", url: "https://www.sec.gov/x", filedAt: asOf, form: "10-K" } });
const capital: PublicCapitalStructure = { schemaVersion: "capital-structure.v1", ticker: "ORCL", quarters: [
  { periodEnd: "2026-08-31", rpo: rpo("2026-08-31", 664000, [["2026-09-01", 12, "0.13"]]), balanceSheet: null, cashFlow: null, yearToDate: null },
  { periodEnd: "2026-05-31", rpo: rpo("2026-05-31", 638000, [["2026-06-01", 12, "0.12"], ["2027-06-01", 24, "0.34"], ["2029-06-01", 24, "0.34"]]), balanceSheet: balance("2026-05-31", 261759), cashFlow: null, yearToDate: statement("2025-06-01", "2026-05-31", 31977, 55663, 46093) },
  { periodEnd: "2025-05-31", rpo: rpo("2025-05-31", 137800, []), balanceSheet: balance("2025-05-31", 168361), cashFlow: null, yearToDate: statement("2024-06-01", "2025-05-31", 20821, 21215, 21437) },
] };
const guidanceItem = (id: string, metric: GuidancePublication["items"][number]["metric"], low: number, high: number, unit: "USD" | "percent", segment: string | null = null, measure: "amount" | "growth" = "amount") => ({
  id, metric, measure, segment, label: metric, basis: "gaap" as const, horizon: "annual" as const, form: "point" as const, fiscalYear: 2026, fiscalQuarter: null, periodEnd: "2026-05-31", unit, low, high, direction: null, derived: null, actual: null, text: "", quote: "", sourceIds: ["m"], issuedAt: "2026-03-10", action: null, previous: null,
});
const guidance: GuidancePublication = { schemaVersion: "guidance.v1", ticker: "ORCL", updatedAt: "2026-10-01", sources: [{ id: "m", kind: "press_release", sourceKind: "sec", title: "Release", url: "https://www.sec.gov/x", publishedAt: "2026-03-10" }], coverage: [], items: [
  guidanceItem("capex|amount||annual|2026|||gaap|0001193125-26-100148", "capex", 50e9, 50e9, "USD"),
  guidanceItem("segment_revenue|amount|oracle-cloud-infrastructure|annual|2026|||unspecified|0001193125-25-199175", "segment_revenue", 18e9, 18e9, "USD", "Oracle Cloud Infrastructure"),
  guidanceItem("segment_revenue|growth|oracle-cloud-infrastructure|annual|2026|||unspecified|0001193125-25-199175", "segment_revenue", 77, 77, "percent", "Oracle Cloud Infrastructure", "growth"),
  { ...guidanceItem("revenue|amount||annual|2027|||gaap|0001193125-26-265848", "revenue", 90e9, 90e9, "USD"), fiscalYear: 2027, periodEnd: "2027-05-31" },
  { ...guidanceItem("other|amount||annual|2027||debt-and-equity-financing|unspecified|0001193125-26-265848", "other", 40e9, 40e9, "USD"), fiscalYear: 2027, periodEnd: "2027-05-31" },
  { ...guidanceItem("segment_revenue|growth|total-cloud-revenue|quarter|2027|1||gaap|0001193125-26-265848", "segment_revenue", 58, 64, "percent", "Total Cloud revenue", "growth"), horizon: "quarter" as const, fiscalYear: 2027, fiscalQuarter: 1 as const, periodEnd: "2026-08-31" },
  { ...guidanceItem("revenue|growth||quarter|2027|1||gaap|0001193125-26-265848", "revenue", 27, 29, "percent", null, "growth"), horizon: "quarter" as const, fiscalYear: 2027, fiscalQuarter: 1 as const, periodEnd: "2026-08-31" },
] };
const data: FindingData = { quarters, history, capital, fundamentals: null, guidance };

test("fiscal-year spans sum four quarters and compare against the year before; gaps stay unresolved", () => {
  const fy26 = resolveRef(data, { metric: "revenue" }, "2026-05-31", "fiscal_year")!;
  assert.equal(fy26.value, 67358e6);
  assert.equal(fy26.periodStart, quarters[4].periodStart);
  assert.equal(resolveRef(data, { nodeId: "cloud" }, "2025-05-31", "fiscal_year")!.value, 24507e6);
  // FY2024 needs a quarter the data does not hold.
  assert.equal(resolveRef(data, { metric: "revenue" }, "2024-05-31", "fiscal_year"), null);
  // A child business exists only where it was disclosed; a twelve-month statement is the fiscal year itself.
  assert.equal(resolveRef(data, { nodeId: "CloudInfrastructure" }, "2026-05-31", "quarter")!.value, 5787e6);
  assert.equal(resolveRef(data, { nodeId: "CloudInfrastructure" }, "2025-05-31", "quarter"), null);
  assert.equal(resolveRef(data, { capital: "freeCashFlow" }, "2026-05-31", "fiscal_year")!.value, -23686e6);
  assert.equal(resolveRef(data, { capital: "capex" }, "2026-05-31", "quarter"), null);
});

test("the authored Oracle findings verify against the statements, with every written number supported", () => {
  const publication = readFindingsPublication(ORCL_FINDINGS, "ORCL");
  assert.ok(publication);
  const { verified, withheld } = verifyFindings(publication, data);
  assert.deepEqual(withheld, []);
  assert.deepEqual(verified.map(f => f.id), ["capex-fcf", "cloud-engine", "growth-acceleration", "rpo-backlog", "fy27-outlook", "legacy-shrink"]);
  // RPO: the total compared a year earlier, and the share tagged for the first twelve months.
  const backlog = verified.find(f => f.id === "rpo-backlog")!;
  assert.equal(Math.round(backlog.resolved[0].delta!), 363);
  assert.deepEqual([backlog.resolved[1].current.value, backlog.resolved[1].current.unit], [12, "percent"]);
  assert.equal(backlog.watchOutcome?.resolved.current.value, 664000e6);
  const capex = verified[0].resolved[0];
  assert.equal(capex.guidance?.verdict, "above");
  assert.equal(Math.round(verified[0].resolved[1].ratio! * 10) / 10, 2.6);
  assert.equal(Math.round(verified[0].resolved[5].delta!), 55);
  assert.equal(verified.find(f => f.id === "cloud-engine")!.resolved[1].delta!.toFixed(2), "-0.74");
  // Cloud revenue per dollar of capex: one figure over another at the same span, compared a year earlier.
  const perDollar = verified[0].resolved[6];
  assert.equal(perDollar.current.unit, "ratio");
  assert.equal(perDollar.current.value.toFixed(2), "0.61");
  assert.equal(perDollar.compare!.value.toFixed(2), "1.16");
});

test("a watch resolves once its period is published, against guidance when it names one, and waits otherwise", () => {
  const { verified } = verifyFindings(readFindingsPublication(ORCL_FINDINGS, "ORCL")!, data);
  const cloud = verified.find(f => f.id === "cloud-engine")!.watchOutcome!;
  assert.equal(cloud.periodEnd, "2026-08-31");
  assert.equal(cloud.resolved.current.value, 11607e6);
  assert.equal(cloud.resolved.guidance?.verdict, "within");
  assert.equal(Math.round(cloud.resolved.guidance!.measured * 10) / 10, 61.5);
  // Q1 FY2027 revenue grew 29.6%, past the 27%–29% guided: the outcome says so rather than rounding it in.
  const revenue = verified.find(f => f.id === "fy27-outlook")!.watchOutcome!;
  assert.equal(revenue.resolved.guidance?.verdict, "above");
  // FY2027 is not over: the capex watch has no outcome yet.
  assert.equal(verified[0].watchOutcome, null);
  assert.equal(verifyFindings(readFindingsPublication(ORCL_FINDINGS, "ORCL")!, { ...data, quarters: quarters.slice(0, 8), history: { ...history, quarters: history.quarters.slice(0, 8) } }).verified.find(f => f.id === "cloud-engine")!.watchOutcome, null);
});

test("a finding whose numbers, businesses or metrics the data does not support is withheld, never shown", () => {
  const publication = readFindingsPublication(ORCL_FINDINGS, "ORCL")!;
  const wrongNumber = structuredClone(publication);
  wrongNumber.findings[0].judgment.text = wrongNumber.findings[0].judgment.text.replace("557 亿", "600 亿");
  assert.deepEqual(verifyFindings(wrongNumber, data).withheld.map(w => w.id), ["capex-fcf"]);
  const wrongNode = structuredClone(publication);
  wrongNode.findings[1].anchors.nodeIds.push("Metaverse");
  assert.match(verifyFindings(wrongNode, data).withheld[0].reasons[0], /Metaverse/);
  const noGuidance = verifyFindings(publication, { ...data, guidance: null });
  assert.ok(noGuidance.withheld.some(w => w.id === "capex-fcf" && w.reasons.some(r => /unresolved/.test(r))));
  // Without capital the cash-flow finding cannot be shown; the revenue findings still can.
  assert.deepEqual(verifyFindings(publication, { ...data, capital: null }).verified.map(f => f.id), ["cloud-engine", "growth-acceleration", "fy27-outlook", "legacy-shrink"]);
  // Capital archived before RPO was read carries no rpo field: the backlog finding waits rather than guessing.
  const noRpo = { ...data, capital: { ...capital, quarters: capital.quarters.map(({ rpo: _, ...q }) => { void _; return q; }) } };
  assert.ok(verifyFindings(publication, noRpo).withheld.some(w => w.id === "rpo-backlog"));
});

test("the reader strips unknown fields, drops uncited findings and dangling pairs, and rejects other tickers", () => {
  const polluted = structuredClone(ORCL_FINDINGS) as typeof ORCL_FINDINGS & { secret: string };
  polluted.secret = "PRIVATE";
  Object.assign(polluted.findings[0], { privateNote: "PRIVATE" });
  polluted.findings[1].judgment.sourceIds = ["nowhere"];
  const read = readFindingsPublication(polluted, "ORCL")!;
  assert.ok(!JSON.stringify(read).includes("PRIVATE"));
  assert.deepEqual(read.findings.map(f => f.id), ["capex-fcf", "rpo-backlog", "growth-acceleration", "legacy-shrink", "fy27-outlook"]);
  assert.equal(read.findings[0].pairWith, undefined);
  assert.equal(readFindingsPublication(ORCL_FINDINGS, "MSFT"), null);
  assert.equal(readFindingsPublication({ ...ORCL_FINDINGS, findings: [] }, "ORCL"), null);
});

test("prose numbers skip fiscal periods and dates; matches allow the rounding written and two percent", () => {
  assert.deepEqual(proseNumbers("FY2026 资本开支 557 亿美元，是 FY2025 的 2.6 倍；Q4 增长 21%，2026 年 6 月披露，-237 亿"), [557, 2.6, 21, -237]);
  assert.ok(numberSupported(557, [556.63]));
  assert.ok(numberSupported(2.6, [2.624]));
  assert.ok(!numberSupported(2.6, [2.7]));
  assert.ok(numberSupported(170, [170.87]));
  assert.ok(!numberSupported(36, [37.3]));
  const r = verifyFindings(readFindingsPublication(ORCL_FINDINGS, "ORCL")!, data).verified[0].resolved[3];
  assert.ok(evidenceCandidates(r).includes(236.86));
});
