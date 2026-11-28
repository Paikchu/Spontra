import { useEffect, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, Radar, RadarChart, PolarAngleAxis, PolarGrid, PolarRadiusAxis, XAxis, YAxis } from "recharts";
import { Dialog, DialogContent, DialogTitle } from "@/web/shared/ui/dialog";
import { Button } from "@/web/shared/ui/button";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/web/shared/ui/chart";
import { NativeSelect, NativeSelectOption } from "@/web/shared/ui/native-select";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/web/shared/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/web/shared/ui/tabs";
import type { PublicFilingDigest, PublicFilingDetail } from "@/src/domains/filing-analysis/filings-contract";
import type { CompanyEvent, EventsResponse } from "@/src/domains/financials/events-contract";
import type { ValuationEvidence, ValuationResponse, ValuationVersionRange } from "@/src/domains/valuation/contract";
import type { CapitalResponse } from "@/src/domains/financials/capital-structure-contract";
import type { BusinessFlowQuarter } from "@/src/domains/financials/business-flow-contract";
import type { BusinessTree, TreeNode } from "@/src/domains/business-map/tree-contract";
import { ArtifactDocumentFrame } from "@/web/preview/ArtifactFrame";
import "@/web/preview/article-preview.css";

const locale = "lang=zh-CN&schema=artifact-i18n-v2-layers";
function usePublication<T>(ticker: string, path: string | null, lang = true) {
  const url = path === null ? "" : `/api/business/v1/companies/${encodeURIComponent(ticker)}${path}${lang ? `?${locale}` : ""}`;
  const [result, setResult] = useState<{ url: string; data?: T; failure?: boolean }>();
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal, credentials: "same-origin" }).then(async response => {
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json() as T;
      if (!controller.signal.aborted) setResult({ url, data });
    }).catch(() => { if (!controller.signal.aborted) setResult({ url, failure: true }); });
    return () => controller.abort();
  }, [url]);
  return result?.url === url ? result : undefined;
}
const caption = "caption-top mb-3 text-left text-base font-semibold text-foreground";
const muted = "text-sm text-muted-foreground";
function dateText(s: string | null | undefined) { return s?.slice(0, 10) ?? "—"; }
function money(value: string | number | null | undefined, currency = "USD", scale = 1) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  return Intl.NumberFormat("zh-CN", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(value) * scale);
}
function safeLink(value: string | null | undefined) { return value?.startsWith("https://") ? value : undefined; }
function status(result: { failure?: boolean } | undefined, empty: string) {
  return <p className={muted} role={result?.failure ? "alert" : "status"}>{result?.failure ? "读取失败，请刷新重试" : !result ? "加载中…" : empty}</p>;
}

type Feed = { status?: string; filings?: { filings: PublicFilingDigest[] } };
type Story = { id: string; date: string; title: string; form: string; category: "reports" | "management"; period?: string; periodLabel?: string | null; filing?: PublicFilingDigest; event?: CompanyEvent; purchase?: boolean };
const periodic = /^(10-[KQ]|20-F|40-F)(\/A)?$/;
const earningsRelease = (e: CompanyEvent) => e.class === "earnings" && (e.items.includes("2.02") || !e.form.startsWith("8-K"));
function shiftQuarter(period: string, quarters: number) {
  const source = new Date(`${period}T00:00:00Z`);
  const year = source.getUTCFullYear(), month = source.getUTCMonth(), day = source.getUTCDate();
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const max = new Date(Date.UTC(year, month + quarters * 3 + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month + quarters * 3, day === last ? max : Math.min(day, max))).toISOString().slice(0, 10);
}
function releasePeriod(filed: string, id: string, reportPeriods: string[], releases: CompanyEvent[]) {
  const anchor = reportPeriods.at(-1);
  let synthetic: string | undefined;
  if (anchor && /^\d{4}-\d{2}-\d{2}$/.test(anchor) && Number.isFinite(Date.parse(anchor))) {
    let step = 0;
    while (step > -400 && shiftQuarter(anchor, step) >= filed) step--;
    while (step < 400 && shiftQuarter(anchor, step + 1) < filed) step++;
    synthetic = shiftQuarter(anchor, step);
  }
  const period = [...reportPeriods, ...(synthetic ? [synthetic] : [])].filter(end => end < filed).sort().at(-1);
  return period && !releases.some(e => e.id !== id && e.filedAt > period && e.filedAt < filed) ? period : undefined;
}
function stories(filings: PublicFilingDigest[], events: CompanyEvent[]): Story[] {
  const result: Story[] = [];
  const indexed = new Map(filings.map(f => [f.accessionNumber, f]));
  for (const f of filings.filter(f => f.periodEnd && periodic.test(f.form)).slice(0, 40)) {
    result.push({ id: f.accessionNumber, date: f.date ?? f.filingDate, title: f.headline?.trim() || `${f.form} 申报文件`, category: "reports",
      period: f.periodEnd ?? f.reportDate, periodLabel: f.periodLabel, form: f.form, filing: f });
    indexed.delete(f.accessionNumber);
  }
  const periods = result.flatMap(s => s.period ? [s.period] : []).sort();
  const releases = events.filter(earningsRelease);
  for (const e of events.slice(0, 120)) {
    if (result.some(s => s.id === e.id)) continue;
    const filing = indexed.get(e.id), insider = e.insider;
    const sold = insider?.sold?.shares ?? 0, bought = insider?.bought?.shares ?? 0;
    if (insider && sold <= 0 && bought <= 0) continue;
    const earnings = earningsRelease(e);
    const title = insider ? `${insider.ownerName} ${sold >= bought ? "卖出" : "买入"}` : e.summary?.headline?.trim() || filing?.headline?.trim() || (earnings ? `${e.form} 业绩公告` : null);
    if (!title) continue;
    const period = earnings ? releasePeriod(e.filedAt, e.id, periods, releases) : undefined;
    result.push({ id: e.id, date: e.filedAt, title, category: insider || e.class === "executive" ? "management" : "reports", period,
      periodLabel: result.find(s => s.period === period)?.periodLabel, purchase: insider != null && sold === 0, form: e.form, filing, event: e });
    indexed.delete(e.id);
  }
  for (const f of indexed.values()) if (f.headline?.trim()) result.push({
    id: f.accessionNumber, title: f.headline.trim(), date: f.date ?? f.filingDate, form: f.form, category: "reports", filing: f,
  });
  return result.sort((a, b) => b.date.localeCompare(a.date) || Number(periodic.test(b.form)) - Number(periodic.test(a.form)) || a.id.localeCompare(b.id));
}

type Scoped = { ticker: string; children: ReactNode };
export function AppStream({ ticker, children }: Scoped) {
  const filings = usePublication<Feed>(ticker, "/filings"), events = usePublication<EventsResponse>(ticker, "/events");
  const [mode, setMode] = useState("all"), [active, setActive] = useState<Story>();
  const detail = usePublication<PublicFilingDetail>(ticker, active && !active.event?.insider ? `/filings/${active.id}` : null);
  const entries = stories(filings?.data?.filings?.filings ?? [], events?.data?.events?.events ?? []).filter(item => mode === "all" || mode === item.category);
  const blocks = new Map<string, Story[]>();
  for (const item of entries) {
    const same = item.period && [...blocks.keys()].find(key => key.startsWith("quarter:") && Math.abs(Date.parse(key.slice(8)) - Date.parse(item.period!)) <= 864000000);
    const key = item.period ? same || `quarter:${item.period}` : item.purchase ? `trade:${item.date}` : item.id;
    const group = blocks.get(key);
    if (group) group.push(item);
    else blocks.set(key, [item]);
  }
  const artifact = detail?.data?.artifact;
  const insider = active?.event?.insider;
  return <div className="flex min-w-0 flex-col gap-6">
    {!active && <Tabs value={mode} onValueChange={setMode}>
      <TabsList><TabsTrigger value="all">全部</TabsTrigger><TabsTrigger value="reports">财报</TabsTrigger><TabsTrigger value="management">管理层动态</TabsTrigger></TabsList>
    </Tabs>}
    {active ? <article className="flex min-w-0 flex-col gap-4">
      <div><Button variant="ghost" onClick={() => setActive(undefined)}>返回动态</Button></div>
      {!artifact && <h2 className="text-lg! font-semibold">{active.title}</h2>}
      <p className={muted}>{active.date} · {active.form}</p>
      {artifact ? <ArtifactDocumentFrame key={artifact.hash} artifact={artifact} hostTitle={active.title}/>
        : <div className="flex flex-col gap-3">
            {(!detail || detail.failure) && !insider && status(detail, "")}
            {active.event?.summary?.analystView && <p className="whitespace-pre-line">{active.event.summary.analystView}</p>}
            {active.filing?.analystView && !active.event?.summary?.analystView && <p className="whitespace-pre-line">{active.filing.analystView}</p>}
            {active.filing?.bullets.map(line => <p key={line.label}><strong>{line.label}</strong> {line.detail}</p>)}
            {active.filing?.risks?.map(line => <p key={line}>{line}</p>)}
            {insider && <div className="flex flex-col gap-2">
              <p>{insider.ownerName} · {insider.title ?? "内部人"}</p>
              {insider.sold && <p>公开市场卖出：{insider.sold.shares.toLocaleString()} 股 · {money(insider.sold.averagePrice)} / 股 · {money(insider.sold.proceeds)}</p>}
              {insider.bought && <p>公开市场买入：{insider.bought.shares.toLocaleString()} 股 · {money(insider.bought.averagePrice)} / 股 · {money(insider.bought.cost)}</p>}
              {insider.rule10b51 && <p>依据 Rule 10b5-1 预设交易计划执行</p>}
            </div>}
            {safeLink(active.event?.edgarUrl ?? active.filing?.edgarUrl) && <a className="underline" href={safeLink(active.event?.edgarUrl ?? active.filing?.edgarUrl)} target="_blank" rel="noreferrer">SEC 原始文件</a>}
          </div>}
    </article> : <>
      {(!filings || !events || filings.failure || events.failure) && status(filings?.failure ? filings : events?.failure ? events : undefined, "")}
      {!entries.length && filings?.data && events?.data && <p className={muted}>暂无已发布动态</p>}
      {[...blocks].map(([key, rows]) => <section key={key} className="flex flex-col gap-2">
        {key.startsWith("quarter:") && <h2 className="text-base font-semibold">{rows.find(row => row.periodLabel)?.periodLabel || rows[0].period}</h2>}
        {key.startsWith("trade:") && rows.length > 1 && <h2 className="text-base font-semibold">{rows[0].date} · {rows.length} 条内部人买入</h2>}
        {rows.map(item => <Button variant="ghost" key={item.id} className="h-auto min-h-12 justify-start gap-4 px-2 py-2 text-left whitespace-normal" onClick={() => setActive(item)}>
          <time className="shrink-0 text-muted-foreground">{item.date}</time><span className="min-w-0">{item.title}</span>
        </Button>)}
      </section>)}
    </>}
    {!active && children}
  </div>;
}

type Flow = { status: string; layers?: Record<string, boolean>; flow?: { quarters: BusinessFlowQuarter[] }; reports?: { quarters: BusinessFlowQuarter[] }; tree?: BusinessTree };
function businessNode(node: TreeNode) {
  return <li key={node.id} className="flex flex-col gap-2">
    <strong>{node.name}</strong><p>{node.summary?.text ?? node.gloss}</p>
    {node.revenue?.map(item => <p key={item.label}>{item.label}：{item.text}</p>)}
    {node.children.length > 0 && <ul className="ml-4 flex flex-col gap-3">{node.children.map(businessNode)}</ul>}
  </li>;
}
export function AppBusiness({ ticker, children }: Scoped) {
  const result = usePublication<Flow>(ticker, ""), publication = result?.data;
  const tree = publication?.layers?.tree === false ? undefined : publication?.tree;
  const quarters = [...(publication?.flow?.quarters ?? []), ...(publication?.reports?.quarters ?? [])];
  const quarter = tree ? quarters.find(row => row.periodEnd === tree.periodEnd) : quarters.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  const branches = tree?.branches ?? [];
  const breakdown = quarter?.revenueBreakdowns?.find(x => x.complete && ["business", "product_service", "end_market", "segment"].includes(x.kind));
  const segments = quarter?.segments.length ? quarter.segments : breakdown?.nodes.filter(x => !x.parentId) ?? [];
  const disclosed = new Map([...(quarter?.segments ?? []), ...(breakdown?.nodes ?? [])].map(s => [s.id, s]));
  const rendered = new Set(branches.map(b => b.flowNodeId));
  return <div className="flex min-w-0 flex-col gap-6">
    {publication?.status === "ready" && (branches.length || segments.length) ? <>
      <div className="flex flex-wrap items-baseline gap-4"><h2 className="text-lg font-semibold">业务构成</h2><time className={muted}>{tree?.periodEnd ?? quarter?.periodEnd}</time></div>
      {quarter && <p className="text-base">总营收 <strong>{money(quarter.figures.revenue?.value, quarter.currency, quarter.scale)}</strong></p>}
      {branches.map(branch => <details key={branch.flowNodeId ?? branch.name} className="py-2">
        <summary className="cursor-pointer text-base font-medium">{branch.name} {branch.flowNodeId && disclosed.has(branch.flowNodeId) && <span className={muted}>{money(disclosed.get(branch.flowNodeId)?.revenue?.value, quarter?.currency, quarter?.scale)}</span>}</summary>
        <p className="mt-3 text-sm">{branch.summary?.text}</p>
        <ul className="mt-3 flex flex-col gap-3">{branch.children.map(businessNode)}</ul>
      </details>)}
      {segments.filter(s => !rendered.has(s.id)).map(s => <p key={s.id}>{s.name} <span className={muted}>{money(s.revenue?.value, quarter?.currency, quarter?.scale)}</span></p>)}
      {!!tree?.sources.length && <div className="flex flex-wrap gap-3">{tree.sources.filter(s => safeLink(s.url)).map(s => <a key={s.id} href={s.url} target="_blank" rel="noreferrer" className="underline">{s.title}</a>)}</div>}
    </> : status(result, "暂无已发布业务地图")}
    <details className="min-w-0"><summary className="cursor-pointer py-2 font-medium">业务地图管理</summary>{children}</details>
  </div>;
}

const incomeLabels: Record<string, string> = { revenue: "营收", cost: "营收成本", gross: "毛利润", research: "研发费用", sales: "销售费用", administration: "管理费用", operatingExpenses: "经营费用", operating: "经营利润", other: "非经营损益", pretax: "税前利润", tax: "所得税", net: "净利润" };
type LineItem = [string, string | number | null | undefined];
function financialTable(title: string, rows: LineItem[], currency?: string, scale?: number) {
  return rows.length ? <Table><TableCaption className={caption}>{title}</TableCaption><TableHeader><TableRow><TableHead>科目</TableHead><TableHead className="text-right">金额</TableHead></TableRow></TableHeader>
    <TableBody>{rows.map(([name, value], index) => <TableRow key={`${name}:${index}`}><TableCell>{name}</TableCell><TableCell className="text-right tabular-nums">{money(value, currency, scale)}</TableCell></TableRow>)}</TableBody></Table> : <p className={muted}>暂无{title}</p>;
}

export function AppStatements({ ticker, children }: Scoped) {
  const flow = usePublication<Flow>(ticker, ""), capital = usePublication<CapitalResponse>(ticker, "/capital");
  const [period, setPeriod] = useState(""), [comparison, setComparison] = useState("qoq");
  const quarters = flow?.data?.flow?.quarters ?? [];
  const caps = capital?.data?.capital?.quarters ?? [];
  const periods = [...new Set([...quarters, ...caps].map(q => q.periodEnd))].sort().reverse();
  const active = period || periods[0];
  const income = quarters.find(q => q.periodEnd === active);
  const current = caps.find(q => q.periodEnd === active);
  const cash = current?.cashFlow ?? current?.yearToDate, balance = current?.balanceSheet;
  const incomeRows: LineItem[] = Object.entries(income?.figures ?? {}).map(([key, figure]) => [incomeLabels[key] ?? key, figure.value]);
  const expenseRows: LineItem[] = (income?.expenseComponents ?? []).map(component => [component.name, component.amount.value]);
  const history = [...new Map([...(flow?.data?.reports?.quarters ?? []), ...quarters].map(q => [q.periodEnd, q])).values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  const trend = history.map((q, index) => {
    const expected = shiftQuarter(q.periodEnd, comparison === "yoy" ? -4 : -1);
    const previous = history.slice(0, index).reverse().find(item => Math.abs(Date.parse(item.periodEnd) - Date.parse(expected)) <= 10 * 86400000);
    const revenue = q.figures.revenue, older = previous?.figures.revenue;
    const value = revenue?.value == null ? null : Number(revenue.value) * q.scale;
    const base = older?.value == null ? null : Number(older.value) * (previous?.scale ?? 1);
    return { period: q.label || q.periodEnd, revenue: value, growth: value != null && base && q.currency === previous?.currency &&
      revenue?.comparabilityKey && revenue.comparabilityKey === older?.comparabilityKey && !q.basisChanges?.includes("revenue") ? (value / base - 1) * 100 : null };
  });
  const cashTrend = [...caps].reverse().map(q => ({ period: q.periodEnd, cash: q.cashFlow?.operating?.total == null ? null : Number(q.cashFlow.operating.total) }));
  const cashRows: LineItem[] = cash ? ([["经营活动现金流", cash.operating], ["投资活动现金流", cash.investing], ["融资活动现金流", cash.financing]] as const).flatMap(([label, group]) => [[label, group?.total], ...(group?.lines ?? []).map(row => [row.label, row.value] as LineItem)]) : [];
  const balanceRows: LineItem[] = balance ? [...balance.assets, ...balance.liabilities, ...balance.equity].map(row => [row.label, row.value]) : [];
  return <div className="flex min-w-0 flex-col gap-6">
    {!!periods.length && <div className="flex flex-wrap items-center gap-3"><NativeSelect aria-label="选择财季" value={active} onChange={e => setPeriod(e.target.value)}>{periods.map(date => <NativeSelectOption key={date} value={date}>{date}</NativeSelectOption>)}</NativeSelect><NativeSelect aria-label="增长比较基准" value={comparison} onChange={e => setComparison(e.target.value)}><NativeSelectOption value="qoq">环比</NativeSelectOption><NativeSelectOption value="yoy">同比</NativeSelectOption></NativeSelect></div>}
    {periods.length ? <Tabs defaultValue="income">
      <TabsList><TabsTrigger value="income">利润表</TabsTrigger><TabsTrigger value="cash">现金流</TabsTrigger><TabsTrigger value="balance">资产负债表</TabsTrigger></TabsList>
      <TabsContent value="income" className="flex flex-col gap-6">
        {trend.some(row => row.revenue != null) && <ChartContainer className="aspect-auto h-52 w-full" config={{ revenue: { label: "营收", color: "var(--primary)" } }}>
          <BarChart accessibilityLayer data={trend}><CartesianGrid vertical={false}/><XAxis dataKey="period" minTickGap={24}/><ChartTooltip content={<ChartTooltipContent/>}/><Bar dataKey="revenue" fill="var(--color-revenue)" isAnimationActive={false}/></BarChart>
        </ChartContainer>}
        {trend.some(row => row.growth != null) && <ChartContainer className="aspect-auto h-44 w-full" config={{ growth: { label: comparison === "yoy" ? "同比变化 (%)" : "环比变化 (%)", color: "var(--primary)" } }}>
          <LineChart accessibilityLayer data={trend}><CartesianGrid vertical={false}/><XAxis dataKey="period" minTickGap={24}/><YAxis width={48} tickFormatter={value => `${value}%`}/><ChartTooltip content={<ChartTooltipContent/>}/><Line dataKey="growth" stroke="var(--color-growth)" isAnimationActive={false}/></LineChart>
        </ChartContainer>}
        {financialTable("利润表", incomeRows, income?.currency, income?.scale)}
        {!!expenseRows.length && financialTable("经营费用", expenseRows, income?.currency, income?.scale)}
      </TabsContent>
      <TabsContent value="cash" className="flex flex-col gap-6">
        {cashTrend.some(row => row.cash != null) && <ChartContainer className="aspect-auto h-52 w-full" config={{ cash: { label: "经营现金流", color: "var(--primary)" } }}><BarChart accessibilityLayer data={cashTrend}><CartesianGrid vertical={false}/><XAxis dataKey="period" minTickGap={24}/><ChartTooltip content={<ChartTooltipContent/>}/><Bar dataKey="cash" fill="var(--color-cash)" isAnimationActive={false}/></BarChart></ChartContainer>}
        {cash && !current?.cashFlow && <p className={muted}>年初至今</p>}{financialTable("现金流", cashRows, cash?.currency)}
      </TabsContent>
      <TabsContent value="balance">{financialTable("资产负债表", balanceRows, balance?.currency)}</TabsContent>
    </Tabs> : status(flow?.failure ? flow : capital?.failure ? capital : flow && capital ? flow : undefined, "暂无财务报表")}
    <details className="min-w-0"><summary className="cursor-pointer py-2 font-medium">财务数据管理</summary>{children}</details>
  </div>;
}

const dimensions: Record<string, string> = { businessQuality: "业务质量", growthExecution: "增长兑现", valuationSafety: "估值安全", mispricingCatalysts: "错价催化", financialResilience: "财务韧性" };
function timeline<T extends { time: string }>(
  bars: T[], versions: ValuationResponse["versions"], report: NonNullable<ValuationResponse["report"]>, current: ValuationVersionRange | null,
): Array<T & { low: number | null; base: number | null; high: number | null }> {
  const sorted = [...bars].sort((a, b) => a.time.localeCompare(b.time));
  const last = sorted.at(-1)?.time ?? "";
  if (!last || !current) return sorted.map(bar => ({ ...bar, low: null, base: null, high: null }));
  const checkpoints = new Map<string, ValuationVersionRange & { timestamp: string }>();
  function insert(date: string, timestamp: string, range: ValuationVersionRange) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || ![range.low, range.base, range.high].every(Number.isFinite)) return;
    const effective = date > last ? last : date;
    if ((checkpoints.get(effective)?.timestamp ?? "") > timestamp) return;
    checkpoints.set(effective, { low: range.low, base: range.base, high: range.high, timestamp });
  }
  for (const v of versions) {
    if (v.reportStatus !== "ready" || !v.normalRange || v.generatedAt > report.generatedAt) continue;
    insert((v.researchAsOf || v.generatedAt).slice(0, 10), v.generatedAt, v.normalRange);
  }
  const active = versions.find(v => v.versionId === report.versionId);
  insert((active?.researchAsOf || report.researchAsOf || report.generatedAt).slice(0, 10), report.generatedAt, current);
  const ordered = [...checkpoints].sort(([a], [b]) => a.localeCompare(b));
  let i = -1;
  return sorted.map(bar => {
    while (i + 1 < ordered.length && ordered[i + 1][0] <= bar.time) i++;
    const matched = ordered[i]?.[1];
    return { ...bar, low: matched?.low ?? null, base: matched?.base ?? null, high: matched?.high ?? null };
  });
}
function percentage(value: number | undefined | null) {
  return value == null || !Number.isFinite(value) ? "—" : Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(value);
}
const scenarioNames: Record<string, string> = { bear: "悲观", base: "基准", bull: "乐观", lower: "正常下限", upper: "正常上限", management: "管理层" };
export function AppValuation({ ticker, children }: Scoped) {
  const result = usePublication<ValuationResponse>(ticker, "/valuation");
  const market = usePublication<{ livePrice?: number; liveDate?: string; bars: Array<{ time: string; close: number }> }>(ticker, "/market-daily", false);
  const val = result?.data, report = val?.report;
  const model = val && !val.outdated && (!val.researchStatus || val.researchStatus === "valid") &&
    val.priceImpact?.quantificationStatus !== "unavailable" && report?.reportStatus === "ready" ? report.model : null;
  const guide = val?.priceGuide?.reportVersionId === report?.versionId ? val?.priceGuide : undefined;
  const [scenario, setScenario] = useState("base");
  const [evidence, setEvidence] = useState<ValuationEvidence>();
  const modelRange = model?.fairValueRange;
  const range = modelRange?.status === "available" ? modelRange : null;
  const displayRange = range && (!guide || guide.status === "available" || ["no_quote", "unusable_quote", "stale_quote", "currency_mismatch"].includes(guide.reason ?? ""));
  const cases = model ? [
    ["bear", model.scenarios.bear], ["lower", range?.lower], ["base", model.scenarios.base],
    ["upper", range?.upper], ["bull", model.scenarios.bull], ["management", model.managementScenario],
  ] as const : [];
  const selected = cases.find(([key]) => key === scenario)?.[1];
  const quote = guide?.quote ?? report?.quote;
  const chartData = report && val ? timeline(market?.data?.bars ?? [], val.versions, report, displayRange ? range : null) : [];
  const cite = (ids: string[]) => ids.flatMap(id => {
    const source = report?.evidence.find(item => item.evidenceId === id);
    return source ? [<Button key={id} size="sm" variant="ghost" className="max-w-full justify-start" type="button" onClick={() => setEvidence(source)}><span className="truncate">{source.title}</span></Button>] : [];
  });
  return <div className="flex min-w-0 flex-col gap-6">
    {report ? <>
      <div className="flex flex-wrap items-end gap-4"><p className="text-3xl font-semibold tabular-nums">{money(market?.data?.livePrice ?? quote?.price, report.currency)}</p><time className={muted}>{market?.data?.liveDate ?? quote?.priceDate}</time></div>
      {(val.outdated || val.researchStatus === "review_required") && <p role="status" className={muted}>估值待复核，暂不显示量化区间</p>}
      <Tabs defaultValue="core">
        <TabsList className="h-auto max-w-full flex-wrap"><TabsTrigger value="core">核心估值</TabsTrigger><TabsTrigger value="scores">五维图</TabsTrigger><TabsTrigger value="scenarios">情景经营路径检视</TabsTrigger></TabsList>
        <TabsContent value="core" className="flex flex-col gap-4">
          {financialTable("12 个月合理价值区间", displayRange ? [["下限", range.low], ["基准", range.base], ["上限", range.high]] : model ? [["基准价值", model.range?.base]] : [], report.currency)}
          {model && chartData.length > 0 && <ChartContainer className="aspect-auto h-72 w-full" config={{ close: { label: "收盘", color: "var(--primary)" }, low: { label: "下限", color: "var(--muted-foreground)" }, base: { label: "基准", color: "var(--foreground)" }, high: { label: "上限", color: "var(--muted-foreground)" } }}>
            <LineChart accessibilityLayer data={chartData}><CartesianGrid vertical={false}/><XAxis dataKey="time" minTickGap={36}/><YAxis width={64} domain={["auto", "auto"]}/><ChartTooltip content={<ChartTooltipContent/>}/>
              <Line type="linear" dataKey="close" dot={false} stroke="var(--color-close)" strokeWidth={2} isAnimationActive={false}/>
              {displayRange && (["low", "base", "high"] as const).map(key => <Line key={key} type="stepAfter" dataKey={key} dot={false} stroke={`var(--color-${key})`} strokeDasharray="4 4" isAnimationActive={false}/>)}
            </LineChart>
          </ChartContainer>}
          {report.sections.summary && <p className="whitespace-pre-line text-base">{report.sections.summary}</p>}
          {!!model && !!val.versions.length && <Table><TableCaption className={caption}>历史估值</TableCaption><TableHeader><TableRow><TableHead>日期</TableHead><TableHead>下限</TableHead><TableHead>基准</TableHead><TableHead>上限</TableHead></TableRow></TableHeader><TableBody>
            {val.versions.map(v => <TableRow key={v.versionId}><TableCell>{dateText(v.researchAsOf)}</TableCell><TableCell>{money(v.normalRange?.low, report.currency)}</TableCell><TableCell>{money(v.normalRange?.base, report.currency)}</TableCell><TableCell>{money(v.normalRange?.high, report.currency)}</TableCell></TableRow>)}
          </TableBody></Table>}
        </TabsContent>
        <TabsContent value="scores" className="flex flex-col gap-4">
          {report.reportStatus === "ready" && report.weightedScore != null && Object.keys(dimensions).every(key => report.dimensions.some(d => d.key === key && d.score != null)) &&
            <div className="flex min-w-0 flex-col gap-4"><p className="text-lg font-semibold">{report.weightedScore} / 10 · {report.verdict}</p>
              <ChartContainer className="h-56 w-full max-w-md" config={{ score: { label: "评分", color: "var(--primary)" } }}>
                <RadarChart data={report.dimensions.map(d => ({ label: dimensions[d.key] ?? d.key, score: d.score }))}><PolarGrid/><PolarAngleAxis dataKey="label"/><PolarRadiusAxis domain={[0, 10]} tick={false}/><Radar dataKey="score" fill="var(--color-score)" fillOpacity={0.12} stroke="var(--color-score)" isAnimationActive={false}/><ChartTooltip content={<ChartTooltipContent/>}/></RadarChart>
              </ChartContainer>
            </div>}
          {report.dimensions.map(d => <section key={d.key} className="flex flex-col gap-2"><h3 className="font-semibold">{dimensions[d.key] ?? d.key} · {d.score ?? "—"}</h3><p>{d.rationale}</p>{d.gaps.map(line => <p key={line} className={muted}>{line}</p>)}{d.nextCheck && <p className={muted}>{d.nextCheck}</p>}</section>)}
        </TabsContent>
        <TabsContent value="scenarios" className="flex flex-col gap-4">
          {model && <NativeSelect aria-label="选择估值情景" value={scenario} onChange={e => setScenario(e.target.value)}>{cases.filter(([, entry]) => entry).map(([key]) => <NativeSelectOption key={key} value={key}>{scenarioNames[key]}</NativeSelectOption>)}</NativeSelect>}
          {!model && <p className={muted}>暂无可用经营情景</p>}
          {selected && <>
            <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div><dt className={muted}>加权价值</dt><dd className="text-base font-semibold">{money(selected.valuation?.perShare ?? selected.result.perShare, report.currency)}</dd></div>
              <div><dt className={muted}>现金流折现值</dt><dd className="text-base font-semibold">{money(selected.result.perShare, report.currency)}</dd></div>
              <div><dt className={muted}>终值占比</dt><dd className="text-base font-semibold">{percentage(selected.result.terminalShare)}</dd></div>
              {"probability" in selected && typeof selected.probability === "number" && <div><dt className={muted}>概率</dt><dd className="text-base font-semibold">{percentage(selected.probability)}</dd></div>}
            </dl>
            <p>{selected.narrative}</p>
            <div className="flex flex-wrap gap-2">{cite(selected.evidenceIds)}</div>
            {selected.assumptions && ([["营收路径", selected.assumptions.revenue], ["利润率路径", selected.assumptions.margin], ["资本开支路径", selected.assumptions.capex]] as const).map(([label, assumption]) => <section key={label} className="flex flex-col gap-2">
              <h3 className="text-base font-semibold">{label}</h3><p>{assumption.rationale}</p><div className="flex flex-wrap gap-2">{cite(assumption.evidenceIds)}</div>
            </section>)}
            {selected.triggers?.map(t => <p key={t}>{t}</p>)}{selected.invalidation?.map(t => <p key={t} className={muted}>{t}</p>)}
            {!!selected.result.yearly.length && <Table><TableCaption className={caption}>经营路径</TableCaption><TableHeader><TableRow><TableHead>年份</TableHead><TableHead>收入</TableHead><TableHead>自由现金流</TableHead><TableHead>资本开支</TableHead><TableHead>税后营业利润</TableHead></TableRow></TableHeader><TableBody>{selected.result.yearly.map(row => <TableRow key={row.year}><TableCell>{row.year}</TableCell><TableCell>{money(row.revenue, report.currency)}</TableCell><TableCell>{money(row.cashFlow, report.currency)}</TableCell><TableCell>{money(row.capex ?? row.buildCapex, report.currency)}</TableCell><TableCell>{money(row.nopat, report.currency)}</TableCell></TableRow>)}</TableBody></Table>}
          </>}
        </TabsContent>
      </Tabs>
    </> : status(result, val?.availability === "preparing" ? "估值准备中" : "暂无已发布估值")}
    <Dialog open={!!evidence} onOpenChange={open => { if (!open) setEvidence(undefined); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogTitle>{evidence?.title}</DialogTitle><p className={muted}>{evidence?.publishedAt}</p>
        <p className="whitespace-pre-wrap text-sm">{evidence?.excerpt}</p>
        {safeLink(evidence?.url) && <a className="underline" href={safeLink(evidence?.url)} target="_blank" rel="noreferrer">查看来源</a>}
      </DialogContent>
    </Dialog>
    {!!report?.evidence.length && <details><summary className="cursor-pointer py-2 font-medium">估值证据</summary>
      <ul className="flex flex-col gap-4 py-3">{report.evidence.map(e => <li key={e.evidenceId}>{safeLink(e.url) ? <a href={safeLink(e.url)} target="_blank" rel="noreferrer" className="underline">{e.title}</a> : e.title}<p className={muted}>{e.excerpt}</p></li>)}</ul>
    </details>}
    <details className="min-w-0"><summary className="cursor-pointer py-2 font-medium">估值管理</summary>{children}</details>
  </div>;
}
