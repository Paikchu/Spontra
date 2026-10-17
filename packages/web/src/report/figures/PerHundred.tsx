import { perHundred, type IncomeParts, type SecFigure } from "@/shared/analysis-runtime/sec-figures.ts";
import { labels, messages } from "@/packages/web/src/i18n";
import { currencyAmount, direction } from "./format.ts";

const PART_LABELS = labels<keyof IncomeParts>(
  { cost: "Cost of revenue", operatingExpenses: "Operating expenses", taxAndOther: "Tax, interest & other", netIncome: "Net income" },
  { cost: "营业成本", operatingExpenses: "营业费用", taxAndOther: "税、利息及其他", netIncome: "净利润" },
);
const m = messages({
  unavailable: "Unavailable",
  bar: (label: string, hundred: string, parts: string) => `${label}, per ${hundred} of revenue: ${parts}`,
  netIncome: "Net income ",
  current: "This period",
  prior: "Prior-year period",
  priorYear: (value: number) => ` / ${value} prior year`,
  delta: (hundred: string) => `Net income per ${hundred} of revenue`,
}, {
  unavailable: "不可用",
  bar: (label: string, hundred: string, parts: string) => `${label}，每${hundred}营收：${parts}`,
  netIncome: "净利润 ",
  current: "本期",
  prior: "上年同期",
  priorYear: (value: number) => ` / 上年同期 ${value}`,
  delta: (hundred: string) => `每${hundred}营收的净利润`,
});

const PARTS: Array<{ key: keyof IncomeParts; role: string }> = [
  { key: "cost", role: "spent-1" },
  { key: "operatingExpenses", role: "spent-2" },
  { key: "taxAndOther", role: "spent-3" },
  { key: "netIncome", role: "net" },
];

/** Each 100 of revenue split into the layers it pays for, this period against the same period last year. */
export function PerHundred({ figure }: { figure: Extract<SecFigure, { kind: "per_hundred" }> }) {
  const current = perHundred(figure.current), prior = perHundred(figure.prior);
  if (!current || !prior) return <p className="report-content-fallback">{m.unavailable}</p>;
  const hundred = currencyAmount(100, figure.current.currency);
  const delta = current.netIncome - prior.netIncome;
  const row = (label: string, date: string, parts: IncomeParts, current: boolean) => <div className="sec-figure-hundred-row" data-current={current}>
    <span className="sec-figure-hundred-period">{label}<small>{date}</small></span>
    <div className="sec-figure-hundred-bar" role="img" aria-label={m.bar(label, hundred, PARTS.map((p) => `${PART_LABELS[p.key]} ${parts[p.key]}`).join(", "))}>
      {PARTS.map((p) => parts[p.key] > 0 && <span key={p.key} data-role={p.role} style={{ flexGrow: parts[p.key] }}>{parts[p.key] >= 9 ? `${p.key === "netIncome" && parts[p.key] >= 20 ? m.netIncome : ""}${parts[p.key]}` : ""}</span>)}
    </div>
  </div>;
  return <div className="sec-figure-hundred">
    {row(m.current, figure.current.date, current, true)}
    {row(m.prior, figure.prior.date, prior, false)}
    <dl className="sec-figure-hundred-legend">
      {PARTS.map((p) => <div key={p.key} data-role={p.role}><dt>{PART_LABELS[p.key]}</dt><dd>{current[p.key]}<small>{m.priorYear(prior[p.key])}</small></dd></div>)}
    </dl>
    <p className="sec-figure-hundred-delta">{m.delta(hundred)} <strong data-direction={direction(delta)}>{prior.netIncome} → {current.netIncome}</strong></p>
  </div>;
}
