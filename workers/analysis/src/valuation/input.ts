import type { FindingRef } from "../../../../shared/analysis-contract/findings.ts";
import type { DiagnosticMetric, FactorDistribution, PeriodType, ValuationFact } from "../../../../shared/analysis-contract/valuation.ts";
import { readFindingFundamentals, resolveRef, type FindingData } from "../../../../shared/analysis-runtime/findings.ts";
import { distributionOf } from "../../../../shared/analysis-runtime/valuation/calculator.ts";
import { sha256 } from "../company-analysis/api.ts";
import { companyName, findSecurity } from "../catalog/security-directory.ts";
import { requireDb } from "../core.ts";
import { listLibraryDocuments } from "../filing-library/store.ts";
import { readMapDerived } from "../financial-data/derived.ts";
import { readCompletePublicationForTicker } from "../financial-data/publication.ts";
import { parseFundamentalApiQuery } from "../fundamentals/fundamentals-api.ts";
import { getSecFundamentals, secFundamentalsKey } from "../fundamentals/sec-fundamentals.ts";
import { readGuidanceResponse } from "../guidance/workflow.ts";
import type { AnalysisEnv } from "../operations.ts";
import { knownCik } from "../pipeline/identity.ts";
import type { HistoricalObservation, SecHistorySnapshot } from "../sec/analysis.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { readyTranscripts } from "../transcripts/library.ts";
import type { LibraryDocumentSummary } from "../../../../shared/analysis-contract/filing-library.ts";
import type { GuidancePublication } from "../../../../shared/analysis-contract/guidance.ts";

/**
 * The material pack a valuation run starts from (docs/valuation-assessment-design.md §4, docs/valuation-methodology-optimization.md
 * §4, §7): typed facts resolved from the same stored projections the findings verify against, the company's own history
 * of each driver, the diagnostics every dimension must answer, and the catalogue of filings, guidance and calls the agent
 * may read. No model call, no SEC fetch. Everything here is deterministic, so the fingerprint says what a run would write from.
 */
export const VALUATION_INPUT_VERSION = "valuation.input.v1";
const DAY = 86_400_000;

export type ValuationDocument = { documentId: string; accession: string; form: string; docType: string; filedAt: string; reportDate: string; url: string };
export type ValuationTranscript = { id: string; periodEnd: string; title: string; filedAt: string; sourceUrl: string; characters: number; fiscalYear: number; fiscalQuarter: number };
export type ValuationInput = {
  ticker: string;
  cik: string | null;
  companyName: string;
  currency: string;
  /** The newest complete quarter the figures are read at. */
  financialPeriodEnd: string;
  incomeModel: string;
  facts: ValuationFact[];
  distributions: FactorDistribution[];
  diagnostics: DiagnosticMetric[];
  documents: ValuationDocument[];
  guidance: GuidancePublication | null;
  transcripts: ValuationTranscript[];
  /** Why a figure the models need is missing, by fact id. */
  missing: string[];
  fingerprint: string;
  data: FindingData;
};

const num = (value: string | number | null | undefined): number | null => { const n = typeof value === "number" ? value : Number(value); return Number.isFinite(n) ? n : null; };

/** The company's data as the findings and peers read it, plus the guidance the findings also carry. */
export async function readValuationData(env: AnalysisEnv, ticker: string): Promise<{ data: FindingData; snapshot: SecHistorySnapshot | null } | null> {
  const db = requireDb(env);
  const publication = await readCompletePublicationForTicker(db, ticker).catch(() => null);
  const flow = publication?.status === "ready" ? publication.flow : null;
  if (!flow?.quarters.length) return null;
  const snapshot = await readMapDerived(db, flow).catch(() => null);
  const quarters = [...new Map([...(snapshot?.reports?.quarters ?? []), ...flow.quarters].map(q => [q.periodEnd, q])).values()];
  const [fundamentals, guidance, history] = await Promise.all([
    getSecFundamentals(db, parseFundamentalApiQuery(ticker, new URLSearchParams({ periodCount: "12" }))).then(r => readFindingFundamentals(r, ticker)).catch(() => null),
    readGuidanceResponse(db, ticker).then(r => r.guidance).catch(() => null),
    new D1SecRepository(db).getCache<SecHistorySnapshot>(secFundamentalsKey(ticker)).then(r => r?.payload ?? null).catch(() => null),
  ]);
  return { data: { quarters, history: publication?.history ?? null, capital: snapshot?.capital ?? null, fundamentals, guidance }, snapshot: history };
}

type FactSpec = { id: string; label: string; ref: FindingRef; span: "quarter" | "fiscal_year"; periodType: PeriodType; required?: boolean };
/** What the models need, in the order the agent reads them; `fiscal_year` is the four quarters ending at the newest one. */
const FACT_SPECS: FactSpec[] = [
  { id: "revenue_ttm", label: "Revenue, trailing twelve months", ref: { metric: "revenue" }, span: "fiscal_year", periodType: "ttm", required: true },
  { id: "operating_income_ttm", label: "Operating income, trailing twelve months", ref: { metric: "operating" }, span: "fiscal_year", periodType: "ttm", required: true },
  { id: "pretax_income_ttm", label: "Pretax income, trailing twelve months", ref: { metric: "pretax" }, span: "fiscal_year", periodType: "ttm" },
  { id: "income_tax_ttm", label: "Income tax expense, trailing twelve months", ref: { metric: "tax" }, span: "fiscal_year", periodType: "ttm" },
  { id: "net_income_ttm", label: "Net income, trailing twelve months", ref: { metric: "net" }, span: "fiscal_year", periodType: "ttm", required: true },
  { id: "revenue_quarter", label: "Revenue, newest quarter", ref: { metric: "revenue" }, span: "quarter", periodType: "quarter" },
  { id: "cfo_ttm", label: "Operating cash flow, trailing twelve months", ref: { capital: "operatingCashFlow" }, span: "fiscal_year", periodType: "ttm", required: true },
  { id: "capex_ttm", label: "Capital expenditures (cash paid), trailing twelve months", ref: { capital: "capex" }, span: "fiscal_year", periodType: "ttm", required: true },
  { id: "da_ttm", label: "Depreciation and amortization, trailing twelve months", ref: { derived: "depreciationAmortization" }, span: "fiscal_year", periodType: "ttm" },
  { id: "sbc_ttm", label: "Stock-based compensation, trailing twelve months", ref: { derived: "stockCompensationExpense" }, span: "fiscal_year", periodType: "ttm" },
  { id: "interest_expense_ttm", label: "Interest expense, trailing twelve months", ref: { derived: "interestExpense" }, span: "fiscal_year", periodType: "ttm" },
  { id: "ebitda_ttm", label: "EBITDA, trailing twelve months", ref: { derived: "ebitda" }, span: "fiscal_year", periodType: "ttm" },
  { id: "nopat_ttm", label: "NOPAT, trailing twelve months", ref: { derived: "nopat" }, span: "fiscal_year", periodType: "ttm" },
  { id: "buybacks_ttm", label: "Share repurchases, trailing twelve months", ref: { capital: "buybacks" }, span: "fiscal_year", periodType: "ttm" },
  { id: "dividends_ttm", label: "Dividends paid, trailing twelve months", ref: { capital: "dividends" }, span: "fiscal_year", periodType: "ttm" },
  { id: "cash", label: "Cash and equivalents, newest balance sheet", ref: { capital: "cash" }, span: "quarter", periodType: "instant", required: true },
  { id: "investments", label: "Investments, newest balance sheet", ref: { capital: "investments" }, span: "quarter", periodType: "instant" },
  { id: "debt", label: "Debt, newest balance sheet", ref: { capital: "debt" }, span: "quarter", periodType: "instant", required: true },
  { id: "leases", label: "Lease liabilities, newest balance sheet", ref: { capital: "leases" }, span: "quarter", periodType: "instant" },
  { id: "equity", label: "Stockholders' equity, newest balance sheet", ref: { capital: "equity" }, span: "quarter", periodType: "instant" },
  { id: "total_assets", label: "Total assets, newest balance sheet", ref: { capital: "totalAssets" }, span: "quarter", periodType: "instant" },
  { id: "total_liabilities", label: "Total liabilities, newest balance sheet", ref: { capital: "totalLiabilities" }, span: "quarter", periodType: "instant" },
  { id: "current_assets", label: "Current assets, newest balance sheet", ref: { capital: "currentAssets" }, span: "quarter", periodType: "instant" },
  { id: "current_liabilities", label: "Current liabilities, newest balance sheet", ref: { capital: "currentLiabilities" }, span: "quarter", periodType: "instant" },
  { id: "net_debt", label: "Net debt (debt + leases − cash), newest balance sheet", ref: { derived: "netDebt" }, span: "quarter", periodType: "instant" },
  { id: "invested_capital", label: "Invested capital, newest balance sheet", ref: { derived: "investedCapital" }, span: "quarter", periodType: "instant" },
  { id: "debt_due_12m", label: "Debt due within twelve months", ref: { schedule: { kind: "debtMaturities", bucket: 1 } }, span: "quarter", periodType: "instant" },
];

const SHARE_CONCEPTS = {
  diluted: /WeightedAverageNumberOfDilutedSharesOutstanding/i, basic: /WeightedAverageNumberOfSharesOutstandingBasic/i, outstanding: /CommonStockSharesOutstanding|EntityCommonStockSharesOutstanding/i,
};

function shareFacts(snapshot: SecHistorySnapshot | null, periodEnd: string): ValuationFact[] {
  const series = snapshot?.series.find(s => s.seriesId === "shares");
  if (!series) return [];
  const all = [...series.quarters, ...series.annual].filter(o => o.endDate <= periodEnd && o.unit === "shares");
  const newest = (match: RegExp, duration: boolean) => all.filter(o => match.test(o.xbrlConcept ?? "") && (duration ? !!o.startDate : !o.startDate)).sort((a, b) => b.endDate.localeCompare(a.endDate) || (b.startDate ?? "").localeCompare(a.startDate ?? ""))[0];
  const fact = (id: string, label: string, o: HistoricalObservation | undefined, periodType: PeriodType): ValuationFact | null => {
    const value = o ? num(o.value) : null;
    return o && value != null && value > 0 ? { id, label, value, unit: "shares", currency: null, periodType, periodStart: o.startDate ?? null, periodEnd: o.endDate, basis: "reported", formula: null, sourceRefs: [o.xbrlConcept ?? o.seriesId, o.sourceAccession].filter(Boolean), rationale: null } : null;
  };
  const diluted = newest(SHARE_CONCEPTS.diluted, true), basic = newest(SHARE_CONCEPTS.basic, true), outstanding = newest(SHARE_CONCEPTS.outstanding, false);
  return [
    fact("shares_diluted_weighted", "Diluted weighted-average shares, newest period", diluted, diluted?.periodScope === "annual" ? "fiscal_year" : "quarter"),
    fact("shares_basic_weighted", "Basic weighted-average shares, newest period", basic, basic?.periodScope === "annual" ? "fiscal_year" : "quarter"),
    fact("shares_outstanding", "Common shares outstanding, newest reported", outstanding, "instant"),
  ].filter((f): f is ValuationFact => f != null);
}

/** Every fact the specs name that the stored data can resolve at the newest quarter, with what is missing. */
export function buildFacts(data: FindingData, snapshot: SecHistorySnapshot | null, periodEnd: string, currency: string): { facts: ValuationFact[]; missing: string[] } {
  const facts: ValuationFact[] = [];
  const missing: string[] = [];
  for (const spec of FACT_SPECS) {
    const resolved = resolveRef(data, spec.ref, periodEnd, spec.span);
    if (!resolved || resolved.range) { if (spec.required) missing.push(spec.id); continue; }
    facts.push({ id: spec.id, label: spec.label, value: resolved.value, unit: resolved.unit === "USD" ? (resolved.currency ?? currency) : resolved.unit, currency: resolved.unit === "USD" ? resolved.currency ?? currency : null,
      periodType: spec.periodType, periodStart: resolved.periodStart, periodEnd: resolved.periodEnd, basis: "derived" in spec.ref ? "derived" : "reported", formula: "derived" in spec.ref ? spec.ref.derived : null, sourceRefs: resolved.accessions, rationale: null });
  }
  const shares = shareFacts(snapshot, periodEnd);
  facts.push(...shares);
  if (!shares.some(s => s.id === "shares_diluted_weighted")) missing.push("shares_diluted_weighted");
  // Derived ratios the models start from, each with its formula in fact ids.
  const by = (id: string) => facts.find(f => f.id === id)?.value ?? null;
  const derived = (id: string, label: string, value: number | null, formula: string, unit = "ratio") => { if (value != null && Number.isFinite(value)) facts.push({ id, label, value, unit, currency: null, periodType: "ttm", periodStart: null, periodEnd, basis: "derived", formula, sourceRefs: [], rationale: null }); };
  const revenue = by("revenue_ttm"), operating = by("operating_income_ttm"), pretax = by("pretax_income_ttm"), tax = by("income_tax_ttm");
  derived("operating_margin_ttm", "Operating margin, trailing twelve months", revenue && operating != null ? operating / revenue : null, "operating_income_ttm / revenue_ttm");
  derived("effective_tax_rate_ttm", "Effective tax rate, trailing twelve months", pretax && pretax > 0 && tax != null ? Math.min(Math.max(tax / pretax, 0), 0.6) : null, "income_tax_ttm / pretax_income_ttm");
  derived("fcf_ttm", "Free cash flow (CFO − capex), trailing twelve months", by("cfo_ttm") != null && by("capex_ttm") != null ? by("cfo_ttm")! - Math.abs(by("capex_ttm")!) : null, "cfo_ttm − capex_ttm", currency);
  return { facts, missing };
}

type Point = { periodEnd: string; value: number };
const yearly = (series: HistoricalObservation[]) => series.filter(o => o.periodScope === "annual" && !!o.startDate).sort((a, b) => a.endDate.localeCompare(b.endDate));
const instants = (series: HistoricalObservation[]) => series.filter(o => o.periodScope === "annual" && !o.startDate).sort((a, b) => a.endDate.localeCompare(b.endDate));

/** Each driver's yearly history from the validated annual series, as the distribution an assumption is placed in. */
export function buildDistributions(snapshot: SecHistorySnapshot | null, data: FindingData): FactorDistribution[] {
  const out: FactorDistribution[] = [];
  const series = (id: string) => snapshot?.series.find(s => s.seriesId === id);
  const revenue = yearly(series("revenue")?.annual ?? []), operating = yearly(series("operating_income")?.annual ?? []), net = yearly(series("net_income")?.annual ?? []);
  const cfo = yearly(series("operating_cash_flow")?.annual ?? []), capex = yearly(series("capex")?.annual ?? []), equity = instants(series("equity")?.annual ?? []), sbc = yearly(series("stock_compensation")?.annual ?? []);
  const at = (list: HistoricalObservation[], end: string) => num(list.find(o => o.endDate === end)?.value);
  const points = (list: HistoricalObservation[], f: (end: string) => number | null): Point[] => list.flatMap(o => { const v = f(o.endDate); return v == null ? [] : [{ periodEnd: o.endDate, value: v }]; });
  const growth: Point[] = [];
  for (let i = 1; i < revenue.length; i++) { const prev = num(revenue[i - 1]!.value), cur = num(revenue[i]!.value); if (prev && cur != null && prev > 0) growth.push({ periodEnd: revenue[i]!.endDate, value: cur / prev - 1 }); }
  // Trailing-four-quarter windows add recent observations the annual list does not have yet.
  const quarters = [...data.quarters].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  for (let i = 4; i < quarters.length; i++) {
    const end = quarters[i]!.periodEnd;
    if (revenue.some(o => o.endDate === end)) continue;
    const rev = resolveRef(data, { metric: "revenue" }, end, "fiscal_year"), op = resolveRef(data, { metric: "operating" }, end, "fiscal_year");
    const prior = quarters[i - 4] ? resolveRef(data, { metric: "revenue" }, quarters[i - 4]!.periodEnd, "fiscal_year") : null;
    if (rev && prior && prior.value > 0) growth.push({ periodEnd: end, value: rev.value / prior.value - 1 });
    if (rev && op && rev.value > 0) out.push({ factor: "_tmp_margin", periods: [{ periodEnd: end, value: op.value / rev.value }], min: 0, p25: 0, median: 0, p75: 0, max: 0 });
  }
  const recentMargins = out.filter(d => d.factor === "_tmp_margin").flatMap(d => d.periods);
  out.length = 0;
  const push = (factor: string, list: Point[]) => { const d = distributionOf(factor, list.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))); if (d) out.push(d); };
  push("revenueGrowth", growth);
  push("operatingMargin", [...points(operating, end => { const r = at(revenue, end), o = at(operating, end); return r && o != null && r > 0 ? o / r : null; }), ...recentMargins]);
  push("netMargin", points(net, end => { const r = at(revenue, end), n = at(net, end); return r && n != null && r > 0 ? n / r : null; }));
  push("fcfMargin", points(cfo, end => { const r = at(revenue, end), c = at(cfo, end), x = at(capex, end); return r && c != null && x != null && r > 0 ? (c - Math.abs(x)) / r : null; }));
  push("capexToRevenue", points(capex, end => { const r = at(revenue, end), x = at(capex, end); return r && x != null && r > 0 ? Math.abs(x) / r : null; }));
  push("sbcToRevenue", points(sbc, end => { const r = at(revenue, end), s = at(sbc, end); return r && s != null && r > 0 ? s / r : null; }));
  push("returnOnEquity", points(net, end => { const n = at(net, end), e = at(equity, end); return n != null && e && e > 0 ? n / e : null; }));
  return out;
}

const metric = (key: string, label: string, value: number | null, unit: DiagnosticMetric["unit"], periodEnd: string | null, note: string | null = null): DiagnosticMetric => ({ key, label, value: value != null && Number.isFinite(value) ? value : null, unit, periodEnd, note });

/** The figures every dimension has to answer to, from the facts alone (docs/valuation-methodology-optimization.md §7). */
export function buildDiagnostics(facts: ValuationFact[], snapshot: SecHistorySnapshot | null, data: FindingData, periodEnd: string): DiagnosticMetric[] {
  const by = (id: string) => facts.find(f => f.id === id)?.value ?? null;
  const revenue = by("revenue_ttm"), net = by("net_income_ttm"), cfo = by("cfo_ttm"), capex = by("capex_ttm") != null ? Math.abs(by("capex_ttm")!) : null;
  const ebitda = by("ebitda_ttm"), netDebt = by("net_debt"), interest = by("interest_expense_ttm"), operating = by("operating_income_ttm");
  const assets = by("total_assets"), da = by("da_ttm"), sbc = by("sbc_ttm"), nopat = by("nopat_ttm"), invested = by("invested_capital");
  const yearAgo = data.quarters.map(q => q.periodEnd).filter(end => end < periodEnd).sort().reverse()[3] ?? null;
  const priorRevenue = yearAgo ? resolveRef(data, { metric: "revenue" }, yearAgo, "fiscal_year")?.value ?? null : null;
  const shares = snapshot?.series.find(s => s.seriesId === "shares");
  const outstanding = shares ? instants(shares.annual.filter(o => SHARE_CONCEPTS.outstanding.test(o.xbrlConcept ?? ""))) : [];
  const first = outstanding[0], last = outstanding.at(-1);
  const years = first && last && first !== last ? (Date.parse(last.endDate) - Date.parse(first.endDate)) / (365.25 * DAY) : 0;
  const dilution = first && last && years >= 1 && num(first.value) && num(last.value) ? (num(last.value)! / num(first.value)!) ** (1 / years) - 1 : null;
  const fcf = cfo != null && capex != null ? cfo - capex : null;
  return [
    metric("revenueGrowthTtm", "Revenue growth, trailing twelve months year on year", revenue != null && priorRevenue ? revenue / priorRevenue - 1 : null, "percent", periodEnd),
    metric("roic", "Return on invested capital (NOPAT / invested capital)", nopat != null && invested ? nopat / invested : null, "percent", periodEnd),
    metric("accrualRatio", "Accrual ratio ((net income − CFO) / total assets)", net != null && cfo != null && assets ? (net - cfo) / assets : null, "percent", periodEnd),
    metric("fcfConversion", "Free cash flow conversion (FCF / net income)", fcf != null && net && net > 0 ? fcf / net : null, "x", periodEnd, net != null && net <= 0 ? "not computed: net income is not positive" : null),
    metric("sbcToRevenue", "Stock-based compensation / revenue", sbc != null && revenue ? sbc / revenue : null, "percent", periodEnd),
    metric("capexToDa", "Capex / depreciation and amortization", capex != null && da ? capex / da : null, "x", periodEnd),
    metric("netDebtToEbitda", "Net debt / EBITDA", netDebt != null && ebitda ? netDebt / ebitda : null, "x", periodEnd, ebitda != null && ebitda <= 0 ? "EBITDA not positive" : null),
    metric("interestCoverage", "Interest coverage (operating income / interest expense)", operating != null && interest ? operating / interest : null, "x", periodEnd, interest === 0 ? "no interest expense reported" : null),
    metric("dilutionCagr", "Shares outstanding, annual change", dilution, "percent", last?.endDate ?? null, first && last ? `${first.endDate} to ${last.endDate}` : "fewer than two annual share counts"),
    metric("cashRunwayYears", "Cash runway at the trailing cash burn", fcf != null && fcf < 0 && by("cash") != null ? by("cash")! / -fcf : null, "years", periodEnd, fcf != null && fcf >= 0 ? "not computed: free cash flow is positive" : null),
    metric("debtDueCoverage", "Cash / debt due within twelve months", by("debt_due_12m") ? by("cash")! / by("debt_due_12m")! : null, "x", periodEnd),
  ];
}

const DOCUMENT_FORMS = ["10-K", "10-Q", "20-F", "40-F", "8-K", "6-K", "10-K/A", "10-Q/A"];
/** The filings a run may read: the newest two annual reports, the newest four quarterlies and the newest six current reports, all filed by the research date. */
export function selectDocuments(documents: LibraryDocumentSummary[], researchAsOf: string): ValuationDocument[] {
  const ready = documents.filter(d => d.status === "ready" && d.filedAt.slice(0, 10) <= researchAsOf.slice(0, 10)).sort((a, b) => b.filedAt.localeCompare(a.filedAt));
  const take = (test: (form: string) => boolean, n: number) => ready.filter(d => test(d.form)).slice(0, n);
  const chosen = [...take(f => /^(10-K|20-F|40-F)/.test(f), 2), ...take(f => /^10-Q/.test(f), 4), ...take(f => /^(8-K|6-K)/.test(f), 6)];
  return [...new Map(chosen.map(d => [d.documentId, d])).values()].map(d => ({ documentId: d.documentId, accession: d.accessionNumber, form: d.form, docType: d.docType, filedAt: d.filedAt, reportDate: d.reportDate, url: d.documentUrl }));
}

/** Everything a run starts from, or null while the company has no complete statement to value. */
export async function buildValuationInput(env: AnalysisEnv, ticker: string, researchAsOf: string): Promise<ValuationInput | null> {
  const db = requireDb(env);
  const read = await readValuationData(env, ticker);
  if (!read) return null;
  const { data, snapshot } = read;
  const newest = [...data.quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  if (!newest) return null;
  const currency = newest.currency;
  const { facts, missing } = buildFacts(data, snapshot, newest.periodEnd, currency);
  const distributions = buildDistributions(snapshot, data);
  const diagnostics = buildDiagnostics(facts, snapshot, data, newest.periodEnd);
  const [library, calls, cik] = await Promise.all([
    listLibraryDocuments(db, { ticker, forms: DOCUMENT_FORMS, limit: 120 }).catch(() => [] as LibraryDocumentSummary[]),
    readyTranscripts(db, ticker, new Date(Date.parse(newest.periodEnd) - 400 * DAY).toISOString().slice(0, 10)).catch(() => []),
    knownCik(db, ticker).catch(() => null),
  ]);
  const documents = selectDocuments(library, researchAsOf);
  const transcripts: ValuationTranscript[] = calls.filter(c => c.filedAt.slice(0, 10) <= researchAsOf.slice(0, 10)).slice(0, 4)
    .map(c => ({ id: c.id, periodEnd: c.periodEnd, title: c.title, filedAt: c.filedAt, sourceUrl: c.sourceUrl, characters: c.content.length, fiscalYear: c.fiscalYear, fiscalQuarter: c.fiscalQuarter }));
  const guidanceHash = data.guidance ? await sha256(JSON.stringify([data.guidance.items, data.guidance.sources])) : null;
  const fingerprint = await sha256(JSON.stringify({
    version: VALUATION_INPUT_VERSION, ticker, periodEnd: newest.periodEnd, currency,
    facts: facts.map(f => [f.id, f.value, f.periodEnd]), quarters: data.quarters.map(q => q.periodEnd).sort(),
    documents: documents.map(d => d.documentId).sort(), guidance: guidanceHash, transcripts: transcripts.map(t => [t.id, t.characters]).sort(),
  }));
  return {
    ticker, cik, companyName: companyName(ticker) ?? findSecurity(ticker)?.name ?? ticker, currency, financialPeriodEnd: newest.periodEnd, incomeModel: newest.incomeModel ?? "unknown",
    facts, distributions, diagnostics, documents, guidance: data.guidance, transcripts, missing, fingerprint, data,
  };
}
