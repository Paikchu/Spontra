import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SecReportDocument } from "../app/analysis/stocks/[ticker]/sec/[accession]/SecReportDocument";
import { readerFilingFixture } from "./fixtures/sec-reader-fixture.ts";

test("reader visual plan reaches HTML with a bar chart, caption, comparison labels and trusted values", () => {
  const filing = readerFilingFixture();
  const report = filing.analysis!;
  report.trends = [{ metricKey: "revenue", unit: "USD", basis: "gaap", periodScope: "quarter", points: [{ date: "2026-03-31", value: 100, accession: "prior" }, { date: "2026-06-30", value: 120, accession: "current" }] }];
  report.reader!.sections[0].visual = { layout: "chart_focus", rationale: "规模对比", chart: { metricKey: "revenue", mark: "bar", title: "收入规模变化", caption: "不能单独证明回款改善。" } };
  const html = renderToStaticMarkup(<SecReportDocument companyName="示例" filing={filing} />);
  assert.match(html, /data-layout="chart_focus"/);
  assert.match(html, /data-layout="spotlight"/);
  assert.match(html, /data-layout="comparison"/);
  assert.match(html, /<rect /);
  assert.match(html, /data-chart-value="120"/);
  assert.match(html, /不能单独证明回款改善/);
  assert.match(html, /客户回款/);
  assert.doesNotMatch(html, /规模对比/); // Internal rationale is not article copy.
  for (const section of report.reader!.sections) delete section.visual;
  report.reader!.sections[0].chartMetricKey = "revenue";
  const legacy = renderToStaticMarkup(<SecReportDocument companyName="示例" filing={filing} />);
  assert.match(legacy, /data-chart-kind="comparison"/);
  assert.doesNotMatch(legacy, /<polyline /); // Two observations do not imply an intervening trend.
  assert.match(legacy, /data-layout="essay"/);
});
