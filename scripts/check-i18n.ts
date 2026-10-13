/**
 * Offline translation check for the business site: no network, no API, no translation service.
 *
 *  1. Tables   Every messages()/labels() table is loaded through Vite's SSR loader and each Chinese entry is checked
 *              against its English one: present, actually translated, same interpolated arguments, glossary terms.
 *  2. Literals Every Chinese string literal in site, web package and shared runtime code is checked for leftover
 *              English words, half-width punctuation and missing spaces between Chinese and Latin text.
 *  3. Numbers  The locale number forms (amounts, shares, points, multiples, periods) are pinned in both languages.
 *  4. Pages    The Chinese pages are rendered from fixtures and every visible word outside generated (lang="en")
 *              text must be Chinese, an allowed term, or data from the fixture.
 *
 * Run: npm run check:i18n. It runs before every site build, so a missing or broken translation fails the deploy.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";
import { createLogger, createServer, type ViteDevServer } from "vite";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SCOPE = ["apps/business-site/src", "packages/web/src", "shared/analysis-runtime", "shared/analysis-contract"];

const CJK = /[㐀-鿿豈-﫿]/;
/** Latin words a Chinese label may carry: filing vocabulary, accounting abbreviations, product names, key caps. */
const LATIN_TERMS = new Set([
  "SEC", "XBRL", "EDGAR", "GAAP", "Non-GAAP", "Form", "Item", "Reg", "FD", "RPO", "EPS", "PEG", "EV", "EBITDA", "EV/EBITDA",
  "TTM", "AI", "ID", "EN", "Esc", "esc", "Business", "View", "USD", "K", "Q",
  // Industry abbreviations Chinese finance writing keeps in Latin letters.
  "IaaS", "PaaS", "SaaS", "GPU", "CPU", "CDN", "PC", "IT", "AI",
]);
const LATIN_PATTERNS = [/^Q[1-4]$/, /^\d{1,2}-[A-Z]$/, /^10b5-1$/, /^EV\/$/];
const latinWords = (text: string) => (text.match(/[A-Za-z0-9][A-Za-z0-9./-]*/g) ?? []).filter(w => /[A-Za-z]/.test(w));
const unexpectedLatin = (text: string) => latinWords(text).filter(w => !LATIN_TERMS.has(w) && !LATIN_PATTERNS.some(p => p.test(w)));

/** Typography rules for a piece of Chinese text that the code itself wrote (interpolations removed). */
function typography(text: string): string[] {
  const issues: string[] = [];
  if (/[!！]/.test(text)) issues.push("exclamation mark");
  if (/\.\.\./.test(text)) issues.push('"..." instead of "…"');
  if (new RegExp(`${CJK.source}[,;:?()]|[,;:?(](?=${CJK.source})|\\)(?=${CJK.source})`).test(text)) issues.push("half-width punctuation next to Chinese");
  if (new RegExp(`${CJK.source}[A-Za-z]|[A-Za-z]${CJK.source}`).test(text)) issues.push("no space between Chinese and Latin text");
  const latin = unexpectedLatin(text);
  if (latin.length) issues.push(`English left in Chinese: ${latin.join(", ")}`);
  return issues;
}

async function sourceFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== "dist") await walk(path); }
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
    }
  }
  for (const dir of SCOPE) await walk(dir);
  return out.sort();
}

/* ---------- 2. Chinese literals ---------- */

async function checkLiterals(files: string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const file of files) {
    const source = await readFile(join(ROOT, file), "utf8");
    if (!CJK.test(source)) continue;
    const lines = source.split("\n");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      let text: string | null = null;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
      else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) text = node.text;
      else if (ts.isJsxText(node)) text = node.text;
      if (text && CJK.test(text)) {
        const line = ast.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        // A literal may keep English it quotes from a filing when the line above says why: `// i18n-allow: <reason>`.
        if (/i18n-allow:/.test(lines[line - 2] ?? "") || /i18n-allow:/.test(lines[line - 1] ?? "")) { ts.forEachChild(node, visit); return; }
        for (const issue of typography(text)) problems.push(`${file}:${line}  ${issue}  «${text.trim().slice(0, 60)}»`);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return problems;
}

/** Words in CSS `content:` reach the reader without passing through any table, so they are not allowed at all. */
async function checkStyles(): Promise<string[]> {
  const problems: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== "dist") await walk(path); continue; }
      if (!entry.name.endsWith(".css")) continue;
      const lines = (await readFile(join(ROOT, path), "utf8")).split("\n");
      lines.forEach((line, i) => { for (const m of line.matchAll(/content:\s*(["'])(.*?)\1/g)) if (/[A-Za-z]{2,}|[\u3400-\u9fff]/.test(m[2]!)) problems.push(`${path}:${i + 1}  text in CSS content «${m[2]}»; render it from a messages() table`); });
    }
  }
  for (const dir of ["apps/business-site/src", "packages/web/src"]) await walk(dir);
  return problems;
}

/* ---------- 1. Tables ---------- */

type Table = { kind: "messages" | "labels"; origin: string; en: Record<string, unknown>; zh: Record<string, unknown> };

/**
 * An argument that records where it lands: it prints as ⟦i⟧ (or ⟦i.key⟧ for a field), answers string methods on
 * that token and number methods on 7, so a message can be called without knowing its argument types.
 */
function probe(path: string): unknown {
  const token = `⟦${path}⟧`;
  return new Proxy(function () {}, {
    get(_, prop) {
      if (prop === Symbol.toPrimitive) return (hint: string) => hint === "number" ? 7 : token;
      if (prop === "toString" || prop === "valueOf") return () => token;
      if (typeof prop === "symbol") return undefined;
      if (prop in Number.prototype && !(prop in String.prototype)) return (...a: unknown[]) => (Number.prototype as unknown as Record<string, (...x: unknown[]) => unknown>)[prop].apply(7, a);
      if (prop in String.prototype) {
        const value = (String.prototype as unknown as Record<string, unknown>)[prop];
        return typeof value === "function" ? (...a: unknown[]) => (value as (...x: unknown[]) => unknown).apply(token, a) : token.length;
      }
      return probe(`${path}.${prop}`);
    },
  });
}
const call = (fn: (...a: unknown[]) => unknown) => {
  const args = Array.from({ length: Math.max(fn.length, 1) }, (_, i) => probe(String(i)));
  try { return String(fn(...args)); } catch { return null; }
};
const slots = (text: string) => new Set([...text.matchAll(/⟦(\d+)/g)].map(m => m[1]));
const literalOf = (text: string) => text.replace(/⟦[^⟧]*⟧/g, " ").replace(/\s+/g, " ").trim();

/** English terms whose Chinese is fixed by the glossary (docs/i18n-conventions.md). */
const GLOSSARY: Array<[RegExp, string]> = [
  [/\bgross margin\b/i, "毛利率"], [/\boperating margin\b/i, "营业利润率"], [/\bnet margin\b/i, "净利率"],
  [/\bgross profit\b/i, "毛利"], [/\boperating income\b/i, "营业利润"], [/\bnet income\b/i, "净利润"],
  [/\bcost of revenue\b/i, "营业成本"], [/\bfree cash flow\b/i, "自由现金流"], [/\boperating cash flow\b/i, "经营现金流"],
  [/\b(capex|capital expenditures?)\b/i, "资本开支"], [/\bguidance\b/i, "指引"], [/\bYoY\b/, "同比"], [/\bQoQ\b/, "环比"],
  [/\bfindings?\b/i, "要点"], [/\bbalance sheet\b/i, "资产负债表"], [/\bnot disclosed\b/i, "未披露"], [/\bseverity\b/i, "重要度"],
  [/(?<!cost of )\brevenue\b(?! model)/i, "营收"], [/\brevenue model\b/i, "收入模式"], [/\bbuybacks?\b/i, "回购"], [/\bdividends?\b/i, "分红"],
  [/\beliminations?\b/i, "抵销"], [/\bresearch and development\b|\bR&D\b/i, "研发"], [/\binsiders?\b/i, "内部人"],
];
/** Entries whose Chinese deliberately leaves out an argument the English prints, with the reason. */
const DROPPED_ARGUMENTS: Record<string, string> = {
  "FinancialSankey.tsx millions": "zh amounts carry 亿/万 and the currency, so the 'USD millions' unit is dropped",
  "FinancialSankey.tsx unit": "same as millions",
  "BusinessMap.tsx reconciliation": "same as millions",
  "BusinessMap.tsx asReported": "same as millions",
  "trend-model.ts expected": "the direction (up/down/flat) is printed as 上升/下降/持平 rather than as the raw value",
};
/** Labels written in the language they switch to, so they read the same in both tables. */
const OTHER_LANGUAGE = new Set(["Sidebar.tsx switchTo", "Sidebar.tsx other"]);
/** Entries the glossary rule should not apply to, with the reason. */
const GLOSSARY_EXEMPT: Record<string, string> = {
  "SecReaderContent.tsx cashAndCapex": "资本开支 is present; 现金流 covers 'cash flow' in the title",
  "trend-model.ts segment_revenue": "segment revenue guidance reads 营收 after the segment name",
  "TrendPanel.tsx guidanceDerived": "业绩指引 contains 指引",
};

function checkTables(tables: Table[]): { problems: string[]; variants: string[] } {
  const problems: string[] = [];
  const byEnglish = new Map<string, Set<string>>();
  for (const t of tables) {
    const file = t.origin.match(/([^/]+\.(?:tsx?|mjs))/)?.[1] ?? t.origin;
    for (const key of Object.keys(t.en)) {
      const where = `${file} ${key}`;
      if (OTHER_LANGUAGE.has(where)) continue;
      const e = t.en[key], z = t.zh[key];
      if (typeof e !== typeof z) { problems.push(`${where}  English is a ${typeof e}, Chinese a ${typeof z}`); continue; }
      let en: string, zh: string;
      if (typeof e === "function") {
        const a = call(e as (...x: unknown[]) => unknown), b = call(z as (...x: unknown[]) => unknown);
        if (a == null || b == null) { problems.push(`${where}  could not be called with probe arguments`); continue; }
        const missing = [...slots(a)].filter(s => !slots(b).has(s)), extra = [...slots(b)].filter(s => !slots(a).has(s));
        if ((missing.length || extra.length) && !DROPPED_ARGUMENTS[where]) problems.push(`${where}  arguments differ: English prints ${[...slots(a)].join(",") || "none"}, Chinese ${[...slots(b)].join(",") || "none"}`);
        en = literalOf(a); zh = literalOf(b);
      } else {
        en = String(e); zh = String(z);
        if (en && zh) byEnglish.set(en, (byEnglish.get(en) ?? new Set()).add(zh));
      }
      if (en && !zh && !DROPPED_ARGUMENTS[where]) { problems.push(`${where}  Chinese is empty`); continue; }
      if (unexpectedLatin(en).length && zh === en) problems.push(`${where}  not translated: «${en}»`);
      // A Chinese entry made of punctuation alone (a separator) has no Chinese to sit next to, so check it directly.
      if (!CJK.test(zh) && /[,;:?](?!\d)/.test(zh) && zh !== en.replace(/[,;:?]/g, "")) problems.push(`${where}  half-width punctuation in a Chinese separator  «${zh}»`);
      for (const issue of typography(zh)) problems.push(`${where}  ${issue}  «${zh}»`);
      if (!GLOSSARY_EXEMPT[where]) for (const [term, required] of GLOSSARY)
        if (term.test(en) && !zh.includes(required) && !(required === "营收" && /收入|营业额/.test(zh))) problems.push(`${where}  glossary: «${en}» should use ${required}, got «${zh}»`);
    }
  }
  const variants = [...byEnglish].filter(([, zh]) => zh.size > 1).map(([en, zh]) => `«${en}» → ${[...zh].map(z => `«${z}»`).join(" / ")}`);
  return { problems, variants };
}

/* ---------- 3. Number forms ---------- */

type LocaleModule = typeof import("../shared/analysis-runtime/locale.ts");
type LensFormat = typeof import("../shared/analysis-runtime/lens/format.ts");

function checkNumbers(l: LocaleModule, f: LensFormat): string[] {
  const cases: Array<[string, string, string]> = [
    ["compactMoney 75.7B en", l.compactMoney(75.7e9, "USD"), "$75.7B"],
    ["compactMoney 75.7B zh", l.compactMoney(75.7e9, "USD", "zh-CN"), "757亿美元"],
    ["compactMoney −28.7B zh", l.compactMoney(-28.7e9, "USD", "zh-CN"), "−287亿美元"],
    ["compactMoney 350M zh", l.compactMoney(350e6, "USD", "zh-CN"), "3.50亿美元"],
    ["compactMoney 1.2T zh", l.compactMoney(1.2e12, "USD", "zh-CN"), "1.20万亿美元"],
    ["compactMoney 50M zh", l.compactMoney(50e6, "USD", "zh-CN"), "5000万美元"],
    ["compactMoney EUR zh", l.compactMoney(4.2e9, "EUR", "zh-CN"), "42.0亿欧元"],
    ["compactMoney SEK en", l.compactMoney(4.2e9, "SEK"), "4.2B SEK"],
    ["compactShares en", l.compactShares(1_234_567), "1.23M shares"],
    ["compactShares zh", l.compactShares(1_234_567, "zh-CN"), "123万股"],
    ["points zh", l.points(1.5, "zh-CN"), "+1.5个百分点"],
    ["points en", l.points(-1.5), "−1.5 pp"],
    ["multiple zh", l.multiple("2.60", "zh-CN"), "2.60倍"],
    ["perShare zh", l.perShare(1.24, "USD", "zh-CN"), "1.24美元"],
    ["fiscalYearTo zh", l.fiscalYearTo("2026-08-31", "zh-CN"), "截至 2026.08 财年"],
    ["fiscalYearTo en", l.fiscalYearTo("2026-08-31"), "FY to 2026.08"],
    ["lens periodLabel zh", f.periodLabel("2026-08-31", "fiscal_year", "zh-CN"), "截至 2026.08 财年"],
    ["lens compactMoney en unchanged", f.compactMoney(-28.7e9, "USD"), "−$28.7B"],
    ["lens formatDelta zh", f.formatDelta(1.5, "percent", undefined, "zh-CN"), "+1.5个百分点"],
    ["lens formatDelta en unchanged", f.formatDelta(1.5, "percent"), "+1.5 pp"],
    ["range zh shares the unit", l.range("76.0亿美元", "78.0亿美元", "zh-CN"), "76.0–78.0亿美元"],
    ["range zh keeps mixed units", l.range("5000万美元", "1.20亿美元", "zh-CN"), "5000万美元–1.20亿美元"],
    ["range en unchanged", l.range("$7.6B", "$7.8B"), "$7.6B–$7.8B"],
  ];
  return cases.filter(([, got, want]) => got !== want).map(([name, got, want]) => `number form ${name}: got «${got}», want «${want}»`);
}

/* ---------- run ---------- */

async function loadTables(server: ViteDevServer, files: string[]): Promise<Table[]> {
  const audit: Table[] = [];
  (globalThis as Record<string, unknown>).__spontraI18nAudit = audit;
  for (const file of files) {
    const source = await readFile(join(ROOT, file), "utf8");
    if (!/\b(messages|labels)\(/.test(source) || file.includes("/i18n/")) continue;
    // A module's tables are made at load, before anything that needs a browser; an entry module that then
    // reaches for `document` has already registered them.
    try { await server.ssrLoadModule(join(ROOT, file)); } catch (error) { if (!/document|window/.test(String(error))) throw error; }
  }
  return audit;
}

async function main() {
  const files = await sourceFiles();
  // The page entry renders into `document` once its tables are made; that expected failure is not worth a log line.
  const logger = createLogger("error");
  const logError = logger.error.bind(logger);
  logger.error = (msg, options) => { if (!/Error when evaluating SSR module .*main\.tsx/.test(msg)) logError(msg, options); };
  const server = await createServer({ configFile: join(ROOT, "apps/business-site/vite.config.ts"), server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", customLogger: logger });
  try {
    const tables = await loadTables(server, files);
    const { problems: tableProblems, variants } = checkTables(tables);
    const literalProblems = [...await checkLiterals(files), ...await checkStyles()];
    const numberProblems = checkNumbers(
      await server.ssrLoadModule(join(ROOT, "shared/analysis-runtime/locale.ts")) as LocaleModule,
      await server.ssrLoadModule(join(ROOT, "shared/analysis-runtime/lens/format.ts")) as LensFormat,
    );
    const { checkPages } = await server.ssrLoadModule(join(ROOT, "scripts/i18n/pages.tsx")) as typeof import("./i18n/pages.tsx");
    const pageProblems = await checkPages(unexpectedLatin, typography);
    const entries = tables.reduce((n, t) => n + Object.keys(t.en).length, 0);
    const sections: Array<[string, string[]]> = [["Tables", tableProblems], ["Chinese literals", literalProblems], ["Number forms", numberProblems], ["Rendered pages", pageProblems]];
    for (const [title, list] of sections) if (list.length) console.log(`\n${title} (${list.length})\n${list.map(p => "  " + p).join("\n")}`);
    if (process.argv.includes("--variants") && variants.length) console.log(`\nSame English, different Chinese (${variants.length}); review only\n${variants.map(v => "  " + v).join("\n")}`);
    const total = sections.reduce((n, [, list]) => n + list.length, 0);
    console.log(`\ni18n: ${tables.length} tables, ${entries} entries, ${files.length} files scanned, ${total} problem${total === 1 ? "" : "s"}`);
    if (total) process.exitCode = 1;
  } finally {
    await server.close();
  }
}

if (relative(process.cwd(), process.argv[1] ?? "").endsWith("check-i18n.ts") || process.argv[1]?.endsWith("check-i18n.ts")) await main();
