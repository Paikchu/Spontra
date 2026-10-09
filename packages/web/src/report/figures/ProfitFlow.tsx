import { incomeParts, type SecFigure } from "@/shared/analysis-runtime/sec-figures.ts";
import { formatValue } from "./format.ts";
import { separateLabels } from "./primitives.tsx";

type Node = { key: string; label: string; value: number; role: string; column: number; top: number };

/**
 * Revenue → gross profit → operating income → net income. Profit rises to the top-right; each
 * layer of spending sinks below the profit it was deducted from, so no band crosses a label.
 */
export function ProfitFlow({ figure }: { figure: Extract<SecFigure, { kind: "profit_flow" }> }) {
  const income = figure.current;
  const parts = incomeParts(income);
  if (!parts) return <p className="report-content-fallback">本期利润表层级为负，无法按流向绘制。</p>;
  const currency = income.currency;
  const k = 240 / income.revenue, gap = 20, rise = 20, nodeWidth = 14, offset = 30;
  const columns = [30, 280, 530, 770];
  const h = (v: number) => Math.max(1, v * k);
  const revenueTop = 3 * rise;
  const gpTop = revenueTop - rise, oiTop = gpTop - rise, niTop = oiTop - rise;
  const nodes: Node[] = [
    { key: "revenue", label: "营收", value: income.revenue, role: "total", column: 0, top: revenueTop },
    { key: "gross", label: "毛利", value: income.grossProfit, role: "kept", column: 1, top: gpTop },
    { key: "cost", label: "直接成本", value: parts.cost, role: "spent-1", column: 1, top: gpTop + h(income.grossProfit) + gap },
    { key: "operating", label: "营业利润", value: income.operatingIncome, role: "kept", column: 2, top: oiTop },
    { key: "opex", label: "经营费用", value: parts.operatingExpenses, role: "spent-2", column: 2, top: oiTop + h(income.operatingIncome) + gap },
    { key: "net", label: "净利润", value: income.netIncome, role: "net", column: 3, top: niTop },
    { key: "tax", label: "税、利息及其他", value: parts.taxAndOther, role: "spent-3", column: 3, top: niTop + h(income.netIncome) + gap },
  ];
  const node = (key: string) => nodes.find((n) => n.key === key)!;
  // Each source splits top-down in the order of its targets.
  const links: Array<[string, string]> = [["revenue", "gross"], ["revenue", "cost"], ["gross", "operating"], ["gross", "opex"], ["operating", "net"], ["operating", "tax"]];
  const used = new Map<string, number>();
  const bands = links.map(([from, to]) => {
    const source = node(from), target = node(to);
    const y0 = source.top + (used.get(from) ?? 0);
    used.set(from, (used.get(from) ?? 0) + h(target.value));
    const x0 = columns[source.column] + nodeWidth, x1 = columns[target.column], xm = (x0 + x1) / 2, th = h(target.value);
    return { key: `${from}-${to}`, role: target.role, d: `M${x0},${y0} C${xm},${y0} ${xm},${target.top} ${x1},${target.top} L${x1},${target.top + th} C${xm},${target.top + th} ${xm},${y0 + th} ${x0},${y0 + th} Z` };
  });
  const share = (v: number) => `${Math.round(v / income.revenue * 100)}%`;
  const side = nodes.filter((n) => ["cost", "opex", "net", "tax"].includes(n.key));
  const sideY = new Map<string, number>();
  for (const column of [1, 2, 3]) {
    const list = side.filter((n) => n.column === column);
    separateLabels(list.map((n) => n.top + h(n.value) / 2 - 8), 36).forEach((y, i) => sideY.set(list[i].key, y));
  }
  const height = offset + Math.max(...nodes.map((n) => n.top + h(n.value))) + 24;
  const description = `${income.date} 营收 ${formatValue(income.revenue, currency)}：直接成本 ${formatValue(parts.cost, currency)}，毛利 ${formatValue(income.grossProfit, currency)}；经营费用 ${formatValue(parts.operatingExpenses, currency)}，营业利润 ${formatValue(income.operatingIncome, currency)}；税、利息及其他 ${formatValue(parts.taxAndOther, currency)}，净利润 ${formatValue(income.netIncome, currency)}。`;
  return <svg className="sec-figure-svg sec-figure-flow" viewBox={`0 0 960 ${height}`} role="img" aria-label={description}>
    <g transform={`translate(0,${offset})`}>
      {bands.map((b) => <path key={b.key} className="sec-figure-band" data-role={b.role} d={b.d} />)}
      {nodes.map((n) => <rect key={n.key} className="sec-figure-node" data-role={n.role} x={columns[n.column]} y={n.top} width={nodeWidth} height={h(n.value)} rx="3" />)}
      {nodes.filter((n) => ["revenue", "gross", "operating"].includes(n.key)).map((n) => <text key={n.key} className="sec-figure-flow-label" data-role={n.role}
        x={columns[n.column] + nodeWidth / 2} y={n.top - 9} textAnchor={n.key === "revenue" ? "start" : "middle"}>
        <tspan className="sec-figure-flow-name">{n.label}</tspan> {formatValue(n.value, currency)}</text>)}
      {side.map((n) => <text key={n.key} className="sec-figure-flow-label" data-role={n.role} x={columns[n.column] + nodeWidth + 10} y={sideY.get(n.key)}>
        <tspan className="sec-figure-flow-name" x={columns[n.column] + nodeWidth + 10}>{n.label}</tspan>
        <tspan x={columns[n.column] + nodeWidth + 10} dy="17">{formatValue(n.value, currency)} · 占营收 {share(n.value)}</tspan>
      </text>)}
    </g>
  </svg>;
}
