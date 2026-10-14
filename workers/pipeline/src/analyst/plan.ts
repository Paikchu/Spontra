import type { FindingRef, FindingSpan } from "../../../../shared/analysis-contract/findings.ts";
import { resolveEvidence, resolveRef, type FindingData, type VerifiedFinding } from "../../../../shared/analysis-runtime/findings.ts";

/**
 * What a finding deserves to be asked, decided by the figures rather than by the model: each line of inquiry
 * fires on a numeric relation in the data (a capital-intensity step, a cash/earnings divergence, a funding gap)
 * or on the finding's own anchors. Severity only caps the budget. Nothing here names a company or a case.
 */
export type LineKey = "capital_intensity" | "cash_earnings" | "funding_commitments" | "demand_conversion" | "guidance_delivery" | "margin_mix" | "peers";
export type PlannedLine = { key: LineKey; why: string; questions: string[]; evidence: string };
export type Tier = "deep" | "standard" | "light";
export type Plan = { tier: Tier; lines: PlannedLine[]; budget: { turns: number; reads: number; finds: number } };

const BUDGETS: Record<Tier, Plan["budget"]> = { deep: { turns: 14, reads: 8, finds: 6 }, standard: { turns: 9, reads: 5, finds: 4 }, light: { turns: 0, reads: 0, finds: 0 } };
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
  peers: { key: "peers", questions: [
    "How does the same ratio look at each tracked peer over the same span, and is the company's move company-specific or industry-wide?",
    "What do peers say in their own filings about the same mechanism: who owns, who leases, who borrows, who is paid in advance?",
  ], evidence: "the peers table (peer references), peers' filings through find_sections with the shared category; the divergence table" },
};

const refs = (f: VerifiedFinding): FindingRef[] => f.evidence.map(e => e.ref);
const cites = (f: VerifiedFinding, test: (r: FindingRef) => boolean) => refs(f).some(r => test(r) || ("ratio" in r && (test(r.ratio.numerator) || test(r.ratio.denominator))));
const capital = (name: string) => (r: FindingRef) => "capital" in r && r.capital === name;
const num = (data: FindingData, ref: FindingRef, end: string, span: FindingSpan) => resolveRef(data, ref, end, span)?.value ?? null;
const yoy = (data: FindingData, ref: FindingRef, end: string, span: FindingSpan) => resolveEvidence(data, { ref, periodEnd: end, span, compare: "yoy" })?.delta ?? null;

export function planFinding(f: VerifiedFinding, data: FindingData, peers: string[]): Plan {
  const end = f.periodEnd, span: FindingSpan = f.evidence[0]?.span ?? "quarter";
  const tier: Tier = f.kind === "watch" || f.severity <= 1 ? "light" : f.severity === 3 ? "deep" : "standard";
  const lines: PlannedLine[] = [];
  const fire = (key: LineKey, why: string) => { if (!lines.some(l => l.key === key)) lines.push({ ...LINES[key], why }); };
  // Capital intensity: capex cited, or capex running far ahead of depreciation or of its own year-ago level.
  const capexYoy = yoy(data, { capital: "capex" }, end, "fiscal_year"), capexDa = num(data, { ratio: { numerator: { capital: "capex" }, denominator: { capital: "depreciation" } } }, end, "fiscal_year");
  if (cites(f, capital("capex")) || (capexYoy != null && Math.abs(capexYoy) > 40) || (capexDa != null && capexDa > 2)) fire("capital_intensity", cites(f, capital("capex")) ? "the finding rests on capex" : capexDa != null && capexDa > 2 ? "capex runs at more than twice depreciation" : "capex moved more than 40% on the year");
  // Cash against earnings: operating cash far from net income, or free cash flow changing sign on the year.
  const ocfNet = num(data, { ratio: { numerator: { capital: "operatingCashFlow" }, denominator: { metric: "net" } } }, end, "fiscal_year");
  const fcf = num(data, { capital: "freeCashFlow" }, end, "fiscal_year"), fcfAgo = num(data, { capital: "freeCashFlow" }, end.replace(/^(\d{4})/, (_, y) => String(Number(y) - 1)), "fiscal_year");
  if ((ocfNet != null && (ocfNet < 1 || ocfNet > 1.5)) || (fcf != null && fcfAgo != null && Math.sign(fcf) !== Math.sign(fcfAgo)) || cites(f, capital("freeCashFlow")) || cites(f, capital("operatingCashFlow"))) fire("cash_earnings", ocfNet != null && (ocfNet < 1 || ocfNet > 1.5) ? `operating cash is ${ocfNet.toFixed(2)}× net income` : "free cash flow or operating cash is in the evidence");
  // Funding and obligations: large issuance against revenue, leverage moving, or a balance-sheet finding.
  const revenue = num(data, { metric: "revenue" }, end, "fiscal_year");
  const debtIssued = num(data, { capital: "debtIssued" }, end, "fiscal_year"), equityIssued = num(data, { capital: "equityIssued" }, end, "fiscal_year");
  const leverageMove = yoy(data, { ratio: { numerator: { capital: "debt" }, denominator: { capital: "equity" } } }, end, "quarter");
  if (f.anchors.view === "balance" || (revenue && ((debtIssued ?? 0) > 0.2 * revenue || (equityIssued ?? 0) > 0.2 * revenue)) || (leverageMove != null && Math.abs(leverageMove) > 0.3) || cites(f, capital("debtIssued")) || cites(f, capital("leases")) || cites(f, capital("customerAdvances")) || cites(f, capital("debt")))
    fire("funding_commitments", f.anchors.view === "balance" ? "a balance-sheet finding" : "borrowing or issuance above a fifth of revenue, or leverage moving");
  // Demand conversion: a growth claim on a business, or a large backlog against revenue.
  const rpoRev = num(data, { ratio: { numerator: { capital: "rpo" }, denominator: { metric: "revenue" } } }, end, "quarter");
  const nodeGrowth = f.anchors.nodeIds.some(id => (yoy(data, { nodeId: id }, end, span) ?? 0) > 25);
  if (nodeGrowth || (rpoRev != null && rpoRev > 2) || cites(f, r => "capital" in r && (r.capital === "rpo" || r.capital === "rpoNext12MonthsShare")) || f.pairWith) fire("demand_conversion", nodeGrowth ? "an anchored business grows more than 25% on the year" : "backlog or a paired growth finding");
  // Guidance: any evidence compared against a guided range.
  if (f.evidence.some(e => typeof e.compare === "object")) fire("guidance_delivery", "the evidence is measured against guidance");
  // Peers: the finding matters enough and the company has tracked peers in its category; placed before margins so the cap keeps it.
  if (peers.length >= 2 && (f.severity === 3 || f.anchors.view !== "profit")) fire("peers", `${peers.length} tracked peers share a category`);
  // Margin or mix: a margin ratio in the evidence or a margin moving more than two points.
  const marginMove = (m: "gross" | "operating" | "net") => yoy(data, { ratio: { numerator: { metric: m }, denominator: { metric: "revenue" } } }, end, span);
  if (cites(f, r => "ratio" in r && "metric" in r.ratio.denominator && r.ratio.denominator.metric === "revenue") || [marginMove("gross"), marginMove("operating"), marginMove("net")].some(d => d != null && Math.abs(d * 100) > 2)) fire("margin_mix", "a margin or expense ratio moved or is in the evidence");
  const budget = BUDGETS[tier];
  return { tier, lines: lines.slice(0, MAX_LINES), budget };
}
