import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarProvider } from "../components/ui/sidebar";
import { ChartContainer, ChartTooltipContent } from "../components/ui/chart";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "../components/ui/native-select";
import { Rail, RailActions } from "../apps/business-site/src/Sidebar";
import { Home } from "../apps/business-site/src/Home";

// These composition paths must keep the existing DOM skin, rather than introduce
// wrappers, default labels or platform-menu replacements into the business map.
test("the composed sidebar retains its semantic shell, scroll target and Chinese action labels", () => {
  const html = renderToStaticMarkup(
    <SidebarProvider asChild open={false} keyboardShortcut={null} persistState={false}>
      <main data-rail="collapsed">
        <Rail ticker="ORCL" label="公司业务" actions={<RailActions light={false} collapsed onSearch={() => {}} onToggleTheme={() => {}} />}>
          <div className="rail-list">全部业务</div>
        </Rail>
      </main>
    </SidebarProvider>,
  );
  assert.match(html, /<main[^>]*data-rail="collapsed"/);
  assert.match(html, /<aside[^>]*class="rail"[^>]*aria-label="公司业务"/);
  assert.match(html, /id="rail-body"/);
  assert.match(html, /aria-controls="rail-body"/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 3);
  assert.equal((html.match(/<svg\b/g) ?? []).length, 4);
  assert.match(html, /<a href="\/" data-nav="true" class="icon-button" aria-label="首页"/);
  for (const name of ["首页", "搜索公司", "切换浅色主题", "展开侧边栏"]) assert.ok(html.includes(`aria-label="${name}"`));
  assert.ok(!html.includes("Toggle Sidebar"));
  assert.ok(!html.includes('data-slot="sidebar-gap"'));
  assert.ok(!html.includes('data-slot="sheet"'));
});

test("native quarterly selection keeps the selected report, group and disabled unavailable periods", () => {
  const html = renderToStaticMarkup(
    <label className="report-select"><span>财报季度</span>
      <NativeSelect appearance="native" value="current" onChange={() => {}}>
        <NativeSelectOptGroup label="近两年 · 季度报告">
          <NativeSelectOption value="current">2026.08</NativeSelectOption>
          <NativeSelectOption value="previous">2026.05</NativeSelectOption>
          <NativeSelectOption value="missing" disabled>2026.02 · 完整报告暂不可用</NativeSelectOption>
        </NativeSelectOptGroup>
      </NativeSelect>
    </label>,
  );
  assert.match(html, /<option[^>]*value="current"[^>]*selected=""/);
  assert.match(html, /<option[^>]*value="missing"[^>]*disabled=""/);
  assert.match(html, /<optgroup[^>]*label="近两年 · 季度报告"/);
  assert.ok(html.includes("完整报告暂不可用"));
  assert.equal((html.match(/<select\b/g) ?? []).length, 1);
  assert.ok(!html.includes("native-select-wrapper"));
  assert.ok(!html.includes("native-select-icon"));
});

test("custom chart composition preserves rich disclosed tooltip content without responsive wrappers", () => {
  const html = renderToStaticMarkup(
    <ChartContainer asChild config={{ cloud: { label: "云服务", color: "var(--biz-1)" } }}>
      <section className="trend" aria-label="全部业务 近 8 季收入">
        <div className="trend-plot"><div className="trend-col">
          <ChartTooltipContent asChild>
            <div className="trend-tip" role="presentation">
              <div className="trend-tip-title">2026-06-01 — 2026-08-31</div>
              <div className="trend-tip-row"><span>云服务</span><b>$11.6B</b></div>
              <p className="trend-tip-source">SEC 10-Q · 2026-09-11</p>
            </div>
          </ChartTooltipContent>
        </div></div>
      </section>
    </ChartContainer>,
  );
  assert.match(html, /^<section[^>]*class="trend"/);
  for (const content of ["2026-06-01 — 2026-08-31", "云服务", "$11.6B", "SEC 10-Q · 2026-09-11"]) assert.ok(html.includes(content));
  assert.equal((html.match(/class="trend-tip"/g) ?? []).length, 1);
  assert.ok(!html.includes("recharts-responsive-container"));
  assert.ok(!html.includes("aspect-video"));
});

test("home leads with the inline ticker search and keeps its list closed until the user types", () => {
  const html = renderToStaticMarkup(<Home light onToggleTheme={() => {}} recent={["NVDA"]} onPick={() => {}} />);
  assert.match(html, /<main class="home"/);
  assert.match(html, /class="search-panel" data-inline="true"/);
  assert.match(html, /role="combobox"[^>]*aria-expanded="false"/);
  assert.match(html, /<div class="search-drop" hidden="">/);
  assert.match(html, /<a href="\/companies\/NVDA" data-nav="true">/);
  assert.match(html, /<section class="home-findings"[^>]*aria-busy="true"/);
});

test("the rail, lenses and time axis render reports and filed events with their class, verdict and EDGAR links", async () => {
  const { EventsList } = await import("../apps/business-site/src/EventsList");
  const { EventLens } = await import("../apps/business-site/src/EventLens");
  const { ReportLens } = await import("../apps/business-site/src/ReportLens");
  const { Timeline } = await import("../apps/business-site/src/Timeline");
  const { railItems, timelineFromFilings } = await import("../apps/business-site/src/reports-model");
  const insider = (id: string, date: string, shares: number, heldAfter: number, planned: boolean | null) => ({
    id, ticker: "ORCL", form: "4" as const, filedAt: date, eventDate: date, items: [], class: "insider" as const, description: "", edgarUrl: `https://www.sec.gov/i/${id}`, documentUrl: `https://www.sec.gov/i/${id}/f.xml`, exhibits: [], summary: null,
    insider: { ownerCik: "7", ownerName: "Doe Jane", title: "Chief Financial Officer", isDirector: false, isOfficer: true, isTenPercentOwner: false, rule10b51: planned, planAdoptedOn: null, securityTitle: "Common Stock", lines: [], sold: { shares, proceeds: shares * 150, averagePrice: 150 }, bought: null, exercised: 0, heldAfter, footnotes: ["Rule 10b5-1 plan."] },
  });
  const publication = { schemaVersion: "events.v1" as const, ticker: "ORCL", checkedAt: "2026-10-09T00:00:00.000Z", pendingInsider: 2, events: [
    insider("f3", "2026-09-17", 20_000, 200_000, true), insider("f2", "2026-06-17", 20_000, 220_000, true), insider("f1", "2026-03-17", 20_000, 240_000, true),
    { id: "0001193125-26-000001", ticker: "ORCL", form: "8-K" as const, filedAt: "2026-09-10", eventDate: "2026-09-09", items: ["2.02", "9.01"], class: "earnings" as const, description: "8-K", edgarUrl: "https://www.sec.gov/i/k1", documentUrl: "https://www.sec.gov/i/k1/8k.htm", exhibits: [{ type: "EX-99.1", title: "PRESS RELEASE", url: "https://www.sec.gov/i/k1/ex.htm" }], insider: null,
      summary: { headline: "Q1 云收入加速", bullets: [{ label: "云", detail: "+30%", importance: "high" as const }], analystView: "看 RPO", eventCategory: "earnings_update" as const, generatedAt: "2026-09-10T00:00:00.000Z" } },
    { id: "0001193125-26-000002", ticker: "ORCL", form: "8-K" as const, filedAt: "2026-09-18", eventDate: "2026-09-16", items: ["5.02"], class: "executive" as const, description: "8-K", edgarUrl: "https://www.sec.gov/i/k2", documentUrl: "https://www.sec.gov/i/k2/8k.htm", exhibits: [], insider: null, summary: null },
  ] };
  const report = {
    accessionNumber: "0001193125-26-000003", form: "10-Q", filingDate: "2026-09-11", reportDate: "2026-08-31", periodEnd: "2026-08-31", periodLabel: "FY2027 Q1", date: "2026-09-09",
    sources: [{ form: "8-K", filingDate: "2026-09-10", accessionNumber: "0001193125-26-000001", indexUrl: "https://www.sec.gov/i/k1" }, { form: "10-Q", filingDate: "2026-09-11", accessionNumber: "0001193125-26-000003", indexUrl: "https://www.sec.gov/i/q1" }],
    headline: "云基础设施拉动收入增长 12%", bullets: [{ label: "收入", detail: "149 亿美元，同比 +12%", importance: "high" as const }], analystView: "看 RPO 转化", report: "补充分析正文",
    warnings: [], generatedAt: "2026-09-12T00:00:00.000Z",
    keyMetrics: [{ key: "revenue", label: "营收", value: "149.26 亿美元", yoy: "+12.0%", qoq: "-3.1%", status: "verified" as const }, { key: "net_income", label: "净利润", value: "29.27 亿美元", yoy: "+0.1%", qoq: null, status: "verified" as const }],
    changes: [{ compare: "同比" as const, topic: "cloud", statement: "云收入增速从 22% 提高到 28%" }], risks: ["资本开支超过经营现金流"], guidance: ["FY2027 云收入增长 40%"],
    verification: "verified" as const, analysisStatus: "complete" as const, hasReport: true, snapshot: { accession: "0001193125-26-000003", reportDate: "2026-08-31", reportVersion: "sec-analysis.v2:abc" }, edgarUrl: "https://www.sec.gov/i/q1", documentUrl: "https://www.sec.gov/i/q1/10q.htm",
  };
  const filings = { schemaVersion: "filing-digests.v1" as const, ticker: "ORCL", filings: [report], total: 1, checkedAt: null };
  const rail = railItems(filings, publication, new Date("2026-10-09T00:00:00Z"))!;
  assert.deepEqual(rail.recent.map(i => i.id), ["0001193125-26-000002", "f3", "0001193125-26-000003"], "the period opens at the report; the merged 8-K is listed once, as the report");
  assert.deepEqual(rail.earlier.map(i => i.id), ["f2", "f1"]);
  const list = renderToStaticMarkup(<EventsList rail={rail} focus="f3" pendingInsider={2} onFocus={() => {}} />);
  assert.match(list, /aria-label="财报与事件"/);
  assert.ok(list.includes("Doe Jane 卖出 2.0 万股"));
  assert.ok(list.includes("云基础设施拉动收入增长 12%") && list.includes("FY2027 Q1") && list.includes("8-K + 10-Q"));
  assert.ok(list.includes("内部人交易") && list.includes("高管变动") && list.includes("10b5-1"));
  assert.ok(list.includes("2 份 Form 4 待读取"));
  const lens = renderToStaticMarkup(<EventLens event={publication.events[0]} publication={publication} index={1} count={5} onClose={() => {}} onStep={() => {}} />);
  assert.ok(lens.includes("按计划"), "three planned quarterly sales read as scheduled");
  assert.ok(lens.includes("申报标注为 10b5-1 计划交易"));
  assert.ok(lens.includes("9.1%"), "20k of 220k pre-trade holding");
  assert.match(lens, /class="ladder-path"/);
  assert.equal((lens.match(/class="ladder-dot"[^>]*data-planned/g) ?? []).length, 3);
  assert.ok(lens.includes('href="https://www.sec.gov/i/f3"'));
  const current = renderToStaticMarkup(<EventLens event={publication.events[4]} publication={publication} index={0} count={5} onClose={() => {}} onStep={() => {}} />);
  assert.ok(current.includes("董事高管变动") && current.includes("该申报尚无摘要") && current.includes('href="https://www.sec.gov/i/k2"'));
  const reportLens = renderToStaticMarkup(<ReportLens report={report} ticker="ORCL" index={2} count={5} onStep={() => {}} onClose={() => {}} onOpenReport={() => {}} />);
  for (const text of ["149.26 亿美元", "同比 +12.0%", "环比 -3.1%", "投资含义", "补充分析", "FY2027 云收入增长 40%", "资本开支超过经营现金流", "阅读完整报告", "数字已核验", "8-K · 2026-09-10", "EDGAR 申报索引"]) assert.ok(reportLens.includes(text), text);
  assert.match(reportLens, /data-trend="up"[^>]*>同比 \+12\.0%/);
  const axis = renderToStaticMarkup(<Timeline points={timelineFromFilings(filings, publication, 24, new Date("2026-10-09T00:00:00Z"))} now={Date.parse("2026-10-09T00:00:00Z")} currentPeriod="2026-08-31" focus="f3" onReport={() => {}} onEvent={() => {}} />);
  assert.equal((axis.match(/class="timeline-point"/g) ?? []).length, 5, "one report, the merged 8-K folded into it, four other filings");
  assert.match(axis, /data-kind="report"[^>]*aria-pressed="true"/);
  assert.match(axis, /data-class="insider"[^>]*aria-pressed="true"/);
});
