import { perHundred, type IncomeParts, type SecFigure } from "@/shared/analysis-runtime/sec-figures.ts";
import { currencyName, direction } from "./format.ts";

const PARTS: Array<{ key: keyof IncomeParts; label: string; role: string }> = [
  { key: "cost", label: "直接成本", role: "spent-1" },
  { key: "operatingExpenses", label: "经营费用", role: "spent-2" },
  { key: "taxAndOther", label: "税、利息及其他", role: "spent-3" },
  { key: "netIncome", label: "净利润", role: "net" },
];

/** Each 100 of revenue split into the layers it pays for, this period against the same period last year. */
export function PerHundred({ figure }: { figure: Extract<SecFigure, { kind: "per_hundred" }> }) {
  const current = perHundred(figure.current), prior = perHundred(figure.prior);
  if (!current || !prior) return <p className="report-content-fallback">利润表层级为负，无法按每 100 元拆分。</p>;
  const unit = currencyName(figure.current.currency);
  const delta = current.netIncome - prior.netIncome;
  const row = (label: string, date: string, parts: IncomeParts, current: boolean) => <div className="sec-figure-hundred-row" data-current={current}>
    <span className="sec-figure-hundred-period">{label}<small>{date}</small></span>
    <div className="sec-figure-hundred-bar" role="img" aria-label={`${label}每 100 ${unit}收入：${PARTS.map((p) => `${p.label} ${parts[p.key]}`).join("，")}`}>
      {PARTS.map((p) => parts[p.key] > 0 && <span key={p.key} data-role={p.role} style={{ flexGrow: parts[p.key] }}>{parts[p.key] >= 9 ? `${p.key === "netIncome" ? "净利润 " : ""}${parts[p.key]}` : ""}</span>)}
    </div>
  </div>;
  return <div className="sec-figure-hundred">
    {row("本期", figure.current.date, current, true)}
    {row("去年同期", figure.prior.date, prior, false)}
    <dl className="sec-figure-hundred-legend">
      {PARTS.map((p) => <div key={p.key} data-role={p.role}><dt>{p.label}</dt><dd>{current[p.key]}<small> / 去年 {prior[p.key]}</small></dd></div>)}
    </dl>
    <p className="sec-figure-hundred-delta">每 100 {unit}收入的净利润 <strong data-direction={direction(delta)}>{prior.netIncome} → {current.netIncome}</strong></p>
  </div>;
}
