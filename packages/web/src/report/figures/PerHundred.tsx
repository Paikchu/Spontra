import { perHundred, type IncomeParts, type SecFigure } from "@/shared/analysis-runtime/sec-figures.ts";
import { currencySymbol, direction } from "./format.ts";

const PARTS: Array<{ key: keyof IncomeParts; label: string; role: string }> = [
  { key: "cost", label: "Cost of revenue", role: "spent-1" },
  { key: "operatingExpenses", label: "Operating expenses", role: "spent-2" },
  { key: "taxAndOther", label: "Tax, interest & other", role: "spent-3" },
  { key: "netIncome", label: "Net income", role: "net" },
];

/** Each 100 of revenue split into the layers it pays for, this period against the same period last year. */
export function PerHundred({ figure }: { figure: Extract<SecFigure, { kind: "per_hundred" }> }) {
  const current = perHundred(figure.current), prior = perHundred(figure.prior);
  if (!current || !prior) return <p className="report-content-fallback">An income statement layer is negative, so revenue can&apos;t be split per 100.</p>;
  const hundred = `${currencySymbol(figure.current.currency)}100`;
  const delta = current.netIncome - prior.netIncome;
  const row = (label: string, date: string, parts: IncomeParts, current: boolean) => <div className="sec-figure-hundred-row" data-current={current}>
    <span className="sec-figure-hundred-period">{label}<small>{date}</small></span>
    <div className="sec-figure-hundred-bar" role="img" aria-label={`${label}, per ${hundred} of revenue: ${PARTS.map((p) => `${p.label} ${parts[p.key]}`).join(", ")}`}>
      {PARTS.map((p) => parts[p.key] > 0 && <span key={p.key} data-role={p.role} style={{ flexGrow: parts[p.key] }}>{parts[p.key] >= 9 ? `${p.key === "netIncome" && parts[p.key] >= 20 ? "Net income " : ""}${parts[p.key]}` : ""}</span>)}
    </div>
  </div>;
  return <div className="sec-figure-hundred">
    {row("This period", figure.current.date, current, true)}
    {row("Prior-year period", figure.prior.date, prior, false)}
    <dl className="sec-figure-hundred-legend">
      {PARTS.map((p) => <div key={p.key} data-role={p.role}><dt>{p.label}</dt><dd>{current[p.key]}<small> / {prior[p.key]} prior year</small></dd></div>)}
    </dl>
    <p className="sec-figure-hundred-delta">Net income per {hundred} of revenue <strong data-direction={direction(delta)}>{prior.netIncome} → {current.netIncome}</strong></p>
  </div>;
}
