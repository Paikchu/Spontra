import { readPeriodExtract } from "../extract/period-extract.ts";
import type { FindingRef } from "../../../../shared/analysis-contract/findings.ts";
import type { DiagnosticMetric, FactorDistribution, ManagementTargetSet, PeerSelectionBasis, PeriodType, ValuationFact } from "../../../../shared/analysis-contract/valuation.ts";
import type { BalanceSheet, RpoDisclosure } from "../../../../shared/analysis-contract/capital-structure.ts";
import type { PeerCompany, PeersPublication } from "../../../../shared/analysis-contract/peers.ts";
import { readFindingFundamentals, resolveRef, type FindingData } from "../../../../shared/analysis-runtime/findings.ts";
import { readFilingLeaseFacts } from "./filing-lease-facts.ts";
import { selectPeers } from "../../../../shared/analysis-runtime/valuation/peers.ts";
import { coreEquityEarnings, distributionOf, type Lifecycle } from "../../../../shared/analysis-runtime/valuation/calculator.ts";
import { financeLeaseAmount, operatingExpenseNetDebt } from "../../../../shared/analysis-runtime/valuation/lease-basis.ts";
import { lifecycleOf } from "../../../../shared/analysis-runtime/valuation/prior.ts";
import { readPeersResponse } from "../peers/read.ts";
import { managementTargetSet, readValuationCompanyInputs } from "./curated.ts";
import { readFiscalFocus } from "../read-api/fiscal-periods.ts";
import { sha256 } from "../sha256.ts";
import { companyName } from "../catalog/issuer-directory.ts";
import { requireDb } from "../core.ts";
import { listLibraryDocuments } from "../filing-library/store.ts";
import { readMapDerived } from "../financial-data/derived.ts";
import { readCompletePublicationForTicker } from "../financial-data/publication.ts";
import { parseFundamentalApiQuery } from "../fundamentals/fundamentals-api.ts";
import { getSecFundamentals, secFundamentalsKey } from "../fundamentals/sec-fundamentals.ts";
import type { AnalysisEnv } from "../operations.ts";
import { knownCik } from "../pipeline/identity.ts";
import type { HistoricalObservation, SecHistorySnapshot } from "../sec/analysis.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { readyTranscripts } from "../transcripts/library.ts";
import type { LibraryDocumentSummary } from "../../../../shared/analysis-contract/filing-library.ts";

/**
 * The material pack a valuation run starts from: typed facts resolved from the same stored projections the findings verify against, the company's own history
 * of each driver, the diagnostics every dimension must answer, and the catalogue of filings and calls the agent
 * may read. No model call, no SEC fetch. Everything here is deterministic, so the fingerprint says what a run would write from.
 */
export const VALUATION_INPUT_VERSION = "valuation.input.v5";
const DAY = 86_400_000;

export type ValuationDocument = { documentId: string; accession: string; form: string; docType: string; filedAt: string; reportDate: string; url: string };
export type ValuationTranscript = { id: string; periodEnd: string; title: string; filedAt: string; sourceUrl: string; characters: number; fiscalYear: number; fiscalQuarter: number };
/** A peer's trailing figures from the peers projection and the SEC share series, for the forward-multiple cross-check; `weight` is its share of the weighted quartiles. */
export type PeerFundamentals = { ticker: string; periodEnd: string; ebitda: number | null; coreEarnings: number | null; netDebt: number | null; shares: number | null; weight: number };
/** Trailing EBITDA and net debt per quarter, for the company's own EV/EBITDA history. */
export type TrailingQuarter = { periodEnd: string; ebitdaTtm: number; netDebt: number };
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
  transcripts: ValuationTranscript[];
  /** Why a figure the models need is missing, by fact id. */
  missing: string[];
  fingerprint: string;
  /** The newest RPO disclosure, for the contracted-revenue floor. */
  rpo: RpoDisclosure | null;
  lifecycle: Lifecycle;
  /** The comparable set (shared/analysis-runtime/valuation/peers.ts): the admin's set, business-tag pairs, else shared categories; not part of the fingerprint. */
  peers: PeerFundamentals[];
  peerBasis: PeerSelectionBasis;
  /** Why peers were chosen or dropped: the selection's notes and each exclusion (loss-making, no EBITDA, incomplete figures). */
  peerNotes: string[];
  /** Management's cited targets the admin keeps for the company, when it has a current set; part of the fingerprint. */
  management: ManagementTargetSet | null;
  /** Why a stored target set was not used (too old, no fiscal-year end). */
  managementNotes: string[];
  trailingQuarters: TrailingQuarter[];
};

const num = (value: string | number | null | undefined): number | null => { if (value == null || value === "") return null; const n = typeof value === "number" ? value : Number(value); return Number.isFinite(n) ? n : null; };

/**
 * The company's data as layer 2's per-period extract holds it (the statements, capital and fundamentals the
 * findings read too), with the share-count history its facts are cut from; null until layer 2 has cut the extract.
 */
export async function readValuationData(env: AnalysisEnv, ticker: string): Promise<{ data: FindingData; snapshot: SecHistorySnapshot | null } | null> {
  const db = requireDb(env);
  const extract = await readPeriodExtract(db, ticker);
  if (!extract?.data.quarters.length) return null;
  const history = await new D1SecRepository(db).getCache<SecHistorySnapshot>(secFundamentalsKey(ticker)).then(r => r?.payload ?? null).catch(() => null);
  return { data: extract.data, snapshot: history };
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
  { id: "equity", label: "Stockholders' equity, newest balance sheet", ref: { capital: "equity" }, span: "quarter", periodType: "instant" },
  { id: "total_assets", label: "Total assets, newest balance sheet", ref: { capital: "totalAssets" }, span: "quarter", periodType: "instant" },
  { id: "total_liabilities", label: "Total liabilities, newest balance sheet", ref: { capital: "totalLiabilities" }, span: "quarter", periodType: "instant" },
  { id: "current_assets", label: "Current assets, newest balance sheet", ref: { capital: "currentAssets" }, span: "quarter", periodType: "instant" },
  { id: "current_liabilities", label: "Current liabilities, newest balance sheet", ref: { capital: "currentLiabilities" }, span: "quarter", periodType: "instant" },
  { id: "debt_due_12m", label: "Debt due within twelve months", ref: { schedule: { kind: "debtMaturities", bucket: 1 } }, span: "quarter", periodType: "instant" },
  { id: "rpo_total", label: "Remaining performance obligations, newest disclosure", ref: { capital: "rpo" }, span: "quarter", periodType: "instant" },
  { id: "rpo_next_12m_share", label: "Share of RPO recognized within twelve months", ref: { capital: "rpoNext12MonthsShare" }, span: "quarter", periodType: "instant" },
];
/** Claims ahead of common equity the balance sheet carries under equity: preferred stock and minority interests, by concept. */
const SENIOR_EQUITY = { preferred: /Preferred/i, minority: /MinorityInterest|Noncontrolling/i };

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

/** Classified lease amounts from the reconciled balance sheet. An unclassified row keeps the split unknown. */
function leaseFactsOf(sheet: BalanceSheet | null): ValuationFact[] {
  if (!sheet) return [];
  const rows = sheet.liabilities.filter(l => l.group === "leases");
  const classified = rows.map(l => {
    const text = `${l.concept} ${l.label}`;
    const kind = /Debt.*(?:Finance|Capital)Lease|debt.*(?:finance|capital) lease/i.test(text) ? null : /OperatingLease|operating lease/i.test(text) ? "operating" : /FinanceLease|CapitalLease|financ(?:e|ing) lease|capital lease/i.test(text) ? "finance" : null;
    return { line: l, kind, value: num(l.value) };
  });
  const fact = (id: string, label: string, value: number, lines: typeof rows, rationale: string | null = null): ValuationFact => ({ id, label, value, unit: sheet.currency, currency: sheet.currency, periodType: "instant", periodStart: null, periodEnd: sheet.asOf, basis: "derived", formula: `sum(${lines.map(l => l.concept).join(", ")})`, sourceRefs: [...lines.map(l => l.concept), sheet.source.accession], rationale });
  const out: ValuationFact[] = [];
  if (classified.length && classified.every(l => l.kind && l.value != null)) {
    for (const kind of ["operating", "finance"] as const) {
      const matching = classified.filter(l => l.kind === kind);
      const totals = matching.filter(l => /(?:Operating|Finance)LeaseLiability$|CapitalLeaseObligations?$/i.test(l.line.concept.split(":").at(-1)!));
      const current = matching.filter(l => /Current$/i.test(l.line.concept) && !/Noncurrent$/i.test(l.line.concept));
      const noncurrent = matching.filter(l => /Noncurrent$/i.test(l.line.concept));
      const complete = totals.length ? totals : current.length && noncurrent.length ? [...current, ...noncurrent] : [];
      if (complete.length) out.push(fact(`${kind}_leases`, `${kind === "operating" ? "Operating" : "Finance"} lease liabilities, newest balance sheet`, complete.reduce((sum, l) => sum + l.value!, 0), complete.map(l => l.line)));
    }
  }
  const overlap = sheet.liabilities.filter(l => l.group === "debt" && /Debt.*(?:Finance|Capital)Lease|debt.*(?:finance|capital) lease/i.test(`${l.concept} ${l.label}`));
  if (overlap.length) out.push({ ...fact("finance_lease_debt_overlap", "Debt may already include finance leases", 1, overlap, "The debt rows combine debt and finance leases; their overlapping amount must be reconciled before adding finance leases."), unit: "ratio", currency: null });
  return out;
}

const sheetAt = (data: FindingData, periodEnd: string) => data.capital?.quarters.find(q => Math.abs(Date.parse(q.periodEnd) - Date.parse(periodEnd)) <= 20 * DAY)?.balanceSheet ?? null;

/** Every fact the specs name that the stored data can resolve at the newest quarter, with what is missing. */
function buildFacts(data: FindingData, snapshot: SecHistorySnapshot | null, periodEnd: string, currency: string, disclosedLeases: readonly ValuationFact[] = []): { facts: ValuationFact[]; missing: string[] } {
  const facts: ValuationFact[] = [];
  const missing: string[] = [];
  for (const spec of FACT_SPECS) {
    const resolved = resolveRef(data, spec.ref, periodEnd, spec.span);
    if (!resolved) { if (spec.required) missing.push(spec.id); continue; }
    // A percent resolves in percent points; facts carry ratios.
    const percent = resolved.unit === "percent";
    facts.push({ id: spec.id, label: spec.label, value: percent ? resolved.value / 100 : resolved.value, unit: resolved.unit === "USD" ? (resolved.currency ?? currency) : percent ? "ratio" : resolved.unit, currency: resolved.unit === "USD" ? resolved.currency ?? currency : null,
      periodType: spec.periodType, periodStart: resolved.periodStart, periodEnd: resolved.periodEnd, basis: "derived" in spec.ref ? "derived" : "reported", formula: "derived" in spec.ref ? spec.ref.derived : null, sourceRefs: resolved.accessions, rationale: null });
  }
  const sheet = sheetAt(data, periodEnd);
  facts.push(...leaseFactsOf(sheet));
  if (sheet) {
    const senior = (id: string, label: string, test: RegExp) => {
      const lines = sheet.equity.filter(l => test.test(l.concept) || test.test(l.id));
      const value = lines.reduce((sum, l) => sum + (num(l.value) ?? 0), 0);
      if (lines.length && value > 0) facts.push({ id, label, value, unit: currency, currency, periodType: "instant", periodStart: null, periodEnd: sheet.asOf, basis: "reported", formula: null, sourceRefs: [...lines.map(l => l.concept), sheet.source.accession], rationale: null });
    };
    senior("preferred_stock", "Preferred stock, newest balance sheet", SENIOR_EQUITY.preferred);
    senior("minority_interest", "Noncontrolling interests, newest balance sheet", SENIOR_EQUITY.minority);
  }
  for (const disclosed of disclosedLeases) {
    const index = facts.findIndex(f => f.id === disclosed.id);
    if (index >= 0) facts[index] = disclosed; else facts.push(disclosed);
  }
  const operatingLeaseFact = facts.find(f => f.id === "operating_leases"), finance = facts.find(f => f.id === "finance_leases");
  if (operatingLeaseFact && finance && !facts.some(f => f.id === "leases")) facts.push({ ...operatingLeaseFact, id: "leases", label: "Total operating and finance lease liabilities", value: operatingLeaseFact.value + finance.value, basis: "derived", formula: "operating_leases + finance_leases", sourceRefs: [...new Set([...operatingLeaseFact.sourceRefs, ...finance.sourceRefs])] });
  const financeLeases = financeLeaseAmount(facts);
  if (financeLeases == null) missing.push("finance_leases");
  const value = (id: string) => facts.find(f => f.id === id)?.value ?? null;
  const claims = operatingExpenseNetDebt(facts);
  const bridgeSources = facts.filter(f => ["debt", "finance_leases", "cash", "investments", "preferred_stock", "minority_interest"].includes(f.id)).flatMap(f => f.sourceRefs);
  const bridgeFact = (id: string, label: string, amount: number, formula: string) => facts.push({ id, label, value: amount, unit: currency, currency, periodType: "instant", periodStart: null, periodEnd, basis: "derived", formula, sourceRefs: [...new Set(bridgeSources)], rationale: "Operating rent remains an expense; operating lease liabilities are excluded." });
  if (claims != null) bridgeFact("net_debt", "Financing claims net of cash and investments", claims, "debt + finance_leases + preferred_stock + minority_interest − cash − investments");
  if (financeLeases != null && value("debt") != null && value("equity") != null && value("cash") != null && value("finance_lease_debt_overlap") !== 1) bridgeFact("invested_capital", "Invested capital excluding operating leases", value("debt")! + financeLeases + value("equity")! - value("cash")! - (value("investments") ?? 0), "debt + finance_leases + equity − cash − investments");
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

/** The figures every dimension has to answer to, from the facts alone. */
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

const ttmOf = (company: PeerCompany, figure: keyof PeerCompany["quarters"][number]["figures"]): number | null => {
  const values = company.quarters.slice(0, 4).map(q => num(q.figures[figure]));
  return values.length === 4 && values.every((v): v is number => v != null) ? values.reduce((a, b) => a + b, 0) : null;
};
/** Peers use the same after-interest operating earnings formula as the subject, at an explicit normalized tax assumption. */
const CORE_TAX = 0.21;

async function peerInterestExpense(db: D1Database, ticker: string, periodEnd: string): Promise<number | null> {
  const response = await getSecFundamentals(db, parseFundamentalApiQuery(ticker, new URLSearchParams({ metrics: "nonoperating_interest_expense", periodCount: "12" })));
  const fundamentals = readFindingFundamentals(response, ticker);
  const value = resolveRef({ quarters: [], history: null, capital: null, fundamentals }, { fundamental: "nonoperating_interest_expense" }, periodEnd, "fiscal_year");
  return value?.currency === "USD" ? value.value : null;
}

/**
 * The peers' trailing EBITDA, core earnings and net debt from the peers projection, with their newest SEC share count.
 * A peer that is loss-making (trailing operating income at or below zero), has EBITDA at or below zero, or lacks a
 * figure the multiples need is dropped with a note, so the quartiles are over companies whose multiples mean something.
 */
async function buildPeerFundamentals(db: D1Database, ticker: string, peers: PeersPublication | null, curated: string[] | null, sharesOf?: (peer: string, periodEnd: string) => Promise<number | null>, balanceSheetOf?: (peer: string, periodEnd: string) => Promise<BalanceSheet | null>, disclosedLeasesOf?: (peer: string, periodEnd: string, sheet: BalanceSheet | null) => Promise<ValuationFact[]>, interestExpenseOf: (peer: string, periodEnd: string) => Promise<number | null> = (peer, periodEnd) => peerInterestExpense(db, peer, periodEnd)): Promise<{ peers: PeerFundamentals[]; basis: ValuationInput["peerBasis"]; notes: string[] }> {
  if (!peers) return { peers: [], basis: "none", notes: ["no peers projection"] };
  const selection = selectPeers(peers, ticker, curated);
  const repository = new D1SecRepository(db);
  const shares = sharesOf ?? (async (peer: string, periodEnd: string) => {
    const snapshot = await repository.getCache<SecHistorySnapshot>(secFundamentalsKey(peer)).then(r => r?.payload ?? null).catch(() => null);
    return shareFacts(snapshot, periodEnd.slice(0, 4) + "-12-31").find(f => f.id === "shares_outstanding")?.value ?? shareFacts(snapshot, "9999-12-31").find(f => f.id === "shares_diluted_weighted")?.value ?? null;
  });
  const balanceSheet = balanceSheetOf ?? (async (peer: string, periodEnd: string) => {
    const published = await readCompletePublicationForTicker(db, peer);
    if (published?.status !== "ready" || !published.flow) return null;
    const derived = await readMapDerived(db, published.flow);
    return derived?.capital?.quarters.find(q => Math.abs(Date.parse(q.periodEnd) - Date.parse(periodEnd)) <= 20 * DAY)?.balanceSheet ?? null;
  });
  const out: PeerFundamentals[] = [];
  const notes = [...selection.notes];
  for (const peer of selection.tickers.slice(0, 12)) {
    const company = peers.companies.find(c => c.ticker === peer);
    const newest = company?.quarters[0];
    if (!company || !newest) { notes.push(`${peer}: no quarters in the projection`); continue; }
    const operating = ttmOf(company, "operatingIncome"), depreciation = ttmOf(company, "depreciation");
    const debt = num(newest.figures.debt), cash = num(newest.figures.cash);
    const [count, sheet] = await Promise.all([shares(peer, newest.periodEnd), balanceSheet(peer, newest.periodEnd).catch(() => null)]);
    let disclosed: ValuationFact[] = [];
    try { if (disclosedLeasesOf) disclosed = await disclosedLeasesOf(peer, newest.periodEnd, sheet); }
    catch (error) { notes.push(`${peer}: archived lease disclosure unavailable (${error instanceof Error ? error.message : String(error)}); omitted from the comparison`); continue; }
    const disclosedIds = new Set(disclosed.map(f => f.id));
    const leaseFacts = [...leaseFactsOf(sheet).filter(f => !disclosedIds.has(f.id)), ...disclosed];
    const senior = (test: RegExp) => sheet?.equity.filter(l => test.test(l.concept) || test.test(l.id)).reduce((sum, l) => sum + (num(l.value) ?? 0), 0) ?? 0;
    const financing = [...leaseFacts, ...(debt != null ? [{ id: "debt", value: debt }] : []), ...(cash != null ? [{ id: "cash", value: cash }] : []), { id: "investments", value: sheet?.assets.filter(l => l.group === "investments").reduce((sum, l) => sum + (num(l.value) ?? 0), 0) ?? 0 }, { id: "preferred_stock", value: senior(SENIOR_EQUITY.preferred) }, { id: "minority_interest", value: senior(SENIOR_EQUITY.minority) }];
    if (financeLeaseAmount(financing) == null || financing.some(f => f.id === "finance_lease_debt_overlap" && f.value === 1)) notes.push(`${peer}: lease classification or finance-lease/debt overlap is unresolved; omitted from the operating-expense EV comparison`);
    const ebitda = operating != null && depreciation != null ? operating + depreciation : null, netDebt = operatingExpenseNetDebt(financing);
    if (operating == null || ebitda == null || netDebt == null || count == null) { notes.push(`${peer}: incomplete figures (${[operating == null && "operating income", depreciation == null && "D&A", netDebt == null && "net debt", count == null && "shares"].filter(Boolean).join(", ")})`); continue; }
    if (operating <= 0) { notes.push(`${peer}: loss-making (trailing operating income ${operating.toExponential(2)})`); continue; }
    if (ebitda <= 0) { notes.push(`${peer}: EBITDA not positive`); continue; }
    const interest = await interestExpenseOf(peer, newest.periodEnd).catch(() => null);
    const coreEarnings = coreEquityEarnings(operating, interest, CORE_TAX);
    if (coreEarnings == null) notes.push(`${peer}: reported trailing interest expense is unavailable; P/E omitted, EV/EBITDA retained`);
    else if (coreEarnings <= 0) notes.push(`${peer}: normalized after-interest earnings are not positive; P/E omitted, EV/EBITDA retained`);
    out.push({ ticker: peer, periodEnd: newest.periodEnd, ebitda, coreEarnings, netDebt, shares: count, weight: selection.weights[peer] ?? 1 });
  }
  if (out.length < 2 && out.length) notes.push(`only ${out[0]!.ticker} qualifies; quartiles need two peers`);
  const total = out.reduce((sum, p) => sum + p.weight, 0);
  for (const p of out) p.weight = total > 0 ? p.weight / total : 1 / out.length;
  return { peers: out, basis: out.length ? selection.basis : "none", notes };
}

/** Trailing EBITDA and net debt at each quarter the data can answer, newest first. */
export function buildTrailingQuarters(data: FindingData, disclosedLeases: ReadonlyMap<string, readonly ValuationFact[]> = new Map()): TrailingQuarter[] {
  const ends = [...new Set(data.quarters.map(q => q.periodEnd))].sort().reverse();
  return ends.flatMap(end => {
    const ebitda = resolveRef(data, { derived: "ebitda" }, end, "fiscal_year");
    const currency = data.quarters.find(q => q.periodEnd === end)?.currency ?? "USD";
    const netDebt = operatingExpenseNetDebt(buildFacts(data, null, end, currency, disclosedLeases.get(end)).facts);
    return ebitda && netDebt != null ? [{ periodEnd: end, ebitdaTtm: ebitda.value, netDebt }] : [];
  });
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
  const leases = await readFilingLeaseFacts({ DB: db, SEC_FILINGS: env.SEC_FILINGS }, { ticker, periodEnd: newest.periodEnd, currency, researchAsOf, preferredAccession: sheetAt(data, newest.periodEnd)?.source.accession });
  const { facts, missing } = buildFacts(data, snapshot, newest.periodEnd, currency, leases.facts);
  missing.push(...leases.unresolved);
  const distributions = buildDistributions(snapshot, data);
  const diagnostics = buildDiagnostics(facts, snapshot, data, newest.periodEnd);
  const [library, calls, cik, peerPublication, inputs, calendar] = await Promise.all([
    listLibraryDocuments(db, { ticker, forms: DOCUMENT_FORMS, limit: 120 }).catch(() => [] as LibraryDocumentSummary[]),
    readyTranscripts(db, ticker, new Date(Date.parse(newest.periodEnd) - 400 * DAY).toISOString().slice(0, 10)).catch(() => []),
    knownCik(db, ticker).catch(() => null),
    readPeersResponse(db).then(r => r.peers).catch(() => null),
    readValuationCompanyInputs(db, ticker).catch(() => null),
    readFiscalFocus(db, ticker).then(map => map.issuers.get(ticker)?.fiscalYearEndMonth ?? null).catch(() => null),
  ]);
  const peers = await buildPeerFundamentals(db, ticker, peerPublication, inputs?.peers ?? null, undefined, undefined, async (peer, periodEnd, sheet) => (await readFilingLeaseFacts({ DB: db, SEC_FILINGS: env.SEC_FILINGS }, { ticker: peer, periodEnd, currency, researchAsOf, preferredAccession: sheet?.source.accession })).facts).catch(() => ({ peers: [] as PeerFundamentals[], basis: "none" as const, notes: ["peer fundamentals could not be read"] }));
  const { set: management, notes: managementNotes } = managementTargetSet(ticker, inputs?.targets ?? null, calendar, researchAsOf);
  const rpo = data.capital?.quarters.find(q => Math.abs(Date.parse(q.periodEnd) - Date.parse(newest.periodEnd)) <= 20 * DAY)?.rpo ?? null;
  const documents = selectDocuments(library, researchAsOf);
  const transcripts: ValuationTranscript[] = calls.filter(c => c.filedAt.slice(0, 10) <= researchAsOf.slice(0, 10)).slice(0, 4)
    .map(c => ({ id: c.id, periodEnd: c.periodEnd, title: c.title, filedAt: c.filedAt, sourceUrl: c.sourceUrl, characters: c.content.length, fiscalYear: c.fiscalYear, fiscalQuarter: c.fiscalQuarter }));
  const fingerprint = await sha256(JSON.stringify({
    version: VALUATION_INPUT_VERSION, ticker, periodEnd: newest.periodEnd, currency,
    facts: facts.map(f => [f.id, f.value, f.periodEnd]), quarters: data.quarters.map(q => q.periodEnd).sort(),
    documents: documents.map(d => d.documentId).sort(), transcripts: transcripts.map(t => [t.id, t.characters]).sort(),
    management: management ? [management.asOf, management.targets.map(t => [t.metric, t.segment ?? "", t.fiscalYear, t.value])] : null,
    // The layers below it (docs/spontra-architecture-upgrade.md): a new findings set, business breakdown or filing analysis is new input.
    below: await belowFingerprints(db, ticker),
  }));
  return {
    ticker, cik, companyName: await companyName(db, ticker) ?? ticker, currency, financialPeriodEnd: newest.periodEnd, incomeModel: newest.incomeModel ?? "unknown",
    facts, distributions, diagnostics, documents, transcripts, missing, fingerprint,
    rpo, lifecycle: lifecycleOf({ facts, diagnostics }), peers: peers.peers, peerBasis: peers.basis, peerNotes: peers.notes, management, managementNotes, trailingQuarters: buildTrailingQuarters(data, new Map([[newest.periodEnd, leases.facts]])),
  };
}

/** What the layers below valuation last published for the company: the findings, the business breakdown and the filing analyses. */
async function belowFingerprints(db: D1Database, ticker: string): Promise<[string | null, string | null, string | null]> {
  const repository = new D1SecRepository(db);
  const read = (key: string, field: "fingerprint" | "generatedAt") => repository.getCache<Record<string, unknown>>(key).then(r => typeof r?.payload?.[field] === "string" ? r.payload[field] as string : null).catch(() => null);
  return Promise.all([read(`findings:v2:${ticker}`, "fingerprint"), read(`business-tree:v1:${ticker}`, "fingerprint"), read(`items:v1:${ticker}`, "fingerprint")]);
}
