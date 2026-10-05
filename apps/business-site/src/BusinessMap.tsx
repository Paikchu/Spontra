import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { BusinessFlowQuarter, BusinessSegment, FlowMetric, FlowSource, PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { CompanyBusinessContent } from "@/lib/earning-report/web/company-business-content";
import { financialGraph } from "@/lib/earning-report/web/business-flow-sankey";
import { compactFlowValue, type PlacedNode } from "@/lib/earning-report/web/business-flow-layout";
import { availableRevenueTrees, compareRevenueNode, revenueNodeKey } from "@/lib/earning-report/web/revenue-tree";
import { formatFlowValue, compareAmount, compareFlowAmounts, disclosedSegmentLabel, numeric, previousQuarter, reconcileQuarter } from "@/lib/earning-report/web/business-flow-model";
import { FinancialSankey } from "@/app/analysis/stocks/[ticker]/FinancialSankey";
import { FlowChart, layoutFor, type NodeCopy, type Tip } from "./FlowChart";
import type { RevenueHistory } from "@/shared/analysis-contract/revenue-history";
import type { BusinessExplainer, ExplainerClaim } from "@/shared/analysis-contract/business-explainer";
import type { GuidancePublication } from "@/shared/analysis-contract/guidance";
import { TrendPanel } from "./TrendPanel";
import { Rail } from "./Sidebar";

type Item = { key: string; id: string; parent: string | null; depth: number; name: string; value: number | null; slot: number; segment: BusinessSegment };

/** Validated categorical slots (light and dark); a fifth top-level business folds into neutral rather than a generated hue. */
const HUES = 4;
const hue = (slot: number) => `var(--biz-${slot >= 1 && slot <= HUES ? slot : 0})`;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const percent = (v: number | null) => v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;
const trend = (label: string) => label.startsWith("+") || /转盈|收窄|由负转正|金额增加/.test(label) ? "up" as const
  : label.startsWith("-") || label.startsWith("−") || /转亏|扩大|由正转负|金额减少/.test(label) ? "down" as const : undefined;
const shortName = (name: string) => name.length > 9 ? name.slice(0, 8) + "…" : name;
const shortPeriod = (end: string) => end.slice(0, 7).replace("-", ".");

/** Hue follows the business, not its rank: slots are assigned once, newest quarter first, and kept when the period changes. */
function hueSlots(quarters: BusinessFlowQuarter[]) {
  const slots = new Map<string, number>();
  for (const quarter of quarters) {
    const tree = availableRevenueTrees(quarter)[0];
    const roots = tree ? tree.nodes.filter(n => n.parentId === null).map(n => revenueNodeKey(tree, n.id)) : quarter.segments.map(s => s.id);
    for (const key of roots) if (!slots.has(key)) slots.set(key, slots.size + 1);
  }
  return slots;
}

function businessItems(quarter: BusinessFlowQuarter | undefined, business: CompanyBusinessContent | null, slots: Map<string, number>) {
  const tree = quarter ? availableRevenueTrees(quarter)[0] : undefined;
  if (!tree) {
    const segments = quarter?.segments.length ? quarter.segments : business?.groups ?? [];
    return { quantified: false, items: segments.map((segment, i): Item => ({ key: segment.id, id: segment.id, parent: null, depth: 0, name: disclosedSegmentLabel(segment.name), value: null, slot: slots.get(segment.id) ?? i + 1, segment })) };
  }
  const items: Item[] = [];
  const visit = (id: string | null, depth: number, slot: number) => tree.nodes.filter(n => n.parentId === id).forEach(node => {
    const key = revenueNodeKey(tree, node.id), own = depth === 0 ? slots.get(key) ?? 0 : slot;
    items.push({ key, id: node.id, parent: node.parentId === null ? null : revenueNodeKey(tree, node.parentId), depth, name: disclosedSegmentLabel(node.name), value: numeric(node.revenue), slot: own, segment: node });
    visit(node.id, depth + 1, own);
  });
  visit(null, 0, 0);
  return { quantified: true, items };
}

function useTween(target: number | null, ms = 650) {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (target == null || from.current == null || reducedMotion()) { from.current = target; setValue(target); return; }
    const start = performance.now(), origin = from.current;
    let frame = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms), eased = 1 - Math.pow(1 - p, 4);
      from.current = origin + (target - origin) * eased;
      setValue(from.current);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

function Stat({ label, value, format, note, tone }: { label: string; value: number | null; format: (v: number | null) => string; note?: string; tone?: "up" | "down" }) {
  const shown = useTween(value);
  return <div className="stat">
    <span className="stat-label">{label}</span>
    <strong className="stat-value">{format(shown)}</strong>
    {note && <span className="stat-note" data-trend={tone}>{note}</span>}
  </div>;
}

function Sources({ sources, ids }: { sources: FlowSource[]; ids?: string[] }) {
  const list = sources.filter(s => (!ids || ids.includes(s.id)) && /^https?:\/\//.test(s.url));
  if (!list.length) return null;
  return <ul className="sources">{list.map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}<span aria-hidden="true"> ↗</span></a></li>)}</ul>;
}

export function BusinessMap({ ticker, tools, flow, business, notice, revenueHistory, explainer = null, guidance = null }: { ticker: string; tools: ReactNode; flow: PublicBusinessFlow; business: CompanyBusinessContent | null; notice: string | null; revenueHistory: RevenueHistory | null; explainer?: BusinessExplainer | null; guidance?: GuidancePublication | null }) {
  const quarters = useMemo(() => [...flow.quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)), [flow]);
  const [period, setPeriod] = useState<string | null>(null);
  const quarter = quarters.find(q => q.id === period) ?? quarters[0];
  const reportPeriods = useMemo(() => [...new Set([...quarters.map(q => q.periodEnd), ...(revenueHistory?.quarters ?? []).map(q => q.periodEnd)])]
    .sort((a, b) => b.localeCompare(a)).slice(0, 8), [quarters, revenueHistory]);
  const previous = quarter ? previousQuarter(quarter, quarters) : null;
  const slots = useMemo(() => hueSlots(quarters), [quarters]);
  const { items, quantified } = useMemo(() => businessItems(quarter, business, slots), [quarter, business, slots]);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("business"));
  const [preview, setPreview] = useState<string | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const current = items.find(item => item.id === selected) ?? null;
  const revenue = quarter ? numeric(quarter.figures.revenue) : null;
  const segmentRevenue = quarter?.revenueAdjustments?.length ? quarter.segments.reduce((sum,s)=>sum+(numeric(s.revenue)??0),0) : revenue;
  const shareBasis = quarter?.revenueAdjustments?.length ? '抵销前分部收入' : '总收入';
  const money = useCallback((v: number | null) => quarter ? compactFlowValue(v, quarter) : "—", [quarter]);

  useEffect(() => {
    const url = new URL(location.href);
    if (current) url.searchParams.set("business", current.id); else url.searchParams.delete("business");
    if (url.href !== location.href) history.replaceState(history.state, "", url);
  }, [current]);
  // A business picked in the chart is brought into view in the list, scrolling only the list (a column or, on narrow screens, a chip row).
  useEffect(() => {
    const option = listRef.current?.querySelector<HTMLElement>('[role=option][aria-selected="true"]');
    if (option) revealInList(option, behavior());
  }, [current?.key]);
  useEffect(() => {
    const escape = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape" && !(e.target as HTMLElement).closest("input,select")) setSelected(null); };
    addEventListener("keydown", escape);
    return () => removeEventListener("keydown", escape);
  }, []);

  const graph = useMemo(() => quarter ? financialGraph(quarter) : null, [quarter]);
  const previousGraph = useMemo(() => previous ? financialGraph(previous) : null, [previous]);
  const amountOf = useCallback((n: PlacedNode) => n.amount ? numeric(n.amount) : n.metric && quarter ? numeric(quarter.figures[n.metric]) : n.value, [quarter]);
  /** Same comparison as the list and tooltip: only an equal-definition prior quarter yields a change. */
  const changeOf = useCallback((n: PlacedNode) => !quarter ? "不可比"
    : n.amount ? compareFlowAmounts(quarter, previous, n.name, n.amount, previousGraph?.nodes.find(p => p.name === n.name)?.amount).label
    : n.metric ? compareAmount(quarter, previous, n.metric).label
    : n.segmentId ? compareRevenueNode(quarter, previous, n.segmentId).label : "不可比", [quarter, previous, previousGraph]);
  const copy = useCallback((n: PlacedNode): NodeCopy => {
    const label = changeOf(n);
    return { name: shortName(n.label), value: money(amountOf(n)), ...(label !== "不可比" ? { change: { label, trend: trend(label) } } : {}) };
  }, [money, amountOf, changeOf]);
  const layout = useMemo(() => graph ? layoutFor(graph, copy) : null, [graph, copy]);
  const proportional = Boolean(quarter && layout && quarter.incomeModel !== "financial" && quarter.incomeModel !== "insurance");

  const itemByNode = useMemo(() => new Map(items.map(item => ["segment:" + item.key, item])), [items]);
  const toneOf = useMemo(() => new Map(layout?.nodes.map(n => [n.name, n.tone]) ?? []), [layout]);
  const colorOf = useCallback((name: string) => {
    const item = itemByNode.get(name);
    if (item) return hue(item.slot);
    if (name === "revenue") return "var(--flow-revenue)";
    if (toneOf.get(name) === "loss") return "var(--loss)";
    return toneOf.get(name) === "expense" ? "var(--flow-expense)" : "var(--flow-profit)";
  }, [itemByNode, toneOf]);

  const tipFor = useCallback((n: PlacedNode): Tip => {
    if (!quarter) return { title: n.label, color: colorOf(n.name), rows: [] };
    const rows: Array<[string, string]> = [["本季", money(amountOf(n))]];
    if (revenue && n.name !== "revenue") rows.push([(n.tone === "profit" || n.tone === "loss") && !n.segmentId ? "利润率" : "占收入", percent((amountOf(n) ?? n.value) / revenue * 100)]);
    if (n.offset && graph) {
      rows.push(["已抵减", money(graph.links.filter(l => l.target === n.name).reduce((sum, l) => sum + l.value, 0))]);
      rows.push(["抵减后余额", money(graph.links.filter(l => l.source === n.name).reduce((sum, l) => sum + l.value, 0))]);
    }
    if(n.segmentId&&quarter.revenueAdjustments?.length)rows.splice(1,1,["占抵销前分部收入",percent((amountOf(n)??0)/segmentRevenue!*100)]);
    rows.push(["环比", changeOf(n)], [`原披露金额（${quarter.currency} 百万）`, formatFlowValue(amountOf(n),quarter)]);
    return { title: n.label, color: colorOf(n.name), rows };
  }, [quarter, revenue, money, amountOf, colorOf, changeOf, graph, segmentRevenue]);

  const previewItem = items.find(item => item.key === preview);
  const active = previewItem ? "segment:" + previewItem.key : hoverNode ?? (current ? "segment:" + current.key : null);
  const hovered = hoverNode ? itemByNode.get(hoverNode)?.key : undefined;

  function onListKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const order = [null, ...items.map(item => item.id)];
    const options = [...(listRef.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])];
    const index = Math.max(0, options.indexOf(e.target as HTMLElement));
    const next = e.key === "Home" ? 0 : e.key === "End" ? order.length - 1 : Math.max(0, Math.min(order.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)));
    setSelected(order[next]);
    listRef.current?.querySelectorAll<HTMLElement>("[role=option]")[next]?.focus();
  }

  const reconciliation = quarter ? reconcileQuarter(quarter) : [];
  const balanced = reconciliation.length > 0 && reconciliation.every(r => r.status === "balanced");
  const figure = (key: FlowMetric) => quarter ? numeric(quarter.figures[key]) : null;
  const margin = (key: FlowMetric) => { const v = figure(key); return v != null && revenue ? `利润率 ${percent(v / revenue * 100)}` : "利润率 —"; };
  const change = (key: FlowMetric) => quarter ? compareAmount(quarter, previous, key).label : "不可比";
  const itemChange = current && quarter ? compareRevenueNode(quarter, previous, current.key).label : "不可比";
  const parent = current?.parent ? items.find(item => item.key === current.parent) : null;

  return <div className="map">
    <Rail ticker={ticker} actions={tools} label="公司业务">
      <div className="rail-list" role="listbox" aria-label="选择业务以在图中高亮" ref={listRef} onKeyDown={onListKey} onMouseLeave={() => setPreview(null)}>
        <Button variant="unstyled" type="button" role="option" aria-selected={!current} tabIndex={!current ? 0 : -1} className="row row--all" onClick={() => setSelected(null)} onMouseEnter={() => setPreview(null)}>
          <i className="row-chip row-chip--all" aria-hidden="true" />
          <span className="row-name">全部业务</span>
          <span className="row-value">{revenue != null ? money(revenue) : ""}</span>
          {quarter && <span className="row-meta">总收入 · 环比 {change("revenue")}</span>}
        </Button>
        {items.map(item => {
          const share = item.value != null && segmentRevenue ? item.value / segmentRevenue * 100 : null;
          const delta = quarter && quantified ? compareRevenueNode(quarter, previous, item.key).label : "不可比";
          return <Button variant="unstyled" type="button" role="option" key={item.key} aria-selected={current?.key === item.key} tabIndex={current?.key === item.key ? 0 : -1}
            className="row" data-depth={item.depth} data-hover={hovered === item.key || undefined} style={{ "--c": hue(item.slot) } as CSSProperties}
            onClick={() => setSelected(current?.key === item.key ? null : item.id)} onMouseEnter={() => setPreview(item.key)}>
            <i className="row-chip" aria-hidden="true" />
            <span className="row-name">{item.name}</span>
            <span className="row-value">{item.value != null ? money(item.value) : ""}</span>
            {share != null && <span className="row-bar" aria-hidden="true"><b style={{ width: `${Math.max(0.6, share)}%` }} /></span>}
            <span className="row-meta">{share != null ? <>{percent(share)}{quarter.revenueAdjustments?.length?" · 抵销前":""}{delta !== "不可比" && <> · <em data-trend={trend(delta)}>环比 {delta}</em></>}</> : "定性归属 · 比例未披露"}</span>
          </Button>;
        })}
      </div>
      {!!quarter?.revenueAdjustments?.length&&<p className="revenue-reconciliation">收入对账 · {quarter.currency} 百万<br/>分部收入（抵销前） {formatFlowValue(segmentRevenue,quarter)}<br/>{quarter.revenueAdjustments.map(a=><span key={a.id}>{a.name} {formatFlowValue(numeric(a.amount),quarter)}<br/></span>)}合并收入 {formatFlowValue(revenue,quarter)}</p>}
    </Rail>

    <section className="stage" data-trend={revenueHistory && revenueHistory.quarters.length >= 2 ? "" : undefined} aria-label={`${ticker} 收入到利润流向`}>
      <header className="stage-head stage-head--summary">
        {quarter && <div className="stats" aria-live="polite">
          {current && current.value != null ? <>
            <Stat label="本季收入" value={current.value} format={money} note={`环比 ${itemChange}`} tone={trend(itemChange)} />
            <Stat label={`占${shareBasis}`} value={segmentRevenue ? current.value / segmentRevenue * 100 : null} format={percent} note={parent?.value ? `占${parent.name} ${percent(current.value / parent.value * 100)}` : "一级业务"} />
            <Stat label="公司总收入" value={revenue} format={money} note="成本与利润不按业务分摊" />
          </> : <>
            <Stat label="总收入" value={revenue} format={money} note={`环比 ${change("revenue")}`} tone={trend(change("revenue"))} />
            {quarter.incomeModel !== "direct_operating" && figure("gross") != null && <Stat label="毛利" value={figure("gross")} format={money} note={margin("gross")} />}
            {figure("operating") != null || figure("pretax") == null
              ? <Stat label="营业利润" value={figure("operating")} format={money} note={margin("operating")} />
              : <Stat label="税前利润" value={figure("pretax")} format={money} note={margin("pretax")} />}
            <Stat label="净利润" value={figure("net")} format={money} note={margin("net")} />
          </>}
        </div>}
        {quarter && <label className="report-select">
          <span>财报季度</span>
          <NativeSelect appearance="native" value={quarter.id} onChange={event => setPeriod(event.target.value)}>
            <NativeSelectOptGroup label="近两年 · 季度报告">
              {reportPeriods.map(end => {
                const report = quarters.find(q => q.periodEnd === end);
                return <NativeSelectOption key={end} value={report?.id ?? end} disabled={!report}>{shortPeriod(end)}{report ? "" : " · 完整报告暂不可用"}</NativeSelectOption>;
              })}
            </NativeSelectOptGroup>
          </NativeSelect>
        </label>}
      </header>

      <div className="chart">
        {!quarter ? <div className="empty"><h2>季度财务未披露</h2><p>需要同币种、同口径的三个月数据才能绘制流向；不会用示例数据替代。</p></div>
          : proportional && layout ? <FlowChart graph={graph!} copy={copy} money={v => money(v)} colorOf={colorOf} active={active} revealKey={quarter.id} productBusiness={current ? "segment:" + current.key : null} businessDetails={<Dossier item={current} parent={parent ?? null} sources={quarter?.sources.length ? quarter.sources : business?.sources ?? []} explainer={explainer} />} onCloseProducts={() => setSelected(null)}
              focusSlot={n => segmentRevenue ? `占${shareBasis} ${percent(n.value / segmentRevenue * 100)}` : null}
              onHover={name => setHoverNode(name)} tipFor={tipFor}
              onPick={n => { const item = itemByNode.get(n.name); setSelected(item && current?.key !== item.key ? item.id : null); }}
              label={`${ticker} ${quarter.label} 收入到净利润桑基图，金额单位 ${quarter.currency}`} />
          : <div className="business-flow chart-fallback">{current && <Dossier item={current} parent={parent ?? null} sources={quarter.sources.length ? quarter.sources : business?.sources ?? []} explainer={explainer} />}<FinancialSankey quarter={quarter} previous={previous} onSegment={key => setSelected(items.find(item => item.key === key)?.id ?? null)} /></div>}
      </div>

      {revenueHistory && revenueHistory.quarters.length >= 2 && <TrendPanel history={revenueHistory} items={items} selected={current} currentPeriod={quarter?.periodEnd ?? null}
        periods={new Set(quarters.map(q => q.periodEnd))} onPickPeriod={end => setPeriod(quarters.find(q => q.periodEnd === end)?.id ?? null)} hue={hue} guidance={guidance} />}

      <footer className="stage-foot">
        {proportional ? <div className="legend" aria-label="图例">
          <span><i className="legend-biz" />业务收入</span>
          <span><i style={{ background: "var(--flow-profit)" }} />利润</span>
          {graph?.signed && <span><i style={{ background: "var(--loss)" }} />亏损</span>}
          <span><i style={{ background: "var(--flow-expense)" }} />成本与费用</span>
          <span className="legend-note">线宽 = 本季金额{graph?.signed ? "绝对值" : ""}{previous ? " · 百分比 = 较上季变化" : ""}</span>
        </div> : <span className="legend-note">框图表示会计关系，宽度不代表金额</span>}
        <p className="provenance">
          {notice && <span>{notice}</span>}
          {graph?.notice && proportional && <span>{graph.notice}</span>}
          {quarter && <span>{balanced ? `${reconciliation.length} 项会计等式已核对` : "部分披露缺失，只绘制已对平路径"}</span>}
          {flow.fetchedAt && <span>数据 {flow.fetchedAt.slice(0, 10)}</span>}
        </p>
      </footer>
    </section>
  </div>;
}

const behavior = (): ScrollBehavior => reducedMotion() ? "auto" : "smooth";

/** Scrolls each scrollable ancestor just enough to show the element; unlike scrollIntoView it never moves the page. */
function revealInList(element: HTMLElement, mode: ScrollBehavior) {
  for (let box = element.parentElement; box && box !== document.body; box = box.parentElement) {
    const style = getComputedStyle(box), outer = box.getBoundingClientRect(), inner = element.getBoundingClientRect(), pad = 8;
    const top = /auto|scroll/.test(style.overflowY) && box.scrollHeight > box.clientHeight
      ? inner.top < outer.top + pad ? inner.top - outer.top - pad : inner.bottom > outer.bottom - pad ? inner.bottom - outer.bottom + pad : 0 : 0;
    const left = /auto|scroll/.test(style.overflowX) && box.scrollWidth > box.clientWidth
      ? inner.left < outer.left + pad ? inner.left - outer.left - pad : inner.right > outer.right - pad ? inner.right - outer.right + pad : 0 : 0;
    if (top || left) box.scrollBy({ top, left, behavior: mode });
  }
}

function Dossier({ item, parent, sources, explainer }: { item: Item | null; parent: Item | null; sources: FlowSource[]; explainer: BusinessExplainer | null }) {
  if (!item) return null;
  const explained = explainer?.businesses.find(b => b.nodeId === item.id);
  if (explainer && explained) return <ExplainedDossier key={item.key} item={item} parent={parent} explainer={explainer} explained={explained} />;
  const segment = item.segment;
  const [description, basis] = (segment.description || "业务说明未披露").split("\n");
  return <section className="dossier" key={item.key} aria-label={`${item.name} 业务档案`}>
    <h3>{parent ? `${parent.name} / ` : ""}{item.name}</h3>
    <p>{description}</p>

    <dl>
      <dt>客户</dt><dd>{segment.customers ?? "未披露"}</dd>
      <dt>收费方式</dt><dd>{segment.monetization ?? "未披露"}</dd>
    </dl>
    {basis && <p className="fine">{basis}</p>}
    <Sources sources={sources} ids={segment.sourceIds} />
  </section>;
}

/** A model-written explanation: every statement carries numbered links to the pages it was written from. */
function ExplainedDossier({ item, parent, explainer, explained }: { item: Item; parent: Item | null; explainer: BusinessExplainer; explained: BusinessExplainer["businesses"][number] }) {
  const claims = [...(explained.offerings ?? []).flatMap(p => [p.description, p.charging]), explained.summary, explained.howItWorks, explained.customers, explained.monetization, explained.relation];
  const cited = [...new Set(claims.flatMap(c => c?.sourceIds ?? []))].map(id => explainer.sources.find(s => s.id === id)).filter(s => s != null);
  const cite = (claim: ExplainerClaim) => <span className="cites">{claim.sourceIds.map(id => {
    const index = cited.findIndex(s => s.id === id);
    return index < 0 ? null : <a key={id} href={cited[index].url} target="_blank" rel="noopener noreferrer" title={cited[index].title}>{index + 1}</a>;
  })}</span>;
  const rows: Array<[string, ExplainerClaim | null]> = [["产品介绍", explained.offerings?.length ? null : explained.howItWorks], ["客户", explained.customers], ["收费方式", explained.monetization], ["关联业务", explained.relation]];
  return <section className="dossier" aria-label={`${item.name} 业务档案`}>
    <h3>{parent ? `${parent.name} / ` : ""}{item.name}</h3>
    <p className="dossier-lede">{explained.summary.text}{cite(explained.summary)}</p>

    {explained.offerings?.length ? <><h4>产品介绍</h4><dl>{explained.offerings.map(p => <Fragment key={p.id}><dt>{p.name}</dt><dd>{p.description.text}{cite(p.description)}</dd></Fragment>)}</dl></> : null}
    <dl>{rows.filter(([, claim]) => claim).map(([label, claim]) => <Fragment key={label}><dt>{label}</dt><dd>{claim!.text}{cite(claim!)}</dd></Fragment>)}</dl>

    <ol className="sources sources--numbered">{cited.map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}<span aria-hidden="true"> ↗</span></a></li>)}</ol>
  </section>;
}
