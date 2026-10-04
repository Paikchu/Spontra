import { useId, useState } from "react";
import { Search } from "lucide-react";
import type { FinancialMaintenanceMetric, FinancialMaintenancePeriod } from "@/shared/analysis-contract/financial-maintenance";
import { displayFinancialValue } from "./financial-maintenance-state";
import "./financial-quarter-summary.css";

const currencies: Record<string, string> = { USD: "美元", CNY: "人民币", EUR: "欧元", JPY: "日元", HKD: "港元", GBP: "英镑", CAD: "加元", AUD: "澳元" };
const totals = new Set(["revenue", "gross", "operating", "pretax", "net"]);
const decimalPattern = /^-?\d+(?:\.\d+)?$/;

function scaleExponent(scale: number): number | null {
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const exponent = Math.log10(scale);
  return Number.isInteger(exponent) && Math.abs(exponent) <= 20 ? exponent : null;
}

/** Shift decimal strings without converting disclosed amounts into floating-point numbers. */
function shiftDecimal(value: string, places: number): string {
  const negative = value.startsWith("-");
  const [integer, fraction = ""] = value.replace(/^-/, "").split(".");
  const digits = integer! + fraction;
  const point = integer!.length + places;
  const shifted = point <= 0 ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length ? digits + "0".repeat(point - digits.length)
    : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const normalized = shifted.replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return negative && /[1-9]/.test(normalized) ? `-${normalized}` : normalized;
}

function accountingValue(value: string): string {
  const formatted = displayFinancialValue(value);
  return value.startsWith("-") ? `(${formatted.slice(1)})` : formatted;
}

function nativeUnit(metric: FinancialMaintenanceMetric): string {
  const currency = currencies[metric.unit] ?? metric.unit;
  if (metric.scale === 1) return currency || "单位未说明";
  if (metric.scale === 1_000_000) return `百万${currency}`;
  if (metric.scale === 1_000) return `千${currency}`;
  if (metric.scale === 1_000_000_000) return `十亿${currency}`;
  return `× ${displayFinancialValue(String(metric.scale))} ${currency}`.trim();
}

function metricDisplay(metric: FinancialMaintenanceMetric | undefined, commonCurrency: string | null, millions: boolean) {
  if (!metric || metric.value === null) return { value: "—", unit: "", exact: "暂无数据" };
  const exponent = scaleExponent(metric.scale);
  const numeric = decimalPattern.test(metric.value);
  const exact = exponent !== null && numeric
    ? `${displayFinancialValue(shiftDecimal(metric.value, exponent))} ${currencies[metric.unit] ?? metric.unit}`.trim()
    : `${displayFinancialValue(metric.value)} ${nativeUnit(metric)}`;
  if (commonCurrency && exponent !== null && numeric) {
    return { value: accountingValue(shiftDecimal(metric.value, exponent - (millions ? 6 : 0))), unit: "", exact };
  }
  return { value: numeric ? accountingValue(metric.value) : metric.value, unit: nativeUnit(metric), exact };
}

function periodLabel(period: FinancialMaintenancePeriod) {
  return period.fiscalLabel && period.fiscalLabel !== period.periodEnd ? `${period.fiscalLabel} · ${period.periodEnd}` : period.periodEnd;
}

export function FinancialQuarterSummary({ periods }: { periods: FinancialMaintenancePeriod[] }) {
  const headingId = useId();
  const [chosenPeriod, setChosenPeriod] = useState("");
  const [chosenComparison, setChosenComparison] = useState("");
  const [group, setGroup] = useState<"income" | "business">("income");
  const [search, setSearch] = useState("");
  const [millions, setMillions] = useState(true);
  const ordered = [...periods].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  const available = ordered.filter(period => period.metrics.some(metric => metric.value !== null));
  const current = ordered.find(period => period.periodEnd === chosenPeriod) ?? available[0] ?? ordered[0];
  const comparison = chosenComparison === "none" ? undefined
    : ordered.find(period => period.periodEnd === chosenComparison && period.periodEnd !== current?.periodEnd)
      ?? available.find(period => period.periodEnd !== current?.periodEnd);
  const visiblePeriods = [current, comparison].filter((period): period is FinancialMaintenancePeriod => Boolean(period));
  const metricMaps = visiblePeriods.map(period => new Map(period.metrics.map(metric => [metric.id, metric])));
  const allMetrics = new Map<string, FinancialMaintenanceMetric>();
  for (const period of visiblePeriods) for (const metric of period.metrics) if (!allMetrics.has(metric.id)) allMetrics.set(metric.id, metric);
  const rows = [...allMetrics.values()].filter(metric => (group === "business") === metric.id.startsWith("segment:") && metric.label.toLowerCase().includes(search.trim().toLowerCase()));
  const shownMetrics = metricMaps.flatMap(metrics => rows.flatMap(row => {
    const metric = metrics.get(row.id);
    return metric && metric.value !== null ? [metric] : [];
  }));
  const firstUnit = shownMetrics[0]?.unit;
  const commonCurrency = firstUnit && currencies[firstUnit] && shownMetrics.every(metric => metric.unit === firstUnit && scaleExponent(metric.scale) !== null && decimalPattern.test(metric.value!)) ? firstUnit : null;

  return <section className="fqs-summary" aria-labelledby={headingId}>
    <div className="fqs-heading"><div><h3 id={headingId}>季度摘要</h3><p>比较已整理的季度收入、费用与利润。</p></div></div>
    {!current ? <p className="fqs-empty">暂无季度摘要。获取数据后，可在这里比较不同季度。</p> : <>
      <div className="fqs-controls">
        <label><span>查看季度</span><select aria-label="季度摘要查看季度" value={current.periodEnd} onChange={event => {
          setChosenPeriod(event.target.value);
          if (chosenComparison === event.target.value) setChosenComparison("");
        }}>{ordered.map(period => <option key={period.periodEnd} value={period.periodEnd}>{periodLabel(period)}</option>)}</select></label>
        <label><span>对比季度</span><select aria-label="季度摘要对比季度" value={comparison?.periodEnd ?? "none"} onChange={event => setChosenComparison(event.target.value)}><option value="none">不对比</option>{ordered.filter(period => period.periodEnd !== current.periodEnd).map(period => <option key={period.periodEnd} value={period.periodEnd}>{periodLabel(period)}</option>)}</select></label>
        {commonCurrency && <label className="fqs-unit-control"><span>金额显示</span><select aria-label="季度摘要金额单位" value={millions ? "million" : "base"} onChange={event => setMillions(event.target.value === "million")}><option value="million">百万{currencies[commonCurrency]}</option><option value="base">{currencies[commonCurrency]}</option></select></label>}
      </div>
      <div className="fqs-filters">
        <div className="fqs-groups" role="group" aria-label="季度摘要内容"><button type="button" aria-pressed={group === "income"} onClick={() => setGroup("income")}>利润与费用</button><button type="button" aria-pressed={group === "business"} onClick={() => setGroup("business")}>业务收入</button></div>
        <label className="fqs-search"><Search size={15} aria-hidden="true" /><input aria-label="搜索季度摘要项目" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索项目" /></label>
      </div>
      <div className="fqs-table-meta"><span>{group === "income" ? "利润与费用" : "业务收入"}</span><span>{commonCurrency ? `单位：${millions ? "百万" : ""}${currencies[commonCurrency]}` : "单位随金额列示"}</span></div>
      <div className="fqs-table-scroll" tabIndex={0} role="region" aria-label="季度摘要比较表，可横向滚动">
        <table><thead><tr><th scope="col">项目</th>{visiblePeriods.map(period => <th scope="col" key={period.periodEnd}><strong>{period.fiscalLabel || period.periodEnd}</strong><span>{period.periodStart ? `${period.periodStart} — ${period.periodEnd}` : `截至 ${period.periodEnd}`}</span></th>)}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.id} data-total={totals.has(row.id)}><th scope="row">{row.label}</th>{metricMaps.map((metrics, index) => {
            const metric = metrics.get(row.id);
            const display = metricDisplay(metric, commonCurrency, millions);
            return <td key={visiblePeriods[index]!.periodEnd} data-missing={!metric || metric.value === null} title={display.exact} aria-label={display.exact}><span>{display.value}</span>{display.unit && <small>{display.unit}</small>}</td>;
          })}</tr>)}</tbody></table>
        {!rows.length && <p className="fqs-empty" role="status">{search ? "没有匹配的项目，试试其他名称。" : group === "business" ? "所选季度暂无业务收入明细。" : "所选季度暂无利润与费用数据。"}</p>}
      </div>
      <p className="fqs-footnote">— 表示暂无数据；括号表示负数。</p>
    </>}
  </section>;
}
