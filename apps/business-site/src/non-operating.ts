import type { BusinessFlowQuarter, FlowAmount } from "@/shared/analysis-contract/business-flow";
import type { FindingFundamentals } from "@/shared/analysis-runtime/findings";

/**
 * Non-operating results in net income (R28). When net income and operating income are more than 30% of operating
 * income apart, and the lines between them (other income and expense, and the signed lines after tax: equity-method
 * results, noncontrolling interests, discontinued operations) move the same way, net income carries those lines:
 * a gain when they add to it, a loss when they take from it.
 *
 * The composition lists what the filings tag: the note's lines from Company Facts (gains on equity securities, interest
 * income and expense, foreign exchange) when the quarter has them, with the rest of the statement line as "other";
 * otherwise the statement's own lines. Income taxes are listed alongside, since part of the gap is the tax on the gain.
 * "Excluding them, about Y": net income less the non-operating total after tax at the quarter's effective rate. All
 * amounts are in the base currency (the flow's figures times its scale). Nothing is estimated beyond that one rate.
 */

/** Net and operating income this far apart, as a share of operating income, tag the quarter. */
export const GAP_SHARE = 0.3;

export type NonOperatingLine = {
  /** A note line from Company Facts, a statement line by the filing's own name, the rest of the statement line, or income taxes. */
  kind: "equity_securities" | "interest_income" | "interest_expense" | "foreign_exchange" | "statement" | "other" | "tax";
  /** The filing's own name, for a statement line. */
  name?: string;
  /** Signed as it moves net income: a gain positive, a cost or tax negative. */
  value: number;
};

export type NonOperating = {
  kind: "gain" | "loss";
  /** The non-operating total, unsigned: the X of "includes a non-operating gain of X". */
  amount: number;
  net: number;
  operating: number;
  /** Net income without the non-operating total after tax: the Y of "excluding it, about Y". */
  adjusted: number;
  /** Income taxes over pretax income, the rate the non-operating total is taxed at; null when it cannot be read. */
  taxRate: number | null;
  lines: NonOperatingLine[];
  currency: string;
  /** The filing the quarter's net income is read from. */
  sourceUrl: string | null;
};

const value = (amount: FlowAmount | undefined | null, scale: number) => {
  if (!amount || amount.value == null || amount.value.trim() === "") return null;
  const n = Number(amount.value);
  return Number.isFinite(n) ? n * scale : null;
};

const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 6 * 86_400_000;

/** Company Facts note lines, signed as they move net income. */
const NOTE: Array<[key: string, kind: NonOperatingLine["kind"], sign: 1 | -1]> = [
  ["equity_securities_gains", "equity_securities", 1],
  ["nonoperating_interest_income", "interest_income", 1],
  ["nonoperating_interest_expense", "interest_expense", -1],
  ["foreign_exchange_gains", "foreign_exchange", 1],
];

function noteLines(fundamentals: FindingFundamentals | null, periodEnd: string): NonOperatingLine[] {
  return NOTE.flatMap(([key, kind, sign]) => {
    const point = fundamentals?.series.find(s => s.metricKey === key && s.unitFamily === "currency")?.points.find(p => near(p.periodEnd, periodEnd));
    const v = point?.valueDecimal == null ? null : Number(point.valueDecimal);
    return v != null && Number.isFinite(v) && v !== 0 ? [{ kind, value: v * sign }] : [];
  });
}

export function nonOperating(quarter: BusinessFlowQuarter, fundamentals: FindingFundamentals | null = null): NonOperating | null {
  const scale = quarter.scale || 1;
  const operating = value(quarter.figures.operating, scale), net = value(quarter.figures.net, scale);
  if (operating == null || net == null || operating === 0) return null;
  const gap = net - operating;
  if (Math.abs(gap) <= GAP_SHARE * Math.abs(operating)) return null;
  const pretax = value(quarter.figures.pretax, scale), tax = value(quarter.figures.tax, scale);
  const other = value(quarter.figures.other, scale) ?? (pretax != null ? pretax - operating : null);
  if (other == null) return null;
  const afterTax = (quarter.afterTaxComponents ?? []).map(c => ({ name: c.name, value: value(c.amount, scale) }));
  if (afterTax.some(c => c.value == null)) return null;
  const total = other + afterTax.reduce((sum, c) => sum + c.value!, 0);
  // The gap is the non-operating lines' only when they move net income the same way; otherwise it is the tax.
  if (total === 0 || Math.sign(total) !== Math.sign(gap)) return null;

  const notes = noteLines(fundamentals, quarter.periodEnd);
  const statement = (quarter.otherComponents ?? []).map(c => ({ name: c.name, value: value(c.amount, scale) }));
  const lines: NonOperatingLine[] = [];
  if (notes.length) {
    lines.push(...notes);
    const rest = other - notes.reduce((sum, l) => sum + l.value, 0);
    if (Math.abs(rest) >= Math.abs(other) * 0.005) lines.push({ kind: "other", value: rest });
  } else if (statement.length && statement.every(c => c.value != null)) {
    lines.push(...statement.filter(c => c.value !== 0).map(c => ({ kind: "statement" as const, name: c.name, value: c.value! })));
  } else if (other !== 0) {
    lines.push({ kind: "other", value: other });
  }
  lines.push(...afterTax.filter(c => c.value !== 0).map(c => ({ kind: "statement" as const, name: c.name, value: c.value! })));
  if (tax != null && tax !== 0) lines.push({ kind: "tax", value: -tax });

  const taxRate = tax != null && pretax != null && pretax > 0 ? Math.min(1, Math.max(0, tax / pretax)) : null;
  // Other income is taxed at the quarter's rate; the after-tax lines already are.
  const adjusted = net - other * (1 - (taxRate ?? 0)) - (total - other);
  const sourceUrl = quarter.figures.net?.lineage?.find(l => /^https?:\/\//.test(l.url))?.url
    ?? quarter.sources.find(s => quarter.figures.net?.sourceIds.includes(s.id) && /^https?:\/\//.test(s.url))?.url
    ?? quarter.sources.find(s => /^https?:\/\//.test(s.url))?.url ?? null;
  return { kind: total > 0 ? "gain" : "loss", amount: Math.abs(total), net, operating, adjusted, taxRate, lines, currency: quarter.currency, sourceUrl };
}
