/**
 * Translated publications (docs/i18n-design.md, phase 2). Every publication is generated and verified in English;
 * a pipeline task then translates its reader-facing strings once, string by string, into a table keyed by the English
 * text. The read API applies that table to the English payload, so the page receives the same structure with the
 * prose in the reader's language, and any string not yet translated stays English.
 *
 * One walker decides which strings are prose for both sides: what the pipeline collects for translation is exactly
 * what the read API replaces. Identifiers, figures, filing names and verbatim quotes are never touched.
 * Pure and worker-safe.
 */
import { proseNumbers, numberSupported } from "./findings.ts";
import type { Locale } from "./locale.ts";

export type TranslatedResource = "flow" | "findings" | "explainer" | "tree" | "guidance" | "events" | "filings" | "filing";
export const TRANSLATED_RESOURCES: readonly TranslatedResource[] = ["flow", "findings", "explainer", "tree", "guidance", "events", "filings", "filing"];
/** English text → translated text, for one resource of one company in one locale. */
export type TranslationTable = Readonly<Record<string, string>>;

type Rule = {
  /** Keys whose string value (or array of strings) is prose. */
  keys?: ReadonlySet<string>;
  /** With no key list: any string that reads as English prose, outside the skipped keys. */
  prose?: boolean;
  /** Subtrees never read: sources, quotes, identifiers, figures. */
  skip: ReadonlySet<string>;
  /** Objects never read, such as a lens block quoting a filing verbatim. */
  skipWhen?: (value: Record<string, unknown>) => boolean;
};

const set = (...values: string[]) => new Set(values);
const RULES: Record<TranslatedResource, Rule> = {
  // The statement's descriptive sentences: what each business is, who buys, how it charges, the basis. Names and figures are data.
  flow: { keys: set("description", "customers", "monetization", "disclosure", "basisLabel"), skip: set("sources", "figures", "name", "products", "lineage", "amount", "revenue", "expenseComponents", "otherComponents", "revenueAdjustments") },
  // Findings with their lens documents (the analyst dossier is merged in): titles, judgments, watches, prose,
  // chart and table words, highlight titles. Materials, sources and quote blocks are the filings' own words.
  findings: { keys: set("title", "text", "condition", "label"), skip: set("sources", "materials", "anchors", "ref", "refs", "fingerprint", "model", "said"), skipWhen: v => v.kind === "quote" },
  // Business explanations: summaries, offerings, section titles and items. Business and product names are data.
  explainer: { keys: set("text", "title", "label"), skip: set("sources", "name", "products", "line", "companyName", "model", "fingerprint") },
  // The business mind map: summaries, glosses and revenue models; the anchor is a verbatim filing passage.
  tree: { keys: set("text", "gloss", "label"), skip: set("sources", "anchor", "name", "research", "companyName", "model", "fingerprint") },
  // Guidance: the one-sentence statement and the metric label; the quote is the release's own words.
  guidance: { keys: set("text", "label"), skip: set("sources", "quote", "coverage", "segment") },
  // Events: the 8-K summary only; Form 4 footnotes, EDGAR descriptions and exhibits are filing text.
  events: { keys: set("headline", "label", "detail", "analystView"), skip: set("insider", "exhibits", "description", "items") },
  // The filing list: each filing's summary (with its short report) and the analysis' changes, risks and guidance statements.
  filings: {
    keys: set("headline", "label", "detail", "analystView", "report", "currentStatement", "priorStatement", "statement", "topicKey"),
    skip: set("nodes", "discovery", "reader", "presentation", "publication", "keyMetrics", "dataQuality", "figures", "trends", "financialLens",
      "marketSnapshot", "sourceMaterials", "fiscalPeriod", "earningsGroup", "company", "evidenceIds", "metricDeltas"),
  },
  // One filing's full report: every English sentence in the summary and the analysis, outside quotes, evidence and figures.
  // The financial lens stays English: the reader matches its limitations against English patterns to decide what to show.
  filing: {
    prose: true,
    skip: set("quote", "quotes", "excerpt", "excerpts", "evidence", "evidenceIds", "discovery", "facts", "sourceMaterials", "figures", "trends",
      "financialLens", "keyMetrics", "publication", "latex", "url", "href", "src", "id", "nodeId", "metricKey", "metricKeys", "accessionNumber", "unit", "currency",
      "fiscalPeriod", "earningsGroup", "company", "status", "type", "kind", "version", "form", "path", "filename", "dataQuality"),
  },
};

const MAX_UNIT = 8000;
const URL_LIKE = /^(?:https?:|\/|www\.)/i;
/** A string the full-report rule treats as prose: at least two English words and no address. */
const readsAsProse = (s: string) => s.length >= 8 && s.length <= MAX_UNIT && !URL_LIKE.test(s) && (s.match(/[A-Za-z]{3,}/g)?.length ?? 0) >= 2 && /\s/.test(s);
/** Words to translate: a template made of placeholders alone (`{value}`), a dash or a figure has none. */
const isText = (s: string, rule: Rule) => /[A-Za-z]/.test(s.replace(/\{(?:value|change|label|period)\}/g, "")) && s.length <= MAX_UNIT && (!rule.prose || readsAsProse(s));

/**
 * Walks a payload and hands every prose string to `visit`; a string `visit` returns replaces it in a copy. The input
 * is never changed, and a payload with nothing to replace comes back as the same object.
 */
function walk(value: unknown, rule: Rule, visit: (text: string) => string | undefined, key: string | null = null): unknown {
  if (typeof value === "string") {
    if (key == null || (rule.keys ? !rule.keys.has(key) : false) || !isText(value, rule)) return value;
    return visit(value) ?? value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map(item => { const next = walk(item, rule, visit, key); if (next !== item) changed = true; return next; });
    return changed ? out : value;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (rule.skipWhen?.(object)) return value;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(object)) {
      const next = rule.skip.has(k) ? v : walk(v, rule, visit, k);
      if (next !== v) changed = true;
      out[k] = next;
    }
    return changed ? out : value;
  }
  return value;
}

/** The English prose of a payload, each string once, in reading order. */
export function collectProse(resource: TranslatedResource, payload: unknown): string[] {
  const out = new Set<string>();
  walk(payload, RULES[resource], text => { out.add(text); return undefined; });
  return [...out];
}

/** The payload with every translated string replaced; untranslated strings, and everything that is not prose, as they were. */
export function localize<T>(resource: TranslatedResource, payload: T, table: TranslationTable | null | undefined): T {
  if (!table || !Object.keys(table).length) return payload;
  return walk(payload, RULES[resource], text => table[text]) as T;
}

const CJK = /[㐀-鿿豈-﫿]/;
/** The language a piece of generated text is in, for its `lang` attribute: Chinese once it carries Chinese characters. */
export const langOf = (text: string | null | undefined): Locale => text && CJK.test(text) ? "zh-CN" : "en";

const PLACEHOLDER = /\{(?:value|change|label|period)\}/g;
const placeholders = (s: string) => (s.match(PLACEHOLDER) ?? []).sort().join(",");
/** The outline of a multi-line text: headings, list items, table rows, display maths and blank lines, in order. */
const outline = (s: string) => s.split("\n").map(line => {
  const t = line.trim();
  return !t ? "" : /^#{1,6}\s/.test(t) ? t.match(/^#+/)![0] : /^[-*+]\s|^\d+\.\s/.test(t) ? "li" : t.startsWith("|") ? "tr" : t.startsWith("$$") ? "math" : "p";
}).join("/").replace(/(?:p\/)+p/g, "p");
const latinWords = (s: string) => (s.match(/[A-Za-z][A-Za-z'’-]{2,}/g) ?? []).map(w => w.toLowerCase());
const magnitudes = (s: string) => proseNumbers(s).map(Math.abs);

/**
 * Why a translation cannot stand for its English source, or nothing when it can: every figure still there with the
 * same value (Chinese units read through), the template placeholders and markdown outline unchanged, Chinese
 * actually written, and no English left in it beyond the names and terms the source itself carries.
 */
export function checkTranslation(source: string, target: string): string[] {
  const problems: string[] = [];
  if (!target.trim()) return ["empty"];
  if (placeholders(source) !== placeholders(target)) problems.push("placeholders changed");
  const from = magnitudes(source), to = magnitudes(target);
  const missing = from.filter(n => !numberSupported(n, to)), added = to.filter(n => !numberSupported(n, from));
  if (missing.length) problems.push(`figures missing: ${missing.join(", ")}`);
  if (added.length) problems.push(`figures added: ${added.join(", ")}`);
  if (source.includes("\n") && outline(source) !== outline(target)) problems.push("markdown outline changed");
  const words = latinWords(source);
  if (words.length >= 2 && !CJK.test(target)) problems.push("not translated");
  const kept = new Set(words), foreign = latinWords(target).filter(w => !kept.has(w));
  if (foreign.length) problems.push(`English not in the source: ${[...new Set(foreign)].slice(0, 5).join(", ")}`);
  if (/[!！]/.test(target) && !/!/.test(source)) problems.push("exclamation mark");
  if (target.length > source.length * 1.5 + 40) problems.push("longer than the source allows");
  return problems;
}
