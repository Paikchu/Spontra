import { z } from "zod";
import type { BalanceSheet, CashFlowStatement } from "../analysis-contract/capital-structure.ts";
import type { FindingRef } from "../analysis-contract/findings.ts";
import { PEER_FIGURES, type PeerCompany, type PeerFigure, type PeerQuarter, type PeersPublication } from "../analysis-contract/peers.ts";
import { resolveRef, type FindingData } from "./findings.ts";

/* ---------- Schema ---------- */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const figures = z.object(Object.fromEntries(PEER_FIGURES.map(f => [f, decimal.optional()])) as Record<PeerFigure, z.ZodOptional<typeof decimal>>);
const quarter = z.object({ periodEnd: date, accessions: z.array(z.string().max(40)).max(16), figures });
const company = z.object({
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/),
  categories: z.array(z.string().max(60)).max(16),
  newestQuarter: date.nullable(),
  quarters: z.array(quarter).max(8),
});
export const peersPublicationSchema = z.object({ schemaVersion: z.literal("peers.v1"), generatedAt: z.string().max(40), companies: z.array(company).max(400) });

/** A stored peers publication through the contract, unknown fields stripped; null when its shape is wrong. */
export function readPeersPublication(value: unknown): PeersPublication | null {
  const parsed = peersPublicationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/* ---------- What a company's page reads ---------- */

/** The tickers a publication names in `{ peer }` references, wherever they sit (evidence, ratios, lenses, documents). */
export function citedPeers(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) citedPeers(item, into);
  else if (value && typeof value === "object") {
    const peer = (value as { peer?: unknown }).peer;
    if (peer && typeof peer === "object" && typeof (peer as { ticker?: unknown }).ticker === "string") into.add((peer as { ticker: string }).ticker);
    for (const item of Object.values(value)) citedPeers(item, into);
  }
  return into;
}

/** The projection cut to the companies a page cites, so what the page reads moves only with them; null when it cites none. */
export function peersFor(peers: PeersPublication | null, cited: Set<string>): PeersPublication | null {
  if (!peers || !cited.size) return null;
  return { ...peers, companies: peers.companies.filter(c => cited.has(c.ticker)) };
}

/** The companies whose row differs between two projections, a company added or left out counting as changed. */
export function changedPeers(before: PeersPublication | null, after: PeersPublication): Set<string> {
  const rows = (p: PeersPublication | null) => new Map((p?.companies ?? []).map(c => [c.ticker, JSON.stringify(c)]));
  const old = rows(before), next = rows(after);
  return new Set([...old.keys(), ...next.keys()].filter(t => old.get(t) !== next.get(t)));
}

/* ---------- Alignment ---------- */

const DAY = 86_400_000;
/** How far back a peer's quarter may end and still stand beside the subject's period: a fiscal calendar one quarter behind. */
export const PEER_ALIGNMENT_DAYS = 120;

/** The company's latest quarter ending on or before `periodEnd` and within the alignment window; null when none qualifies. */
export function alignedPeerQuarter(company: Pick<PeerCompany, "quarters">, periodEnd: string): PeerQuarter | null {
  const at = Date.parse(periodEnd);
  if (!Number.isFinite(at)) return null;
  let best: PeerQuarter | null = null;
  for (const q of company.quarters) {
    const end = Date.parse(q.periodEnd);
    if (!Number.isFinite(end) || end > at || at - end > PEER_ALIGNMENT_DAYS * DAY) continue;
    if (!best || end > Date.parse(best.periodEnd)) best = q;
  }
  return best;
}

/* ---------- Extraction ---------- */

/** Figures that are a findings reference read at span "quarter": the same number the finding page would show. */
const REF_OF: Partial<Record<PeerFigure, FindingRef>> = {
  revenue: { metric: "revenue" }, grossProfit: { metric: "gross" }, operatingIncome: { metric: "operating" }, netIncome: { metric: "net" },
  operatingCashFlow: { capital: "operatingCashFlow" }, capex: { capital: "capex" }, freeCashFlow: { capital: "freeCashFlow" },
  debtIssued: { capital: "debtIssued" }, equityIssued: { capital: "equityIssued" }, buybacks: { capital: "buybacks" }, dividends: { capital: "dividends" },
  totalAssets: { capital: "totalAssets" }, debt: { capital: "debt" }, cash: { capital: "cash" }, equity: { capital: "equity" }, rpo: { capital: "rpo" },
  stockBasedCompensation: { fundamental: "stock_based_compensation" },
};

const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 20 * DAY;
const sum = (lines: Array<{ value: string }>) => lines.reduce((total, line) => total + Number(line.value), 0);
/** Base units carry no fractions worth keeping; `-0` prints as "0". */
const asDecimal = (value: number) => String(Math.round(value) || 0);

/** The lines of one liability group added up; null when the statement presents no line in that group, never zero. */
export function liabilityGroupTotal(sheet: BalanceSheet, group: BalanceSheet["liabilities"][number]["group"]): number | null {
  const lines = sheet.liabilities.filter(l => l.group === group);
  return lines.length ? sum(lines) : null;
}

/** Non-cash operating add-backs whose concept names depreciation or amortization; null when the statement tags none. */
export function depreciationOf(statement: CashFlowStatement): number | null {
  const lines = (statement.operating.lines ?? []).filter(l => l.group === "nonCash" && /Depreciation|Amortization/i.test(l.concept));
  return lines.length ? sum(lines) : null;
}

/**
 * The comparable figures of one company at every quarter its data holds, newest first, at most eight. Each figure is
 * read the way the findings runtime reads the matching reference at span "quarter" (capex positive, debt and cash as the
 * summed balance-sheet groups, RPO the tagged total); leases and customer advances are their liability groups, and
 * depreciation the statement's own non-cash lines, falling back to the SEC series. Only USD figures are kept, so a
 * cell never mixes currencies across companies. A quarter with no figure is left out.
 */
export function peerQuartersFrom(data: FindingData): PeerQuarter[] {
  const ends = [...new Set([...(data.capital?.quarters ?? []).map(q => q.periodEnd), ...data.quarters.filter(q => q.periodType === "3M").map(q => q.periodEnd)])]
    .sort((a, b) => b.localeCompare(a));
  const quarters: PeerQuarter[] = [];
  for (const periodEnd of ends) {
    // A fiscal quarter end and the calendar month end it was matched to are one quarter, not two.
    if (quarters.some(q => near(q.periodEnd, periodEnd))) continue;
    const figures: Partial<Record<PeerFigure, string>> = {};
    const accessions = new Set<string>();
    for (const figure of PEER_FIGURES) {
      const ref = REF_OF[figure];
      if (!ref) continue;
      const resolved = resolveRef(data, ref, periodEnd, "quarter");
      if (!resolved || resolved.unit !== "USD" || resolved.currency !== "USD" || resolved.range) continue;
      figures[figure] = asDecimal(resolved.value);
      for (const a of resolved.accessions) accessions.add(a);
    }
    const capital = data.capital?.quarters.find(q => near(q.periodEnd, periodEnd));
    const sheet = capital?.balanceSheet;
    if (sheet && sheet.currency === "USD") {
      const leases = liabilityGroupTotal(sheet, "leases"), advances = liabilityGroupTotal(sheet, "customerAdvances");
      if (leases != null) { figures.leases = asDecimal(leases); accessions.add(sheet.source.accession); }
      if (advances != null) { figures.customerAdvances = asDecimal(advances); accessions.add(sheet.source.accession); }
    }
    const statement = capital?.cashFlow;
    const depreciation = statement && statement.currency === "USD" ? depreciationOf(statement) : null;
    if (depreciation != null) { figures.depreciation = asDecimal(depreciation); for (const s of statement!.sources) accessions.add(s.accession); }
    else {
      const series = resolveRef(data, { fundamental: "depreciation_and_amortization" }, periodEnd, "quarter");
      if (series && series.unit === "USD" && series.currency === "USD") { figures.depreciation = asDecimal(series.value); for (const a of series.accessions) accessions.add(a); }
    }
    if (!Object.keys(figures).length) continue;
    quarters.push({ periodEnd, accessions: [...accessions].sort(), figures });
    if (quarters.length === 8) break;
  }
  return quarters;
}
