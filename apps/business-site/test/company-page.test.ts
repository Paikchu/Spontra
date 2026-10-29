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
import { capital, company, filings, flow, TICKER } from "../../../scripts/i18n/fixture.ts";
import type { PublicFilingDigestPage } from "../../../shared/analysis-contract/filings.ts";
import { companyIdentity, type CompanyIdentity } from "../src/company-meta.ts";

// The page imports assets through Vite (a font `?url`, stylesheets); here they resolve to an empty module.
register(new URL("./fixtures/asset-hooks.mjs", import.meta.url));
const { BusinessMap } = await import("../src/BusinessMap.tsx");

/** The browser globals the page reads while rendering on the server (effects never run). */
function browser() {
  const g = globalThis as Record<string, unknown>;
  const url = new URL(`http://localhost/companies/${TICKER}`);
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

function render(locale: "en" | "zh-CN", payload: PublicBusinessFlow = flow, options: { filings?: PublicFilingDigestPage | null; issuer?: { name: string; fiscalYearEndMonth: number | null; annualForm?: string | null }; identity?: CompanyIdentity } = {}) {
  setLocale(locale);
  browser();
  const pageFilings = options.filings ?? null;
  // As main.tsx resolves it: the issuer, the publications, the flow and the filings.
  const identity = options.identity ?? companyIdentity({ locale, issuer: options.issuer ?? company.issuer, explainerName: company.explainer.companyName, flow: payload, filings: pageFilings });
  return renderToStaticMarkup(h(SidebarProvider, { asChild: true, open: true, keyboardShortcut: null, persistState: false },
    h("main", null, h(BusinessMap, { ticker: TICKER, tools: null, flow: payload, notice: null, revenueHistory: company.history ?? null, capital, filings: pageFilings, company: identity }))));
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

test("U22: the rail shows fiscal year + tip under the ticker; the stage keeps only the period pill", () => {
  const zh = render("zh-CN");
  assert.doesNotMatch(zh, /rail-company-name|brand-company-name|stage-fiscal-meta/);
  assert.match(zh, /class="fiscal-meta"[^>]*><button[^>]*class="fiscal-note"[^>]*>.*?<span class="rail-company-sub">财年截至 5 月<\/span>/s);
  assert.match(zh, /<span class="fiscal-note-tip" role="tooltip"[^>]*>该公司财年截至每年 5 月，所以 2026\.06\.30 结束的季度是 2027 财年 Q1<\/span>/);
  // The period tag alone stays on the stage.
  assert.match(zh, /2027 财年 Q1/);
  const en = render("en");
  assert.match(en, /class="rail-company-sub"[^>]*>FY ends May</);
  assert.match(en, /Fiscal year ends in May, so the quarter ended Jun 30, 2026 is FY2027 Q1/);
  assert.match(en, /FY27 Q1/);
});

test("U22: a foreign issuer's fiscal year, form and currency stay on the rail (desktop and phone)", () => {
  const zh = render("zh-CN", foreignFlow(), { filings: foreignFilings, issuer: { name: "Acme Corp", fiscalYearEndMonth: 12 } });
  assert.match(zh, /<span class="rail-company-sub"[^>]*>财年截至 12 月 · 20-F · 报告货币：新台币<\/span>/);
  assert.doesNotMatch(zh, /stage-fiscal-meta/);
  const en = render("en", foreignFlow(), { filings: foreignFilings, issuer: { name: "Acme Corp", fiscalYearEndMonth: 12 } });
  assert.match(en, /<span class="rail-company-sub"[^>]*>FY ends Dec · 20-F · Reports in TWD<\/span>/);
  assert.doesNotMatch(en, /stage-fiscal-meta/);
  // A company prop with only a name and fiscal month still gets the line from the flow and the filings.
  const bare = render("en", foreignFlow(), { filings: foreignFilings, identity: { name: "Acme Corp", fullName: null, fiscalYearEndMonth: 12, annualForm: null, fiscalLabel: null, filingLabel: null, fiscalNote: null } });
  assert.match(bare, /<span class="rail-company-sub"[^>]*>FY ends Dec · 20-F · Reports in TWD<\/span>/);
  assert.doesNotMatch(bare, /stage-fiscal-meta/);
});

test("U22: on production's data, an empty filings feed and the form on the issuer, the line still names the 20-F", () => {
  const issuer = { name: "Acme Corp", fiscalYearEndMonth: 12, annualForm: "20-F" };
  for (const filings of [null, { ...filings0, filings: [] }]) {
    const zh = render("zh-CN", foreignFlow(), { filings, issuer });
    assert.match(zh, /<span class="rail-company-sub"[^>]*>财年截至 12 月 · 20-F · 报告货币：新台币<\/span>/);
    assert.doesNotMatch(zh, /stage-fiscal-meta/);
    const en = render("en", foreignFlow(), { filings, issuer });
    assert.match(en, /<span class="rail-company-sub"[^>]*>FY ends Dec · 20-F · Reports in TWD<\/span>/);
    assert.doesNotMatch(en, /stage-fiscal-meta/);
  }
});

test("U22: the fiscal note is the quarter on the stage's, not the one the page resolved first", () => {
  // The page resolved its identity on the earlier quarters; the stage shows the latest, so the note follows it.
  const older = { ...flow, quarters: flow.quarters.slice(0, -1) };
  const identity = companyIdentity({ locale: "zh-CN", issuer: company.issuer, explainerName: company.explainer.companyName, flow: older });
  assert.doesNotMatch(identity.fiscalNote!, /2026\.06\.30/);
  const zh = render("zh-CN", flow, { identity });
  assert.match(zh, /<span class="fiscal-note-tip" role="tooltip"[^>]*>该公司财年截至每年 5 月，所以 2026\.06\.30 结束的季度是 2027 财年 Q1<\/span>/);
  assert.match(zh, /<span class="rail-company-sub">财年截至 5 月<\/span>/);
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
  assert.match(missing[0]!, /<strong class="stat-value">暂无<\/strong><em class="stat-note"[^>]*>不适用于该行业报表模型<\/em>/);
  assert.ok(slots.some(s => s.includes(">税前利润<")));
  const en = slotsOf(render("en", bankFlow())).find(s => s.includes('data-missing="true"'))!;
  assert.match(en, /<strong class="stat-value">N\/A<\/strong><em class="stat-note"[^>]*>Not applicable to model<\/em>/);
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
  const sequence = [".rail-top", ".stage", '.findings[data-section="business"]', '.findings[data-section="findings"]', '.findings[data-section="events"]', ".revenue-reconciliation", ".rail-end"].map(s => orderOf(phone, s));
  assert.deepEqual(sequence, [0, 1, 2, 3, 4, 5, 6]);
  assert.match(phone, /\.stats \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(phone, /\.stat-value \{[^}]*font-family: var\(--mono\);[^}]*font-size: 22px; line-height: 28px; font-weight: 600;[^}]*tabular-nums/);
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

test("U21: on phones Ask is one 48px round button at the bottom right, named for screen readers", async () => {
  const [css, host] = await Promise.all([read("../src/stage/stage.css"), read("../src/stage/StageHost.tsx")]);
  const phone = media(css, "max-width: 640px");
  assert.match(phone, /\.ask-entry \{[^}]*position: fixed; right: 16px; bottom: calc\(16px \+ env\(safe-area-inset-bottom\)\);/);
  assert.match(phone, /\.ask-open \{[^}]*width: 48px; height: 48px; min-width: 48px; padding: 0; border-radius: 999px;/);
  assert.match(phone, /\.ask-open > span \{ display: none; \}/);
  assert.match(host, /className="ask-open" aria-label=\{m\.ask\} title=\{m\.ask\}/);
});

test("U21: the sideways chart fades its right edge and says to swipe, and the loading face keeps four cells", async () => {
  const [css, map, main] = await Promise.all([read("../src/style.css"), read("../src/BusinessMap.tsx"), read("../src/main.tsx")]);
  assert.match(media(css, "max-width: 960px"), /\.chart\[data-overflow\]:not\(\[data-end\]\) \{ mask-image: linear-gradient\(to right/);
  assert.match(map, /swipe: "左右滑动查看完整流向"/);
  assert.match(map, /swipe: "Swipe horizontally to see full flow"/);
  assert.match(main, /\[0, 1, 2, 3\]\.map\(i => <div key=\{i\} className="stat">/);
});
