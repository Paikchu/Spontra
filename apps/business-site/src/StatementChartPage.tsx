import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { messages, useLocale } from "@/packages/web/src/i18n";
import { compactFlowValue, estimateTextWidth, statementLabel } from "@/packages/web/src/model/business-flow-layout";
import { numeric } from "@/packages/web/src/model/business-flow-model";
import { statementGraph, trunkGraph, type FinancialGraph, type SankeyNode } from "@/packages/web/src/model/business-flow-sankey";
import type { BusinessFlowQuarter } from "@/shared/analysis-contract/business-flow";
import type { PublicCapitalStructure } from "@/shared/analysis-contract/capital-structure";
import { balancePool, cashPool } from "./capital-model";
import { CompanyHttpError, fetchCapital, fetchCompany, publicationFlow } from "./company-data";
import { PoolChart } from "./PoolChart";

const m = messages({
  loading: "Loading statement", unavailable: "Statement not available yet", failed: "Could not load the statement",
  retry: "Retry", quarter: "Quarter", cumulative: "Cumulative", profit: "Profit flow", cash: "Cash flows", balance: "Balance sheet",
}, {
  loading: "正在加载报表", unavailable: "暂无可用报表", failed: "报表加载失败",
  retry: "重试", quarter: "单季", cumulative: "累计", profit: "利润流向", cash: "现金流", balance: "资产负债表",
});

type Resource<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "failed" };
type Statement = "profit" | "cash" | "balance";

const subscribe = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};
const readView = (): Statement => {
  const view = new URLSearchParams(location.search).get("view");
  return view === "cash" || view === "balance" ? view : "profit";
};

const date = (day: string) => day.replaceAll("-", ".");

export default function StatementChartPage({ ticker }: { ticker: string }) {
  const locale = useLocale();
  const view = useSyncExternalStore(subscribe, readView);
  const [income, setIncome] = useState<Resource<BusinessFlowQuarter | null>>({ status: "loading" });
  const [capital, setCapital] = useState<Resource<PublicCapitalStructure | null>>({ status: "loading" });
  const [attempt, retry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const readIncome = async () => {
      try {
        const response = await fetchCompany(ticker, signal);
        const quarters = publicationFlow(response, ticker)?.quarters ?? [];
        const value = [...quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0] ?? null;
        if (!signal.aborted) setIncome({ status: "ready", value });
      } catch {
        if (!signal.aborted) setIncome({ status: "failed" });
      }
    };
    const readCapital = async () => {
      try {
        const value = await fetchCapital(ticker, signal);
        if (!signal.aborted) setCapital({ status: "ready", value });
      } catch (error) {
        if (!signal.aborted) setCapital(error instanceof CompanyHttpError && error.status === 503
          ? { status: "ready", value: null } : { status: "failed" });
      }
    };
    void readIncome();
    void readCapital();
    return () => controller.abort();
  }, [ticker, locale, attempt]);

  const resource = view === "profit" ? income : capital;
  const quarter = income.status === "ready" ? income.value : null;
  const funding = capital.status === "ready" ? capital.value?.quarters
    .filter(period => view === "cash" ? period.cashFlow || period.yearToDate : period.balanceSheet)
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0] : null;
  const balance = funding?.balanceSheet;
  const cash = funding?.cashFlow ?? funding?.yearToDate;
  // Using the cash statement's own start and end avoids labelling cumulative amounts as quarterly.
  const chartDate = view === "profit" && quarter ? `${date(quarter.periodEnd)} · ${m.quarter}`
    : view === "cash" && cash ? `${date(cash.periodStart)}–${date(cash.periodEnd)} · ${funding?.cashFlow ? m.quarter : m.cumulative}`
    : balance ? date(balance.asOf) : "";
  const chart = view === "profit" && quarter ? <ProfitDiagram quarter={quarter} />
    : view === "cash" && cash ? <PoolChart key={view} compact pool={cashPool(cash)} label={m.cash}
        money={value => compactFlowValue(value, { currency: cash.currency, scale: 1 })} />
    : view === "balance" && balance ? <PoolChart key={view} compact pool={balancePool(balance)} label={m.balance}
        money={value => compactFlowValue(value, { currency: balance.currency, scale: 1 })} /> : null;

  return <main className="statement-chart-page">
    {resource.status === "loading" ? <p className="statement-chart-status" role="status">{m.loading}</p>
      : resource.status === "failed" ? <div className="statement-chart-status" role="alert">
        <p>{m.failed}</p>
        <button type="button" onClick={() => {
          if (view === "profit") setIncome({ status: "loading" }); else setCapital({ status: "loading" });
          retry(value => value + 1);
        }}>{m.retry}</button>
      </div>
      : chart ? <figure className="statement-chart-figure" key={view}>
        <figcaption>{chartDate}</figcaption>
        {chart}
      </figure> : <p className="statement-chart-status" role="status">{m.unavailable}</p>}
  </main>;
}

const NAME_SIZE = 13, VALUE_SIZE = 16, LINE_HEIGHT = 16, BAR_HEIGHT = 6;
type TextNode = SankeyNode & { title: string; amountText: string; color: string };
type Diagram = Pick<FinancialGraph, "links"> & { nodes: TextNode[] };
type Placed = TextNode & { x: number; y: number; width: number; labels: string[]; amountLines: string[] };

function wrap(text: string, width: number, size: number, bold = false) {
  const lines: string[] = [];
  let line = "";
  const words = text.match(/[^\s\u2e80-\u9fff]+|[\u2e80-\u9fff]|\s+/gu) ?? [];
  for (const word of words.flatMap(word => estimateTextWidth(word, size, bold) > width ? [...word] : [word])) {
    if (line && estimateTextWidth(line + word, size, bold) > width) {
      lines.push(line.trimEnd());
      line = "";
    }
    line += line ? word : word.trimStart();
  }
  if (line) lines.push(line.trimEnd());
  return lines;
}

/** Expand the web graph's depths into rows when a tier has too many labels for the phone. */
function portraitLayout(graph: Diagram, width: number) {
  const columns = width < 350 ? 2 : width >= 560 ? 4 : 3;
  const levels = new Map<number, TextNode[]>();
  const incoming = new Map<string, number>(), outgoing = new Map<string, number>();
  for (const node of graph.nodes) {
    const level = levels.get(node.depth) ?? [];
    level.push(node);
    levels.set(node.depth, level);
  }
  for (const link of graph.links) {
    incoming.set(link.target, (incoming.get(link.target) ?? 0) + link.value);
    outgoing.set(link.source, (outgoing.get(link.source) ?? 0) + link.value);
  }

  const rows = [...levels].sort(([a], [b]) => a - b).flatMap(([, nodes]) =>
    Array.from({ length: Math.ceil(nodes.length / columns) }, (_, i) => nodes.slice(i * columns, (i + 1) * columns)));
  const flowWidth = (node: TextNode) => Math.max(outgoing.get(node.name) ?? 0, incoming.get(node.name) ?? 0, node.value);
  const scale = Math.min(...rows.map(row => Math.min((width / row.length - 16) * 0.84, width * 0.55) / Math.max(...row.map(flowWidth))));
  let nextTop = 5;
  const nodes = new Map<string, Placed>();
  for (const row of rows) {
    const slot = width / row.length;
    const labels = row.map(node => wrap(node.title, slot - 12, NAME_SIZE));
    const amounts = row.map(node => wrap(node.amountText, slot - 12, VALUE_SIZE, true));
    const y = nextTop + Math.max(...labels.map((lines, index) => lines.length + amounts[index].length)) * LINE_HEIGHT + 6;
    row.forEach((node, i) => {
      const barWidth = Math.max(3, scale * flowWidth(node));
      nodes.set(node.name, { ...node, width: barWidth, x: slot * (i + 0.5) - barWidth / 2, y, labels: labels[i], amountLines: amounts[i] });
    });
    nextTop = y + BAR_HEIGHT + 34;
  }

  const usedSource = new Map<string, number>(), usedTarget = new Map<string, number>();
  const links = graph.links.flatMap(link => {
    const from = nodes.get(link.source), to = nodes.get(link.target);
    if (!from || !to) return [];
    const bandWidth = link.value * scale;
    const start = from.x + (from.width - (outgoing.get(from.name) ?? 0) * scale) / 2 + (usedSource.get(from.name) ?? 0);
    const end = to.x + (to.width - (incoming.get(to.name) ?? 0) * scale) / 2 + (usedTarget.get(to.name) ?? 0);
    usedSource.set(from.name, (usedSource.get(from.name) ?? 0) + bandWidth);
    usedTarget.set(to.name, (usedTarget.get(to.name) ?? 0) + bandWidth);
    const top = from.y + BAR_HEIGHT, bottom = to.y, mid = (top + bottom) / 2;
    const d = `M${start},${top} C${start},${mid} ${end},${mid} ${end},${bottom} H${end + bandWidth} C${end + bandWidth},${mid} ${start + bandWidth},${mid} ${start + bandWidth},${top}Z`;
    return [{ key: `${link.source}>${link.target}`, d, color: to.expense ? to.color : from.color }];
  });
  return { nodes: [...nodes.values()], links, height: nextTop - 24 };
}

function ProfitDiagram({ quarter }: { quarter: BusinessFlowQuarter }) {
  const locale = useLocale();
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const graph = useMemo(() => {
    const trunk = trunkGraph(statementGraph(quarter), quarter).graph;
    const nodes = trunk.nodes.map((node): TextNode => ({
      ...node,
      title: locale === "zh-CN" && node.label === "Total company (single reportable segment)" ? "公司整体" : statementLabel(node.label),
      amountText: compactFlowValue(node.amount ? numeric(node.amount) : node.metric ? numeric(quarter.figures[node.metric]) : node.value, quarter),
      color: node.loss ? "var(--loss)" : node.expense ? "var(--flow-expense)" : node.segmentId
        ? "var(--biz-1)" : node.name === "revenue" ? "var(--flow-revenue)" : "var(--flow-profit)",
    }));
    return { nodes, links: trunk.links };
  }, [quarter, locale]);
  const layout = useMemo(() => width > 0 && graph.links.length ? portraitLayout(graph, width) : null, [width, graph]);

  return <div ref={host} className="portrait-profit">
    {!graph.links.length ? <p className="statement-chart-status" role="status">{m.unavailable}</p>
      : layout && <svg width={width} height={layout.height} viewBox={`0 0 ${width} ${layout.height}`} role="group" aria-label={m.profit}>
        <g aria-hidden="true">{layout.links.map(link => <path key={link.key} d={link.d} fill={link.color} className="fc-band" />)}</g>
        {layout.nodes.map(node => {
          const x = node.x + node.width / 2;
          const lines = [...node.labels, ...node.amountLines];
          return <g key={node.name} role="img" aria-label={`${node.title} ${node.amountText}`}>
            <rect x={node.x} y={node.y} width={node.width} height={BAR_HEIGHT} rx={2} fill={node.color} />
            <text x={x} textAnchor="middle" className="portrait-profit-label" aria-hidden="true">
              {lines.map((line, i) => <tspan key={i} x={x} y={node.y - 8 - (lines.length - 1 - i) * LINE_HEIGHT}
                className={i < node.labels.length ? "portrait-chart-name" : "portrait-chart-amount"}>{line}</tspan>)}
            </text>
          </g>;
        })}
      </svg>}
  </div>;
}
