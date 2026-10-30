import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import * as React from "react";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../../packages/web/src/i18n/core.ts";
import { SidebarProvider } from "../../../packages/web/src/ui/sidebar.tsx";
import type { BusinessFlowQuarter, PublicBusinessFlow } from "../../../shared/analysis-contract/business-flow.ts";
import { capital, company, filings, findings, flow, TICKER, valuation } from "../../../scripts/i18n/fixture.ts";
import type { ValuationResponse } from "../../../shared/analysis-contract/valuation.ts";
import type { FindingsPublication } from "../../../shared/analysis-contract/findings.ts";
import type { PublicFilingDigestPage } from "../../../shared/analysis-contract/filings.ts";
import { companyIdentity, type CompanyIdentity } from "../src/company-meta.ts";

// The page imports assets through Vite (a font `?url`, stylesheets); here they resolve to an empty module.
register(new URL("./fixtures/asset-hooks.mjs", import.meta.url));
const { BusinessMap } = await import("../src/BusinessMap.tsx");

/** The browser globals the page reads while rendering on the server (effects never run). */
function browser(search = "") {
  const g = globalThis as Record<string, unknown>;
  const url = new URL(`http://localhost/companies/${TICKER}${search}`);
  g.location = { search: url.search, href: url.href, pathname: url.pathname, origin: url.origin };
  g.history = { state: null, replaceState() {}, pushState() {} };
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.getComputedStyle = () => ({ getPropertyValue: () => "" });
  g.document ??= { documentElement: { lang: "en", style: {}, classList: { contains: () => false } }, querySelector: () => null, querySelectorAll: () => [] };
  g.window ??= globalThis;
  // The rail's filings list renders shared components that this runner compiles with the classic JSX transform.
  g.React ??= React;
  g.addEventListener ??= () => {};
  g.removeEventListener ??= () => {};
}

function render(locale: "en" | "zh-CN", payload: PublicBusinessFlow = flow, options: { filings?: PublicFilingDigestPage | null; issuer?: { name: string; fiscalYearEndMonth: number | null; annualForm?: string | null }; identity?: CompanyIdentity; valuation?: ValuationResponse | null; findings?: FindingsPublication | null; search?: string } = {}) {
  setLocale(locale);
  browser(options.search);
  const pageFilings = options.filings ?? null;
  // As CompanyPage.tsx resolves it: the issuer, the publications, the flow and the filings.
  const identity = options.identity ?? companyIdentity({ locale, issuer: options.issuer ?? company.issuer, explainerName: company.explainer.companyName, flow: payload, filings: pageFilings });
  return renderToStaticMarkup(h(SidebarProvider, { asChild: true, open: true, keyboardShortcut: null, persistState: false },
    h("main", null, h(BusinessMap, { ticker: TICKER, tools: null, flow: payload, notice: null, revenueHistory: company.history ?? null, capital, filings: pageFilings, company: identity, valuation: options.valuation ?? null, findings: options.findings ?? null }))));
}

/** A foreign issuer: its quarters in New Taiwan dollars on a calendar fiscal year, its annual report a 20-F. */
const foreignFlow = (): PublicBusinessFlow => ({ ...flow, quarters: flow.quarters.map(q => ({ ...q, currency: "TWD", fiscalYearEndMonth: undefined })) });
const filings0: PublicFilingDigestPage = filings;
const foreignFilings: PublicFilingDigestPage = { ...filings, filings: [...filings.filings, { ...filings.filings[1]!, accessionNumber: "0001-26-000003", form: "20-F" }] };

/** The fixture with a bank-shaped latest quarter (no gross profit, no operating income) and a revenue adjustment. */
function bankFlow(): PublicBusinessFlow {
  const quarters = flow.quarters.map((q, i, all): BusinessFlowQuarter => {
    if (i !== all.length - 1) return q;
    const figures = { ...q.figures };
    delete figures.gross; delete figures.operating; delete figures.cost; delete figures.operatingExpenses;
    const segmentTotal = q.segments.reduce((sum, s) => sum + Number(s.revenue?.value ?? 0), 0);
    return { ...q, figures, revenueAdjustments: [{ id: "elim", name: "Intersegment eliminations", amount: { value: String(Number(q.figures.revenue!.value) - segmentTotal - 0.567), basis: "reported", definition: "", comparabilityKey: null, sourceIds: [] } }],
      figures: { ...figures, revenue: { ...q.figures.revenue!, value: String(Number(q.figures.revenue!.value) - 0.567) } } };
  });
  return { ...flow, quarters };
}

const slotsOf = (html: string) => [...html.matchAll(/<div class="stat"( data-missing="true")?[^>]*>.*?<\/div>/g)].map(m => m[0]);

test("U25: neither the stage nor the rail carries the fiscal quarter pill or the fiscal year end", () => {
  for (const locale of ["zh-CN", "en"] as const) {
    const html = render(locale);
    assert.doesNotMatch(html, /stage-kicker|period-mark|fiscal-meta|fiscal-note|stage-fiscal-meta|rail-company-name|brand-company-name/);
    assert.doesNotMatch(html, /财年截至|FY ends/);
    // A domestic filer reporting in dollars has no filer line at all.
    assert.doesNotMatch(html, /rail-company-meta/);
  }
});

test("U25: a foreign issuer's form and currency stay on the rail, without the fiscal year end", () => {
  const zh = render("zh-CN", foreignFlow(), { filings: foreignFilings, issuer: { name: "Acme Corp", fiscalYearEndMonth: 12 } });
  assert.match(zh, /<div class="rail-company-meta"><span class="rail-company-sub" title="20-F · 报告货币：新台币">20-F · 报告货币：新台币<\/span><\/div>/);
  assert.doesNotMatch(zh, /财年截至/);
  const en = render("en", foreignFlow(), { filings: foreignFilings, issuer: { name: "Acme Corp", fiscalYearEndMonth: 12 } });
  assert.match(en, /<span class="rail-company-sub"[^>]*>20-F · Reports in TWD<\/span>/);
  // A company prop with only a name and fiscal month still gets the line from the flow and the filings.
  const bare = render("en", foreignFlow(), { filings: foreignFilings, identity: { name: "Acme Corp", fullName: null, fiscalYearEndMonth: 12, annualForm: null, filingLabel: null } });
  assert.match(bare, /<span class="rail-company-sub"[^>]*>20-F · Reports in TWD<\/span>/);
});

test("U22: on production's data, an empty filings feed and the form on the issuer, the line still names the 20-F", () => {
  const issuer = { name: "Acme Corp", fiscalYearEndMonth: 12, annualForm: "20-F" };
  for (const filings of [null, { ...filings0, filings: [] }]) {
    assert.match(render("zh-CN", foreignFlow(), { filings, issuer }), /<span class="rail-company-sub"[^>]*>20-F · 报告货币：新台币<\/span>/);
    assert.match(render("en", foreignFlow(), { filings, issuer }), /<span class="rail-company-sub"[^>]*>20-F · Reports in TWD<\/span>/);
  }
});

/** The stage's view tabs: its own first child, outside the figures' header; the tabs' values in order and the pressed one. */
function tabsOf(html: string) {
  const stage = html.match(/<section class="stage"[^>]*>(.*)<\/section>/s)?.[1] ?? "";
  const row = stage.match(/^<div class="stage-tabs">(.*?)<\/div>/s)?.[1] ?? null;
  const tabs = [...(row ?? "").matchAll(/<button[^>]*aria-checked="(true|false)"[^>]*>([^<]*)<\/button>/g)].map(m => ({ on: m[1] === "true", label: m[2] }));
  return { row, labels: tabs.map(t => t.label), pressed: tabs.find(t => t.on)?.label ?? null, view: html.match(/<section class="stage"[^>]*data-view="([^"]+)"/)?.[1] };
}

test("U25: the valuation tab comes first and the page opens on it when a report is published", () => {
  const ready = tabsOf(render("zh-CN", flow, { valuation }));
  assert.ok(ready.row, "the tabs are the stage's first child");
  assert.deepEqual(ready.labels, ["估值评估", "利润", "现金流", "资产负债表"]);
  assert.equal(ready.pressed, "估值评估");
  assert.equal(ready.view, "valuation");
  // The tab row is not part of the figures' header in any view.
  assert.doesNotMatch(render("zh-CN", flow, { valuation, search: "?view=profit" }), /<header class="stage-head[^"]*"[^>]*>(?:(?!<\/header>).)*role="radiogroup" aria-label="财务视图"/s);
});

test("U25: without a published valuation the page opens on the income statement, the tabs in the same place", () => {
  for (const v of [null, { ...valuation, availability: "preparing", report: null }, { ...valuation, availability: "failed", report: null }] as Array<ValuationResponse | null>) {
    const tabs = tabsOf(render("zh-CN", flow, { valuation: v }));
    assert.equal(tabs.view, "profit");
    assert.equal(tabs.pressed, "利润");
    assert.equal(tabs.labels[0], v ? "估值评估" : "利润");
  }
  const hidden = tabsOf(render("zh-CN", flow, { valuation: { ...valuation, availability: "hidden" } }));
  assert.deepEqual([hidden.view, hidden.labels], ["profit", ["利润", "现金流", "资产负债表"]]);
});

test("U25: a link to a view or to something on the statements opens there, not on the valuation", () => {
  assert.equal(tabsOf(render("zh-CN", flow, { valuation, search: "?view=cash" })).view, "cash");
  assert.equal(tabsOf(render("zh-CN", flow, { valuation, search: "?business=cloud" })).view, "profit");
  assert.equal(tabsOf(render("zh-CN", flow, { valuation, search: "?metric=capex" })).view, "profit");
});

test("U25: the tabs keep the stage's top-right corner beside the figures' controls, pinned, at every width", async () => {
  const css = await read("../src/style.css");
  // Wide screens: the figures' header and the tabs share the stage's first row, the tabs in the right-hand column.
  assert.match(css, /\.stage \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.stage > \.stage-head--summary \{ grid-column: 1; grid-row: 1; \}/);
  assert.match(css, /\.stage > \.stage-tabs \{ grid-column: 2; grid-row: 1;[^}]*position: sticky;/);
  // Tablets and phones: a row of their own above the figures, only as wide as the tabs, at the right; never a full-width bar.
  const tablet = media(css, "max-width: 960px"), phone = media(css, "max-width: 640px");
  assert.match(tablet, /\.stage > \.stage-tabs \{[^}]*--stage-tabs-top: 65px;[^}]*justify-self: end;/);
  assert.match(phone, /\.stage > \.stage-tabs \{ --stage-tabs-top: max\(8px, env\(safe-area-inset-top\)\);/);
  for (const block of [css, tablet, phone]) assert.doesNotMatch(block, /\.stage-tabs \{[^}]*(?:margin: 0 -16px|backdrop-filter)/);
});

test("U25: a headline tile is its title and its number, toned good or bad, its detail in the tooltip", () => {
  const html = render("zh-CN", flow, { findings, search: "?view=profit" });
  const stats = html.match(/<div class="stats"[^>]*>(.*?)<\/div><div class="stage-controls"/s)?.[1] ?? "";
  assert.ok(stats, "the stats row renders");
  assert.doesNotMatch(stats, /stat-note/);
  for (const stat of stats.match(/<div class="stat"[^>]*>.*?<\/strong><\/div>/gs) ?? []) {
    assert.match(stat, /^<div class="stat"[^>]*><span class="stat-label"[^>]*>.*?<\/span><strong class="stat-value"[^>]*>[^<]*<\/strong><\/div>$/s);
  }
  assert.match(stats, /<strong class="stat-value" data-tone="(?:good|bad)">/);
});

test("U21: an operating company's header shows its four figures, none of them empty", () => {
  const slots = slotsOf(render("zh-CN"));
  assert.equal(slots.length, 4);
  assert.equal(slots.filter(s => s.includes('data-missing="true"')).length, 0);
  for (const label of ["总营收", "毛利", "营业利润", "净利润"]) assert.ok(slots.some(s => s.includes(`>${label}<`)), label);
});

test("U21: a bank keeps four cells, the one outside its statement model marked with the reason", () => {
  const zh = render("zh-CN", bankFlow());
  const slots = slotsOf(zh);
  assert.equal(slots.length, 4);
  const missing = slots.filter(s => s.includes('data-missing="true"'));
  assert.equal(missing.length, 1);
  assert.match(missing[0]!, />营业利润</);
  assert.match(missing[0]!, /^<div class="stat" data-missing="true" title="营业利润 · 不适用于该行业报表模型">/);
  assert.match(missing[0]!, /<strong class="stat-value" aria-label="暂无 · 不适用于该行业报表模型">暂无<\/strong>/);
  assert.doesNotMatch(missing[0]!, /stat-note/);
  assert.ok(slots.some(s => s.includes(">税前利润<")));
  const en = slotsOf(render("en", bankFlow())).find(s => s.includes('data-missing="true"'))!;
  assert.match(en, /<strong class="stat-value" aria-label="N\/A · Not applicable to model">N\/A<\/strong>/);
});

test("U21/U23: the reconciliation folds, names its lines in Chinese and keeps two decimals at most", () => {
  const zh = render("zh-CN", bankFlow());
  const block = zh.match(/<details class="revenue-reconciliation"[^>]*>.*?<\/details>/)?.[0];
  assert.ok(block, "reconciliation rendered");
  assert.match(block!, /<summary class="rail-label">营收调节（分部合计与合并营收的差）<\/summary>/);
  assert.match(block!, /<dt>分部间抵销<\/dt><dd>−56\.7万美元<\/dd>/);
  assert.doesNotMatch(block!, /\d\.\d{3}/);
  // Wide screens open it; the server render has no narrow viewport.
  assert.match(block!, /^<details class="revenue-reconciliation" open="">/);
  const en = render("en", bankFlow()).match(/<details class="revenue-reconciliation".*?<\/details>/)![0];
  assert.match(en, /<summary class="rail-label">Revenue reconciliation<small> · USD millions<\/small><\/summary>/);
  assert.match(en, /<dt>Intersegment eliminations<\/dt><dd>−0\.57<\/dd>/);
});

test("U21: the trend's axis ticks leave out the currency, which the legend states once", () => {
  const zh = render("zh-CN");
  const ticks = [...(zh.match(/<div class="trend-grid"[^>]*>(.*?)<\/div><i class="trend-sweep"/)?.[1] ?? "").matchAll(/<span>([^<]*)<\/span>/g)].map(m => m[1]);
  assert.ok(ticks.length >= 3, `ticks: ${ticks}`);
  assert.equal(ticks[0], "0");
  for (const tick of ticks) assert.doesNotMatch(tick!, /美元|\$/);
  assert.match(zh, /<span class="trend-sub">单位：美元<\/span>/);
  assert.match(render("en"), /<span class="trend-sub">Unit: USD<\/span>/);
});

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
/** The body of every `@media (<query>)` block in a stylesheet, joined. */
function media(css: string, query: string): string {
  const out: string[] = [];
  for (let at = css.indexOf(`@media (${query})`); at >= 0; at = css.indexOf(`@media (${query})`, at + 1)) {
    let depth = 0, i = css.indexOf("{", at);
    const start = i;
    for (; i < css.length; i++) { if (css[i] === "{") depth++; else if (css[i] === "}" && --depth === 0) break; }
    out.push(css.slice(start + 1, i));
  }
  return out.join("\n");
}
const orderOf = (block: string, selector: string) => {
  const rules = [...block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1]!.split(",").map(s => s.trim()).includes(selector));
  const order = rules.map(m => m[2]!.match(/(?:^|;|\s)order:\s*(-?\d+)/)?.[1]).filter(v => v != null).at(-1);
  return order == null ? null : Number(order);
};

test("U21: on phones the page reads top bar, figures and chart, then the rail's sections, then the reconciliation", async () => {
  const phone = media(await read("../src/style.css"), "max-width: 640px");
  const sequence = [".rail-top", ".stage", ".biz", ".stream", ".revenue-reconciliation"].map(s => orderOf(phone, s));
  assert.deepEqual(sequence, [0, 1, 2, 3, 4]);
  assert.match(phone, /\.stats \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  // Headline figures keep the page face: monospace read as terminal output.
  assert.match(phone, /\.stat-value \{[^}]*font-size: 22px; line-height: 28px; font-weight: 620;[^}]*tabular-nums/);
  assert.doesNotMatch(phone, /\.stat-value \{[^}]*font-family: var\(--mono\)/);
  assert.doesNotMatch(phone, /\.rail-company-meta \{[^}]*display:\s*none/);
  assert.doesNotMatch(phone, /brand-company-name/);
  assert.match(phone, /\.rail-top\[data-company\] \{ flex-wrap: wrap; \}/);
  // Wide screens keep their header: a missing figure's cell is for the phone grid only.
  assert.match(media(await read("../src/style.css"), "min-width: 641px"), /\.stats > div\[data-missing="true"\] \{ display: none; \}/);
});

test("U21: the trend's axis is wide enough for its ticks at every width", async () => {
  const css = await read("../src/style.css");
  assert.match(css, /\.trend \{[^}]*--axis: 58px/);
  for (const query of ["max-width: 960px", "max-width: 640px"]) for (const m of media(css, query).matchAll(/--axis:\s*(\d+)px/g)) assert.ok(Number(m[1]) >= 56, `${query} --axis ${m[1]}px`);
});

test("on phones Ask stays in the page flow at the rail's end: no floating button over the sections", async () => {
  const [css, host] = await Promise.all([read("../src/stage/stage.css"), read("../src/StageHost.tsx".replace("/StageHost", "/stage/StageHost"))]);
  const phone = media(css, "max-width: 640px");
  assert.doesNotMatch(phone, /\.ask-entry \{[^}]*position: fixed/);
  assert.doesNotMatch(phone, /\.ask-open \{[^}]*border-radius: 999px/);
  assert.match(media(css, "max-width: 960px"), /\.ask-entry \{ margin: 12px 0 0;/);
  assert.match(host, /className="ask-open" aria-label=\{m\.ask\} title=\{m\.ask\}/);
});

test("U21: the sideways chart fades its right edge and says to swipe, and the loading face keeps four cells", async () => {
  const [css, map, skeleton] = await Promise.all([read("../src/style.css"), read("../src/BusinessMap.tsx"), read("../src/CompanySkeleton.tsx")]);
  assert.match(media(css, "max-width: 960px"), /\.chart\[data-overflow\]:not\(\[data-end\]\) \{ mask-image: linear-gradient\(to right/);
  assert.match(map, /swipe: "左右滑动查看完整流向"/);
  assert.match(map, /swipe: "Swipe horizontally to see full flow"/);
  assert.match(skeleton, /\[0, 1, 2, 3\]\.map\(i => <div key=\{i\} className="stat">/);
});
