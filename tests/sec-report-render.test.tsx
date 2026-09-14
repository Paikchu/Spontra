import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SecReportDocument } from "../app/analysis/stocks/[ticker]/sec/[accession]/SecReportDocument";
import { SecReportNavigator } from "../app/analysis/stocks/[ticker]/sec/[accession]/SecReportNavigator";
import type { SecFilingWithSummary } from "../shared/analysis-contract/report";
import { readerFilingFixture } from "./fixtures/sec-reader-fixture.ts";

test("renders the complete report and dynamic evidence using the shared renderer", () => {
  const filing: SecFilingWithSummary = {
    ticker: "MSFT", cik: "0000789019", cikNumber: 789019, companyName: "Microsoft Corp", form: "10-K",
    filingDate: "2026-07-30", reportDate: "2026-06-30", accessionNumber: "0000789019-26-000001",
    primaryDocument: "msft.htm", description: "Annual report", items: "", documentUrl: "https://sec.test/msft.htm", indexUrl: "https://sec.test/index.htm",
    summary: {
      ticker: "MSFT", form: "10-K", filingDate: "2026-07-30", accessionNumber: "0000789019-26-000001",
      headline: "云业务增长与资本投入同步加速",
      bullets: [
        { label: "收入", detail: "云业务继续推动收入增长。", importance: "high" },
        { label: "利润率", detail: "经营杠杆抵消部分投入压力。", importance: "medium" },
        { label: "现金流", detail: "资本开支仍是现金流关键变量。", importance: "medium" },
      ],
      analystView: "增长质量取决于投入转化效率。", report: "完整正文段落。", version: 5, source: "deepseek", generatedAt: "2026-08-10T00:00:00.000Z",
      nodes: [
        { id: "business-strategy", title: "业务与战略概览", status: "complete", findings: [], narrative: "梳理业务结构、竞争定位与战略投入。", evidence: [] },
        { id: "cloud-growth", title: "云业务增长", status: "complete", findings: [], narrative: "需求推动收入扩张。", evidence: [{ start: 10, end: 40, score: 90, reasons: ["包含定量数据"], excerpt: "Revenue increased 18%." }] },
      ],
    },
    analysis: {
      ticker: "MSFT", periodId: "MSFT:2026-06-30:annual", reportVersion: "sec-analysis.v2:test", headline: "云业务增长与资本投入同步加速",
      keyMetrics: [{ metricKey: "revenue", currentValue: "$120m", yoy: "+18.0%", status: "verified", evidenceIds: [] }],
      changes: { qoq: [], yoy: [], guidance: [], risks: [] }, dataQuality: { coverage: 1, verificationStatus: "verified", warnings: [] },
    },
  };

  const html = renderToStaticMarkup(<SecReportDocument companyName="Microsoft Corp" filing={filing} />);

  assert.match(html, /核心结论/);
  assert.match(html, /关键数据/);
  assert.match(html, /报告概览/);
  assert.match(html, /专题解读/);
  assert.doesNotMatch(html, /动态分段分析|相关性|主编覆盖度/);
  assert.match(html, /数据质量/);
  assert.match(html, /Revenue increased 18%/);
  assert.match(html, /<details/);
  assert.match(html, /aria-label="报告目录"/);
  assert.match(html, /href="#sec-report-conclusions"/);
  assert.match(html, /href="#sec-report-node-1"/);
  assert.match(html, /data-report-title="业务与战略概览"/);
  assert.match(html, /data-report-depth="1"/);
  assert.match(html, /梳理业务结构、竞争定位与战略投入。/);
  assert.match(html, /data-report-title="核心结论"/);
  assert.match(html, /data-report-description="先看经营结果、主要驱动和对投资判断的直接含义。"/);
  assert.equal((html.match(/data-report-section="true"/g) ?? []).length, 5);
  assert.deepEqual([...html.matchAll(/data-report-index="(\d{2})"/g)].map((match) => match[1]), ["01", "02", "03", "04", "05"]);
  assert.match(html, /data-report-toc="right"/);
  assert.match(html, /aria-label="本页目录"/);
  assert.doesNotMatch(html, /data-report-bar-state/);
  assert.match(html, /class="fixed right-/);
  assert.equal((html.match(/data-report-nav-depth="section"/g) ?? []).length, 5);
  assert.equal((html.match(/data-report-nav-depth="subsection"/g) ?? []).length, 2);
  filing.analysis!.presentation = {
    version: "sec-presentation.v1", density: "compact", sections: [{
      id: "sec-composed-1", title: "增长引擎与投入回报", layout: "grid", blocks: [
        { id: "business-text", type: "prose", text: "需求扩张推动云业务增长。" },
        { id: "revenue-trend", type: "sec_chart", title: "收入趋势", mark: "bar", trend: { metricKey: "revenue", unit: "USD", basis: "gaap", periodScope: "annual", points: [{ date: "2025-06-30", value: 100, accession: "old" }, { date: "2026-06-30", value: 120, accession: "current" }] } },
      ],
    }],
  };
  filing.analysis!.sourceMaterials = [{ type: "EX-99.2", filename: "deck.pdf", url: "https://www.sec.gov/deck.pdf", status: "unsupported" }];
  const composed = renderToStaticMarkup(<SecReportDocument companyName="Microsoft Corp" filing={filing} />);
  assert.match(composed, /href="#sec-composed-1"/);
  assert.match(composed, /增长引擎与投入回报/);
  assert.match(composed, /data-layout="grid"/);
  assert.match(composed, /role="img"/);
  assert.match(composed, /查看数据与来源/);
  assert.match(composed, /数据质量/);
  assert.match(composed, /核对原文与分析依据/);
  assert.match(composed, /未解析/);
  assert.doesNotMatch(composed, /data-report-title="完整正文"/);

});

test("cached report navigators keep distinct accessible menu targets", () => {
  const sections = [{ id: "sec-report-quality", title: "数据质量", description: "来源与校验" }];
  const html = renderToStaticMarkup(<><SecReportNavigator initialSections={sections} /><SecReportNavigator initialSections={sections} /></>);
  const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(controls.length, 2);
  assert.equal(new Set(controls).size, 2);
});

test("reader report preserves cash definitions and collapsed details without the boundary banner", () => {
  const html = renderToStaticMarkup(<SecReportDocument companyName="示例公司" filing={readerFilingFixture()} />);
  assert.match(html, /−|\-3\.00 亿美元/);
  assert.match(html, /2\.00 亿美元/);
  assert.match(html, /不是|不能视为明年新增折旧/);
  assert.match(html, /本期与以前/);
  assert.match(html, /以前/);
  assert.match(html, /什么会改变这个判断/);
  assert.match(html, /120\.00 美元/);
  assert.doesNotMatch(html, /这份报告仍有判断边界|查看范围与缺口/);
  assert.ok(html.indexOf("同一笔现金") < html.indexOf('id="sec-reader-1"'));
  assert.doesNotMatch(html, /动态分段分析|主编覆盖度|相关性|data-report-title="完整正文"/);
  assert.match(html, /<details class="sec-reader-workpapers"><summary>/);
  assert.match(html, /<details><summary>核对数据覆盖与处理记录/);
  assert.doesNotMatch(html, /href="#sec-report-node-1"/);
});

test('chart displays ratios as percentages and preserves gaps between observation dates', async () => {
  const { SecComposedSection } = await import('../components/earning-report/report-blocks/SecComposedSection');
  const report = { keyMetrics: [] } as unknown as import('../shared/analysis-contract/report').PublishedSecReport;
  const html = renderToStaticMarkup(<SecComposedSection report={report} section={{ id: 'chart', title: '毛利率', layout: 'flow', blocks: [{ id: 'margin', type: 'sec_chart', title: '毛利率', mark: 'line', trend: { metricKey: 'gross_margin', unit: 'ratio', basis: 'gaap', periodScope: 'quarter', points: [{ date: '2025-01-01', value: 0.25, accession: 'a' }, { date: '2025-04-01', value: 0.5, accession: 'b' }, { date: '2026-01-01', value: 0.6, accession: 'c' }] } }] }} />);
  assert.match(html, />25%<\/text>/);
  assert.match(html, /data-chart-value="0.25">25%/);
  const points = html.match(/<polyline points="([^"]+)"/)?.[1].split(' ').map((point) => Number(point.split(',')[0]));
  assert.ok(points);
  assert.equal(points[0], 45);
  assert.ok(points[1] > 160 && points[1] < 170, 'a three-month gap must occupy less space than the following nine-month gap');
  assert.equal(points[2], 535);
});

test("earnings report preserves dates and article without the materials and version panels", () => {
  const source = {
    ticker: "ORCL", cik: "0001341439", cikNumber: 1341439, companyName: "Oracle", form: "10-Q", filingDate: "2026-09-11", reportDate: "2026-08-31", accessionNumber: "quarterly",
    primaryDocument: "orcl.htm", description: "Quarterly report", items: "", documentUrl: "https://sec.test/q", indexUrl: "https://sec.test/q-index",
  };
  const filing: SecFilingWithSummary = { ...source, summary: {ticker:"ORCL",form:"8-K",filingDate:"2026-09-10",accessionNumber:"release",headline:"业绩初报",bullets:[],analystView:"",report:"已有初报正文",source:"deepseek",generatedAt:"2026-09-10T22:00:00Z"},
    earningsGroup: {id:"ORCL:2026-08-31",periodEnd:"2026-08-31",earningsDate:"2026-09-10",canonicalAccession:"quarterly",inputKey:"quarterly+release",
      sources:[source,{...source,form:"8-K",filingDate:"2026-09-10",accessionNumber:"release",indexUrl:"https://sec.test/release-index"}]},
  };
  const html=renderToStaticMarkup(<SecReportDocument companyName="Oracle" filing={filing}/>);
  assert.match(html,/财报期合并报告/);
  assert.match(html,/业绩发布日/);
  assert.doesNotMatch(html,/本期材料|新增材料待合并分析|报告链接与版本|本报告固定链接/);
  assert.match(html,/已有初报正文/);
  assert.doesNotMatch(html,/href="https:\/\/sec.test\/release-index"/);
  assert.match(html,/href="https:\/\/sec.test\/q-index"/);
});
