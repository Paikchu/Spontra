/**
 * Renders the company page and home page in Chinese from the fixture and lists every visible word that is
 * neither Chinese, an allowed term, nor data. Generated text not yet translated is marked lang="en" and left alone;
 * then the same pages are rendered with the fixture's Chinese tables applied, as the read API serves them, and no
 * generated English may remain, the findings must still verify, and the 英文原文 tag must not show without English
 * beside it. Loaded by scripts/check-i18n.ts through Vite's SSR loader, so the site's own aliases and modules
 * resolve exactly as in the browser.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "@/packages/web/src/i18n/core";
import { BusinessMap } from "@/apps/business-site/src/BusinessMap";
import { Home } from "@/apps/business-site/src/Home";
import { SearchPanel } from "@/apps/business-site/src/SearchDialog";
import { Rail, RailActions } from "@/apps/business-site/src/Sidebar";
import { SidebarProvider } from "@/packages/web/src/ui/sidebar";
import { verifyFindings, type FindingData } from "@/shared/analysis-runtime/findings";
import { lensDocumentOf } from "@/shared/analysis-runtime/lens/legacy";
import { renderChartSvg } from "@/shared/analysis-runtime/lens/render";
import { compileDocument } from "@/shared/analysis-runtime/lens/verify";
import { checkTranslation, collectProse, localize, type TranslatedResource } from "@/shared/analysis-runtime/translation";
import { capital, company, events, filings, filingsZh, findings, fixtureStrings, flow, TICKER, ZH_TABLES } from "./fixture.ts";

/** The company's publications as the read API serves them in Chinese: the fixture's tables applied. */
const translated = {
  flow: localize("flow", flow, ZH_TABLES.flow),
  findings: localize("findings", findings, ZH_TABLES.findings),
  explainer: localize("explainer", company.explainer, ZH_TABLES.explainer),
  tree: localize("tree", company.tree, ZH_TABLES.tree),
  guidance: localize("guidance", company.guidance, ZH_TABLES.guidance),
  events: localize("events", events, ZH_TABLES.events),
  filings: filingsZh,
};
const english = { flow, findings, explainer: company.explainer, tree: company.tree, guidance: company.guidance, events, filings };
type Payload = typeof english;

/** Each finding's lens charts as the frame paints them: compiled on the host in Chinese, then drawn to SVG. */
function lensCharts(): Array<[string, string]> {
  const data: FindingData = { quarters: flow.quarters, history: company.history ?? null, capital, fundamentals: null, guidance: company.guidance };
  return verifyFindings(findings, data, "zh-CN").verified.flatMap(f => {
    const compiled = compileDocument(lensDocumentOf(f, data, f.periodEnd, "zh-CN"), data, f.periodEnd, { locale: "zh-CN" });
    return [...compiled].flatMap(([id, r]) => r.chart ? [[`lens ${f.id}/${id}`, renderChartSvg(r.chart, { width: 640, height: 280 }, { locale: "zh-CN" })] as [string, string]] : []);
  });
}

/** The browser globals the pages read while rendering; effects never run here. */
function browser(search: string) {
  const url = new URL(`http://localhost/companies/${TICKER}${search}`);
  const g = globalThis as Record<string, unknown>;
  g.location = { search: url.search, href: url.href, pathname: url.pathname, origin: url.origin };
  g.history = { state: null, replaceState() {}, pushState() {} };
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.getComputedStyle = () => ({ getPropertyValue: () => "" });
  g.document ??= { documentElement: { lang: "zh-CN", style: {}, classList: { contains: () => false } }, querySelector: () => null, querySelectorAll: () => [] };
  g.window ??= globalThis;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ATTRS = ["title", "aria-label", "placeholder", "alt", "aria-description", "aria-roledescription", "aria-valuetext"];
const decode = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Visible text and labelling attributes, skipping style/script and anything under lang="en". */
function readable(html: string): string[] {
  const out: string[] = [];
  const stack: Array<{ tag: string; skip: boolean }> = [];
  const skipping = () => stack.some(s => s.skip);
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>|([^<]+)/g)) {
    const [, close, tag, attrs = "", selfClose, text] = m;
    if (text != null) { if (!skipping()) out.push(decode(text)); continue; }
    if (close) { const at = stack.map(s => s.tag).lastIndexOf(tag!); if (at >= 0) stack.length = at; continue; }
    const lang = attrs.match(/\slang="([^"]*)"/)?.[1];
    const skip = lang === "en" || tag === "style" || tag === "script";
    if (!skip && !skipping()) for (const a of ATTRS) { const v = attrs.match(new RegExp(`\\s${a}="([^"]*)"`))?.[1]; if (v) out.push(decode(v)); }
    if (!selfClose && !VOID.has(tag!.toLowerCase())) stack.push({ tag: tag!, skip });
  }
  return out.map(s => s.trim()).filter(Boolean);
}


/** The company page as main.tsx mounts it, reading its focus from the URL set by browser(). */
function CompanyPage({ payload }: { payload: Payload }) {
  return <SidebarProvider asChild open keyboardShortcut={null} persistState={false}><main>
    <BusinessMap ticker={TICKER} tools={<RailActions light={false} onToggleTheme={() => {}} onSearch={() => {}} collapsed={false} />} flow={payload.flow} notice={null}
      revenueHistory={company.history ?? null} explainer={payload.explainer} tree={payload.tree} guidance={payload.guidance}
      capital={capital} findings={payload.findings} fundamentals={null} events={payload.events} filings={payload.filings} />
  </main></SidebarProvider>;
}

/** Every visible text, labels included, generated English as well. */
const allText = (html: string) => [...html.matchAll(/>([^<]+)</g)].map(m => m[1]!.trim()).filter(Boolean);

export async function checkPages(unexpectedLatin: (text: string) => string[], typography: (text: string) => string[]): Promise<string[]> {
  setLocale("zh-CN");
  const data = fixtureStrings();
  // Tickers and their logo monograms are data too.
  for (const t of [TICKER, "MSFT"]) { data.add(t); data.add(t.slice(0, 2)); }
  const problems = new Map<string, Set<string>>();
  const scenarios: Array<[string, string, () => React.ReactNode]> = [];
  const map = () => <CompanyPage payload={english} />;
  scenarios.push(
    ["home", "", () => <Home light={false} onToggleTheme={() => {}} recent={["ACME", "MSFT"]} onPick={() => {}} />],
    ["search", "", () => <SearchPanel current="ACME" recent={["ACME", "MSFT"]} onPick={() => {}} />],
    ["rail", "", () => <SidebarProvider asChild open keyboardShortcut={null} persistState={false}><main><Rail ticker={TICKER} actions={null} label="x" /></main></SidebarProvider>],
    ["company", "", map],
    ["business", "?business=cloud", map],
    ["metric", "?metric=gross_margin", map],
    ...findings.findings.map(f => [`finding ${f.id}`, `?finding=${f.id}`, map] as [string, string, () => React.ReactNode]),
    ...events.events.map(e => [`event ${e.id}`, `?event=${e.id}`, map] as [string, string, () => React.ReactNode]),
    ...filings.filings.map(r => [`report ${r.accessionNumber}`, `?report=${r.accessionNumber}`, map] as [string, string, () => React.ReactNode]),
  );
  const pages: Array<[string, () => string]> = [
    ...scenarios.map(([name, search, render]) => [name, () => { browser(search); return renderToStaticMarkup(<>{render()}</>); }] as [string, () => string]),
    ...lensCharts().map(([name, svg]) => [name, () => svg] as [string, () => string]),
  ];
  if (!pages.some(([name]) => name.startsWith("lens "))) problems.set("lens charts: none compiled from the fixture", new Set(["lens"]));
  for (const [name, produce] of pages) {
    let html: string;
    try { html = produce(); } catch (error) { problems.set(`${name}: render failed`, new Set([String(error).split("\n")[0]!])); continue; }
    const pieces = readable(html);
    for (const text of pieces) {
      if (data.has(text)) continue;
      // Spacing and punctuation where code-written Chinese meets data, e.g. an English segment name before 同比.
      if (/[\u3400-\u9fff]/.test(text)) for (const issue of typography(text).filter(i => !i.startsWith("English left"))) {
        const key = `${issue} in «${text.slice(0, 80)}»`;
        problems.set(key, (problems.get(key) ?? new Set()).add(name));
      }
      const words = unexpectedLatin(text).filter(w => !data.has(w) && !data.has(w.replace(/[.,]$/, "")));
      for (const w of words) {
        const key = `«${w}» in «${text.slice(0, 80)}»`;
        problems.set(key, (problems.get(key) ?? new Set()).add(name));
      }
    }
  }
  // The fixture's tables are what the translator would have to produce: complete, and each one passing its checks.
  for (const resource of ["flow", "findings", "explainer", "tree", "guidance", "events"] as const satisfies readonly TranslatedResource[]) {
    const table: Record<string, string> = ZH_TABLES[resource];
    for (const text of collectProse(resource, english[resource])) {
      const zh = table[text];
      const issues = zh == null ? ["missing"] : checkTranslation(text, zh);
      if (issues.length) problems.set(`fixture ${resource} translation of «${text.slice(0, 50)}»: ${issues.join("; ")}`, new Set([resource]));
    }
  }
  // Translated pages: no generated English left anywhere, the findings still verified in Chinese, and a 英文原文 tag only beside English.
  const generated = new Set((["flow", "findings", "explainer", "tree", "guidance", "events"] as const).flatMap(r => collectProse(r, english[r])));
  const translatedMap = () => <CompanyPage payload={translated} />;
  for (const [name, search] of scenarios.filter(([n]) => !["home", "search", "rail"].includes(n))) {
    browser(search);
    const html = renderToStaticMarkup(<>{translatedMap()}</>);
    for (const text of allText(html)) if (generated.has(text)) problems.set(`translated page still shows «${text.slice(0, 60)}»`, (problems.get(`translated page still shows «${text.slice(0, 60)}»`) ?? new Set()).add(name));
    for (const m of html.matchAll(/lang="en"[^>]*>([^<]+)</g)) if (/[\u3400-\u9fff]/.test(m[1]!)) problems.set(`Chinese marked lang="en": «${m[1]!.slice(0, 40)}»`, new Set([name]));
    if (html.includes("英文原文") && !/lang="en"/.test(html)) problems.set("英文原文 tag shown with no English text on the page", (problems.get("英文原文 tag shown with no English text on the page") ?? new Set()).add(name));
    if (name.startsWith("finding ")) {
      const f = translated.findings.findings.find(x => `finding ${x.id}` === name)!;
      if (!html.includes(f.title)) problems.set(`translated finding not shown (withheld by verification?): «${f.title}»`, new Set([name]));
    }
  }
  // The English pages must not show Chinese: a table read in the wrong place, or a locale that did not switch back.
  setLocale("en");
  for (const [name, search, render] of scenarios) {
    browser(search);
    const leaked = readable(renderToStaticMarkup(<>{render()}</>)).filter(t => /[\u3400-\u9fff]/.test(t) && !data.has(t) && t !== "中" && t !== "切换到中文");
    for (const text of leaked) problems.set(`Chinese on the English page «${text.slice(0, 60)}»`, (problems.get(`Chinese on the English page «${text.slice(0, 60)}»`) ?? new Set()).add(name));
  }
  return [...problems].map(([key, where]) => `${key}  (${[...where].slice(0, 3).join(", ")}${where.size > 3 ? ", …" : ""})`);
}
