import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FinancialMaintenanceMetric, FinancialMaintenancePeriod } from "../shared/analysis-contract/financial-maintenance.ts";

// Bundle the actual component while ignoring its stylesheet for server rendering.
const component = build({
  entryPoints: [fileURLToPath(new URL("../apps/admin/src/financial-quarter-summary.tsx", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
  loader: { ".css": "empty" }, external: ["react", "react/jsx-runtime", "lucide-react"],
}).then(bundle => {
  const componentModule = { exports: {} as { FinancialQuarterSummary: ComponentType<{ periods: FinancialMaintenancePeriod[] }> } };
  new Function("module", "exports", "require", bundle.outputFiles[0]!.text)(componentModule, componentModule.exports, createRequire(import.meta.url));
  return componentModule.exports.FinancialQuarterSummary;
});

const metric = (value: string | null, options: Partial<FinancialMaintenanceMetric> = {}): FinancialMaintenanceMetric => ({
  id: "revenue", label: "收入", value, unit: "USD", scale: 1, basis: "reported", ...options,
});
const period = (periodEnd: string, metrics: FinancialMaintenanceMetric[]): FinancialMaintenancePeriod => ({
  periodEnd, metrics, issues: [], status: metrics.length ? "partial" : "missing",
});
async function render(periods: FinancialMaintenancePeriod[]) {
  return renderToStaticMarkup(createElement(await component, { periods }));
}

test("quarter summary defaults to the latest populated period, including zero, and next populated comparison", async () => {
  const html = await render([
    period("2026-05-31", [metric("1000000")]),
    period("2026-11-30", []),
    period("2026-08-31", [metric("0")]),
  ]);
  const current = html.match(/<select aria-label="季度摘要查看季度">(.*?)<\/select>/)![1]!;
  const comparison = html.match(/<select aria-label="季度摘要对比季度">(.*?)<\/select>/)![1]!;
  assert.match(current, /value="2026-08-31" selected=""/);
  assert.doesNotMatch(current, /value="2026-11-30" selected=""/);
  assert.match(comparison, /value="2026-05-31" selected=""/);
});

test("million display preserves decimal amounts larger than Number.MAX_SAFE_INTEGER and negative fractions", async () => {
  const html = await render([period("2026-08-31", [
    metric("9007199254740993.123456"),
    metric("-1500000.25", { id: "net", label: "净利润" }),
  ])]);
  assert.match(html, />9,007,199,254\.740993123456<\/span>/);
  assert.match(html, /aria-label="9,007,199,254,740,993\.123456 美元"/);
  assert.match(html, />\(1\.50000025\)<\/span>/);
  assert.match(html, /aria-label="-1,500,000\.25 美元"/);
});

test("quarter comparison normalizes base and million scales exactly once", async () => {
  const html = await render([
    period("2026-08-31", [metric("12.5", { scale: 1_000_000 })]),
    period("2026-05-31", [metric("12500000")]),
  ]);
  assert.match(html, /单位：百万美元/);
  assert.equal(html.match(/<span>12\.5<\/span>/g)?.length, 2);
  assert.equal(html.match(/aria-label="12,500,000 美元"/g)?.length, 2);
});

test("mixed currencies retain each disclosed value and scale with explicit units", async () => {
  const html = await render([
    period("2026-08-31", [metric("12.5", { scale: 1_000_000 })]),
    period("2026-05-31", [metric("12500000", { unit: "EUR" })]),
  ]);
  assert.doesNotMatch(html, /aria-label="季度摘要金额单位"/);
  assert.match(html, /<span>12\.5<\/span><small>百万美元<\/small>/);
  assert.match(html, /<span>12,500,000<\/span><small>欧元<\/small>/);
  assert.match(html, /aria-label="12,500,000 美元"/);
  assert.match(html, /aria-label="12,500,000 欧元"/);
});

test("missing stays distinct from zero and source metadata never appears in the summary", async () => {
  const html = await render([period("2026-08-31", [
    metric("0", { sourceUrl: "https://example.test/private-source", sourceAccession: "private-accession", formula: "private-formula" }),
    metric(null, { id: "net", label: "净利润", missingReason: "private-diagnostic" }),
  ])]);
  assert.match(html, /data-missing="false" title="0 美元" aria-label="0 美元"><span>0<\/span>/);
  assert.match(html, /data-missing="true" title="暂无数据" aria-label="暂无数据"><span>—<\/span>/);
  assert.doesNotMatch(html, /private-source|private-accession|private-formula|private-diagnostic|出处/);
});
