import type { FindingRef, FindingSpan } from "../../../../shared/analysis-contract/findings.ts";
import { resolveEvidence, type FindingData, type VerifiedFinding } from "../../../../shared/analysis-runtime/findings.ts";
import { assessStatements, formatMetric, METRIC_DEFS } from "../../../../shared/analysis-runtime/statement-analysis.ts";
import type { Flag } from "../../../../shared/analysis-contract/statement-analysis.ts";

/**
 * What a finding deserves to be asked, decided by the figures rather than by the model: each line of inquiry
 * fires on a rule of the three-statement checkup the report trips (a capital-intensity step, a cash/earnings
 * divergence, a funding gap) or on the finding's own anchors and citations. Severity only caps the budget. Nothing here names a company or a case.
 */
export type LineKey = "capital_intensity" | "cash_earnings" | "funding_commitments" | "demand_conversion" | "guidance_delivery" | "margin_mix" | "peers" | "event";
export type PlannedLine = { key: LineKey; why: string; questions: string[]; evidence: string };
export type Tier = "deep" | "standard" | "light";
export type Plan = { tier: Tier; lines: PlannedLine[]; budget: { turns: number; reads: number; finds: number; searches: number; webReads: number } };

const BUDGETS: Record<Tier, Plan["budget"]> = { deep: { turns: 16, reads: 8, finds: 6, searches: 4, webReads: 3 }, standard: { turns: 10, reads: 5, finds: 4, searches: 2, webReads: 1 }, light: { turns: 0, reads: 0, finds: 0, searches: 0, webReads: 0 } };
const MAX_LINES = 5;

const LINES: Record<LineKey, Omit<PlannedLine, "why">> = {
  capital_intensity: { key: "capital_intensity", questions: [
    "What is the capital buying: property and equipment by class, leased against owned, and how much is committed but not yet paid or on the balance sheet?",
    "Is the asset base growing faster than the revenue it is meant to produce (property and equipment, lease assets, against the anchored revenue)?",
    "How is the gap funded this period against last: operating cash, debt, leases, equity; what does that do to leverage and cash interest?",
    "Did management guide the figure, and did the actual land above or below it?",
  ], evidence: "capex, freeCashFlow, operatingCashFlow, debtIssued, leaseAssetsObtained, unpaidCapex, productive, leaseAssets, interestPaid, depreciation; the property, leases and commitments notes; the liquidity section of MD&A" },
  cash_earnings: { key: "cash_earnings", questions: [
    "Which operating lines explain the divergence between profit and operating cash: non-cash charges, working capital, deferred revenue?",
    "Is the divergence structural (four quarters or more) or one quarter?",
    "Do customer advances or receivables flatter or hide it?",
  ], evidence: "operatingCashFlow / net ratio over eight quarters, depreciation, stockCompensation, customerAdvances, receivables; the cash-flow discussion in MD&A" },
  funding_commitments: { key: "funding_commitments", questions: [
    "What was raised, in what instrument, and when does it come due?",
    "What sits on the balance sheet (debt, lease liabilities, customer advances, payables) and what sits off it (purchase obligations, leases not yet commenced, guarantees)?",
    "Who owns the assets being built: owned, leased, financed by vendors or customers?",
    "What is the cash interest burden against operating cash?",
  ], evidence: "debt, leases, customerAdvances, payables, deferredTax, interestPaid, leasePrincipal; the debt, leases and commitments notes, including the current and the previous filing's wording" },
  demand_conversion: { key: "demand_conversion", questions: [
    "Is growth converting from backlog at the pace management describes, and is the share due within twelve months rising or falling?",
    "Does the anchored revenue keep up with the asset base built for it?",
    "Who are the customers and contracts behind it, in the filing's words, and what concentration do they carry?",
  ], evidence: "node revenue yoy/qoq, rpo, rpoBucket rungs, node / capex and productive / revenue ratios; the revenue and segment notes; customer concentration passages" },
  guidance_delivery: { key: "guidance_delivery", questions: [
    "Did the actual land above, within or below the range, and was the range moved before the print?",
    "What did management name as the swing factor?",
  ], evidence: "evidence compared with {guidanceId}; the guidance items' own quotes" },
  margin_mix: { key: "margin_mix", questions: [
    "Which expense lines moved relative to revenue, and is it mix or price?",
    "Does the new mix carry a structurally different margin?",
    "What did management attribute it to, in its own words?",
  ], evidence: "expense ratio rows, node shares, segment margins where disclosed; the results-of-operations section of MD&A" },
  event: { key: "event", questions: [
    "What are the terms in the filing's own words: who, what, how much, under what plan or agreement?",
    "How does the event change the figures it touches: shares outstanding, holdings, debt, buyback capacity?",
    "What is the base rate: how often has this insider or this company done this before, and under a plan or not?",
  ], evidence: "the event's own figures ({event} references), the filed exhibit's text through find_sections and read_section, the company's earlier events of the same class" },
  peers: { key: "peers", questions: [
    "How does the same ratio look at each tracked peer over the same span, and is the company's move company-specific or industry-wide?",
    "What do peers say in their own filings about the same mechanism: who owns, who leases, who borrows, who is paid in advance?",
  ], evidence: "the comparable peers and their basis (peers), the peers table (peer references) for peers of basis company, peers' filings through find_sections with peers; the divergence table" },
};

const refs = (f: VerifiedFinding): FindingRef[] => f.evidence.map(e => e.ref);
const cites = (f: VerifiedFinding, test: (r: FindingRef) => boolean) => refs(f).some(r => test(r) || ("ratio" in r && (test(r.ratio.numerator) || test(r.ratio.denominator))));
const capital = (name: string) => (r: FindingRef) => "capital" in r && r.capital === name;
const yoy = (data: FindingData, ref: FindingRef, end: string, span: FindingSpan) => resolveEvidence(data, { ref, periodEnd: end, span, compare: "yoy" })?.delta ?? null;

/**
 * The checkup's rules that open each line (docs/three-statement-analysis-design.md): the same thresholds the page flags
 * on, so the analyst asks about what the reader is shown. Anchors and citations still open a line on their own.
 */
const LINE_RULES: Partial<Record<LineKey, string[]>> = {
  capital_intensity: ["capex-cycle", "capex-unmatched", "returns-below-cost"],
  cash_earnings: ["cash-below-profit", "cash-above-profit", "fcf-turned-negative", "fcf-turned-positive", "receivables-outrun", "inventory-outrun"],
  funding_commitments: ["external-funding", "leverage-high", "leverage-rising", "maturity-wall", "liquidity-thin", "interest-burden", "runway-short"],
  demand_conversion: ["backlog-large", "growth-decelerating", "revenue-decline"],
  margin_mix: ["margin-compression", "gross-margin-compression", "margin-expansion", "operating-leverage"],
};
/** The flags at the finding's report that open a line, as "rule (value against threshold)"; empty when none trips. */
function tripped(flags: Flag[], line: LineKey): string[] {
  const rules = LINE_RULES[line] ?? [];
  return flags.filter(f => rules.includes(f.ruleId)).map(f => `${f.ruleId} (${formatMetric(f.value, METRIC_DEFS.get(f.metricId)!.form)} against ${f.threshold})`);
}

export function planFinding(f: VerifiedFinding, data: FindingData, peers: string[]): Plan {
  const end = f.periodEnd, span: FindingSpan = f.evidence[0]?.span ?? "quarter";
  const tier: Tier = f.kind === "watch" || f.severity <= 1 ? "light" : f.severity === 3 ? "deep" : "standard";
  const flags = assessStatements(data, end).flags;
  const lines: PlannedLine[] = [];
  const fire = (key: LineKey, why: string) => { if (!lines.some(l => l.key === key)) lines.push({ ...LINES[key], why }); };
  const byRule = (key: LineKey, cited: boolean, citedWhy: string) => { const hits = tripped(flags, key); if (cited || hits.length) fire(key, cited ? citedWhy : `checkup flags ${hits.join("; ")}`); };
  // An event finding opens the event line first: its terms, the figures it touches, and its base rate.
  if (cites(f, r => "event" in r)) fire("event", "the finding rests on a filed event");
  byRule("capital_intensity", cites(f, capital("capex")), "the finding rests on capex");
  byRule("cash_earnings", cites(f, capital("freeCashFlow")) || cites(f, capital("operatingCashFlow")), "free cash flow or operating cash is in the evidence");
  byRule("funding_commitments", f.anchors.view === "balance" || cites(f, capital("debtIssued")) || cites(f, capital("leases")) || cites(f, capital("customerAdvances")) || cites(f, capital("debt")),
    f.anchors.view === "balance" ? "a balance-sheet finding" : "borrowing, leases or customer advances are in the evidence");
  // Demand conversion: a growth claim on an anchored business is the finding's own, not a company-wide rule.
  const nodeGrowth = f.anchors.nodeIds.some(id => (yoy(data, { nodeId: id }, end, span) ?? 0) > 25);
  byRule("demand_conversion", nodeGrowth || cites(f, r => "capital" in r && (r.capital === "rpo" || r.capital === "rpoNext12MonthsShare")) || !!f.pairWith,
    nodeGrowth ? "an anchored business grows more than 25% on the year" : "backlog or a paired growth finding");
  // Guidance: any evidence compared against a guided range.
  if (f.evidence.some(e => typeof e.compare === "object")) fire("guidance_delivery", "the evidence is measured against guidance");
  // Peers: the finding matters enough and the company has tracked peers in its category; placed before margins so the cap keeps it.
  if (peers.length >= 2 && (f.severity === 3 || f.anchors.view !== "profit")) fire("peers", `${peers.length} comparable tracked peers`);
  byRule("margin_mix", cites(f, r => "ratio" in r && "metric" in r.ratio.denominator && r.ratio.denominator.metric === "revenue"), "a margin or expense ratio is in the evidence");
  const budget = BUDGETS[tier];
  return { tier, lines: lines.slice(0, MAX_LINES), budget };
}
