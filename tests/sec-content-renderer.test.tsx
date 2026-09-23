import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportContentRenderer } from "../components/earning-report/report-blocks/ReportContentRenderer.tsx";
import { ReportMarkdown, ReportFormula, safeReportUrl } from "../components/earning-report/report-blocks/ReportMarkdown.tsx";
import { SecTrendFigure, SecTrendSource } from "../components/earning-report/report-blocks/SecTrendFigure.tsx";
import { readerFilingFixture } from "./fixtures/sec-reader-fixture.ts";
import type { SecReaderContentBlock } from "../shared/analysis-runtime/sec-reader-schema.ts";
import type { SecTrend } from "../shared/analysis-contract/sec-presentation.ts";

const trend = (values: number[]): SecTrend => ({ metricKey: "capex", unit: "USD", basis: "gaap", periodScope: "annual", points: values.map((value, index) => ({ date: `${2020 + index}-05-31`, value, accession: `source-${index}` })) });
const prose = (blockId: string, markdown: string): SecReaderContentBlock => ({ type: "markdown", blockId, markdown, evidenceIds: ["ev:demand"] });

test("standard prose supports nested lists, complete links and GFM tables without making dollar amounts math", () => {
  const html = renderToStaticMarkup(<ReportMarkdown markdown={'云业务**同比 +18%**增长。价格 $100，目标 $200。\n\n- 主因\n  - 次因\n\n| 指标 | 本期 |\n| --- | --- |\n| 收入 | 100 |\n\n[来源](https://example.com/a_(b))'} />);
  assert.match(html, /<strong>同比 \+18%<\/strong>/);
  assert.match(html, /价格 \$100，目标 \$200/);
  assert.doesNotMatch(html, /class="katex/);
  assert.equal((html.match(/<ul>/g) ?? []).length, 2);
  assert.match(html, /<table>/);
  assert.match(html, /href="https:\/\/example.com\/a_\(b\)"/);
});

test("model-composed financial tables keep numeric columns and long notes distinct", () => {
  const report = readerFilingFixture().analysis!;
  const block: SecReaderContentBlock = { type: "table", blockId: "financial-history", evidenceIds: ["ev:demand"],
    caption: "FY2024–FY2026，十亿美元；订阅数据为公司披露口径。", density: "compact",
    headers: ["财年", "收入", "关键订阅指标"], columnKinds: ["label", "number", "text"],
    rows: [["FY2026", "$7.206", "经常性收入占比约 97%；其余指标另见披露。"]] };
  const html = renderToStaticMarkup(<ReportContentRenderer content={[block]} context={{ report }} />);
  assert.match(html, /data-density="compact"/);
  assert.match(html, /<th scope="row" data-column-kind="label">FY2026<\/th>/);
  assert.match(html, /<td data-column-kind="number">\$7\.206<\/td>/);
  assert.match(html, /<td data-column-kind="text">经常性收入占比/);
  assert.match(html, /aria-label="FY2024–FY2026，十亿美元；订阅数据为公司披露口径。"/);
});

test("untrusted HTML, image URLs and unsafe links cannot create executable or fetching elements", () => {
  const html = renderToStaticMarkup(<ReportMarkdown markdown={'<script>alert(1)</script>\n\n![示意](https://outside.test/image.png)\n\n[危险](javascript:alert(1))'} />);
  assert.doesNotMatch(html, /<script|<img|javascript:/);
  assert.match(html, /图片：示意/);
  for (const value of ["javascript:alert(1)", "//evil.test", "/\\evil.test", "https://user:pass@example.com", "data:image/svg+xml,x"]) assert.equal(safeReportUrl(value), undefined);
  assert.equal(safeReportUrl("/analysis/ORCL"), "/analysis/ORCL");
});

test("formulas preserve accessible math and degrade locally on invalid TeX", () => {
  const good = renderToStaticMarkup(<ReportFormula latex="FCF = CFO - CapEx" displayMode explanation="自由现金流" />);
  assert.match(good, /<math/);
  assert.match(good, /自由现金流/);
  const bad = renderToStaticMarkup(<ReportFormula latex={"\\unknowncommand{x}"} displayMode explanation="原有解释保留" />);
  assert.match(bad, /公式暂无法排版/);
  assert.match(bad, /unknowncommand/);
  assert.match(bad, /原有解释保留/);
});

test("zero, one and two observations choose truthful compact representations and preserve exact provenance", () => {
  assert.match(renderToStaticMarkup(<SecTrendFigure id="empty" title="资本开支" trend={trend([])} />), /暂无可绘制/);
  const single = renderToStaticMarkup(<SecTrendFigure id="one" title="资本开支" trend={trend([0])} />);
  assert.match(single, /data-chart-kind="single"/); assert.doesNotMatch(single, /<svg/);
  const data = trend([8502000000, 28499000000]);
  const two = renderToStaticMarkup(<><SecTrendFigure id="two" title="资本开支" trend={data} mark="bar" /><SecTrendSource title="资本开支" trend={data} /></>);
  assert.match(two, /data-chart-kind="comparison"/); assert.doesNotMatch(two, /<polyline/);
  assert.match(two, /85\.02 亿/); assert.match(two, /284\.99 亿/);
  assert.match(two, /data-chart-value="8502000000">8,502,000,000/);
  assert.match(two, /2020-05-31/); assert.match(two, /source-1/);
});

test("negative and zero comparisons share one scale without fabricating a positive bar", () => {
  const html = renderToStaticMarkup(<SecTrendFigure id="negative" title="现金流" trend={trend([-30, 0])} />);
  assert.match(html, /x1="100"/);
  assert.match(html, /width="0" height="14"/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test("four and twelve point charts render as bounded timelines, and damaged points fail locally", () => {
  for (const count of [4, 12]) {
    const html = renderToStaticMarkup(<SecTrendFigure id={`many-${count}`} title="收入" trend={trend(Array.from({ length: count }, (_, i) => i - 2))} />);
    assert.match(html, /data-chart-kind="timeline"/); assert.match(html, /<polyline/); assert.doesNotMatch(html, /NaN|Infinity/);
  }
  const damaged = { ...trend([1, 2]), points: undefined } as unknown as SecTrend;
  assert.match(renderToStaticMarkup(<SecTrendFigure id="broken" title="收入" trend={damaged} />), /暂无可绘制/);
});

test("content groups keep reading order, place source details after prose and freeze draft layout", () => {
  const report = readerFilingFixture().analysis!; report.trends = [trend([10, 20])];
  const content: SecReaderContentBlock[] = [
    { ...prose("intro", "先说明资本投入。"), groupId: "capital" },
    { type: "chart", blockId: "capital-chart", groupId: "capital", layout: "wrap", metricKey: "capex", mark: "bar", title: "资本开支", caption: "规模比较不能证明回报。", evidenceIds: ["ev:demand"] },
    { ...prose("explanation", "继续解释现金回收与产能关系。"), groupId: "capital" },
  ];
  const html = renderToStaticMarkup(<ReportContentRenderer content={content} context={{ report }} />);
  assert.match(html, /data-media-layout="wrap"/);
  assert.ok(html.indexOf("先说明资本投入") < html.indexOf("capital-chart"));
  assert.ok(html.indexOf("capital-chart") < html.indexOf("继续解释现金回收"));
  assert.ok(html.indexOf("继续解释现金回收") < html.indexOf("查看数据与来源"));
  const draft = renderToStaticMarkup(<ReportContentRenderer content={content} context={{ report }} phase="draft" />);
  assert.match(draft, /data-media-layout="aside"/);
});

test("malformed blocks and missing image assets keep their siblings and captions readable", () => {
  const report = readerFilingFixture().analysis!;
  const blocks = [prose("before", "之前正文"), { type: "new-unknown", blockId: "bad" }, { type: "image", blockId: "missing", assetId: "asset-none", alt: "增长示意", caption: "原有图注", evidenceIds: [] }, prose("after", "之后正文")] as SecReaderContentBlock[];
  const html = renderToStaticMarkup(<ReportContentRenderer content={blocks} context={{ report }} />);
  assert.match(html, /之前正文/); assert.match(html, /之后正文/); assert.match(html, /此内容块暂无法显示/);
  assert.match(html, /图片暂不可用：增长示意/); assert.match(html, /原有图注/); assert.doesNotMatch(html, /<img/);
});

test("only persisted image metadata resolves an image with reserved dimensions", () => {
  const report = readerFilingFixture().analysis!;
  const image: SecReaderContentBlock = { type: "image", blockId: "image-ready", assetId: "asset-ready", alt: "业务流程", caption: "已保存的插图", evidenceIds: [] };
  const html = renderToStaticMarkup(<ReportContentRenderer content={[image]} context={{ report, assets: [{ assetId: "asset-ready", src: "/assets/ready.webp", width: 640, height: 480, mimeType: "image/webp", source: { kind: "generated", label: "报告插图" } }] }} />);
  assert.match(html, /<img[^>]*width="640" height="480"/);
  assert.match(html, /aspect-ratio:640 \/ 480/); assert.match(html, /生成插图/);
});

test("content IDs cannot collide with section navigation or another rendering of the same report", () => {
  const report = readerFilingFixture().analysis!;
  const content = [prose("sec-reader-1", "同一报告可重复展示")];
  const html = renderToStaticMarkup(<><section id="sec-reader-1" /><ReportContentRenderer content={content} context={{ report }} /><ReportContentRenderer content={content} context={{ report }} /></>);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  assert.equal((html.match(/data-block-id="sec-reader-1"/g) ?? []).length, 2);
});
