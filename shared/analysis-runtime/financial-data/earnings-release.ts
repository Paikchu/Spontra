import type { RevenueHistoryQuarter } from "../../analysis-contract/revenue-history.ts";
import type { BusinessFlowQuarter, BusinessSegment, FlowAmount, FlowMetric } from "../../analysis-contract/business-flow.ts";
import { checkCompleteFlow } from "./completeness.ts";
import { omit } from "../omit.ts";

/**
 * The quarter an earnings release (Form 8-K, Exhibit 99) reports, read before the quarterly report is filed.
 *
 * Nothing is inferred. The release's quarter takes the structure of the newest quarter already verified from a 10-Q
 * or 10-K: each of its figures is read from the release's income statement by the issuer's own printed label, in the
 * column dated one quarter later; its expense lines are the statement's own lines; its segments and revenue
 * adjustments are found together in one release table by the names the filings use, and must add up to revenue. The
 * pair is then held to the same completeness gate as any publication: every subtotal reconciles and every figure's
 * definition matches the previous quarter's. Where the release also shows the previous quarter, each line must repeat
 * its verified amount. A segment row whose name changed is bound by that same prior-quarter amount. A release that
 * cannot be read this way yields no quarter, and the quarter waits for the 10-Q.
 */
export type ReleaseDocument = { url: string; html: string };
export type ReleaseSource = { accession: string; filedAt: string; parserVersion: string };
type Cell = { text: string; column: number; span: number };
/** A value column: a dated period, or a quarter code ("3Q26", "Q2 FY27") placed relative to the newest code. */
type Column = { months: number; end?: string; code?: number };
type Table = { title: string; index: number; url: string; rows: Cell[][]; scale: number; columns: Map<number, Column>; headerEnd: number };
type Bound = { value: number; table: Table; row: number; column: number };
type Line = { id: string; name: string; group: "direct" | "research" | "sales" | "administration" | "other"; amount: FlowAmount };

const MONTHS: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const clean = (value: string) => value.replace(/<[^>]*>/g, " ").replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_, hex, dec) => String.fromCodePoint(parseInt(hex ?? dec, hex ? 16 : 10)))
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&rsquo;|&lsquo;/gi, "'").replace(/&ldquo;|&rdquo;|&quot;/gi, '"')
  .replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim();
/** A printed label as compared: case, footnote markers, quotes, punctuation and "&" against "and" do not matter. */
export const labelKey = (label: string) => label.normalize("NFKC").toLowerCase().replace(/[“”"’']/g, "")
  .replace(/(?:\s*\((?:\d{1,2}|[a-z]{1,2})\))+\s*$/g, "").replace(/&/g, " and ").replace(/[^a-z0-9()/]+/g, " ").replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ").trim();
/** A business name without the words that only classify it ("segment", "family", "total"). */
const loose = (label: string) => labelKey(label).replace(/\b(?:and|the|total|segments?|family|families|group|business|net revenues?|revenues?)\b/g, "").replace(/[^a-z0-9]+/g, "");
const numeric = (text: string): number | null => {
  const raw = text.replace(/[$€£¥,\s]/g, "");
  if (!/^\(?[+-]?\d+(?:\.\d+)?\)?$/.test(raw)) return null;
  const value = Number(raw.replace(/[()+-]/g, ""));
  return raw.startsWith("(") || raw.startsWith("-") ? -value : value;
};
const dash = (text: string) => /^[—–-]+$/.test(text.trim());
const monthEnd = (date: string, add: number) => { const d = new Date(date); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1 + add, 0)).toISOString().slice(0, 10); };

function grid(table: string): Cell[][] {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row => {
    let column = 0;
    return [...row[1]!.matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map(cell => {
      const span = Math.max(1, Number(cell[1]!.match(/colspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1));
      const value = { text: clean(cell[2]!), column, span };
      column += span;
      return value;
    });
  });
}

/** A quarter code ("3Q26", "Q2 FY27") as a running quarter number, fiscal year × 4 + quarter; consecutive quarters differ by one. */
export function quarterCode(text: string): number | null {
  const code = text.match(/\b([1-4])Q\s?(\d{2})\b/i) ?? text.match(/\bQ([1-4])\s*(?:FY\s?)?['’]?(\d{4}|\d{2})\b/i);
  if (!code) {
    const ordinal = text.match(/\b(first|second|third|fourth) quarter\s+(?:of\s+)?(?:fiscal\s+)?(20\d{2})\b/i);
    if (ordinal) return Number(ordinal[2]) * 4 + ["first", "second", "third", "fourth"].indexOf(ordinal[1]!.toLowerCase()) + 1;
  }
  return code ? Number(code[2]!.length === 2 ? `20${code[2]}` : code[2]) * 4 + Number(code[1]) : null;
}

/** A column's period from every header cell above it. Change and ratio columns are not periods. */
function period(text: string): Column | null {
  const lower = text.toLowerCase();
  if (/non-gaap|as adjusted|\bchange\b|%|\bvs\.?\b|\byoy\b|\bq\/q\b|\by\/y\b/.test(lower)) return null;
  const code = quarterCode(text);
  if (code !== null) return { months: 3, code };
  const months = /\bthree months\b|\bquarters? ended\b|\b13 weeks\b/.test(lower) ? 3 : /\bsix months\b/.test(lower) ? 6 : /\bnine months\b/.test(lower) ? 9 : /\b(?:twelve months|year ended|fiscal year)\b/.test(lower) ? 12 : 0;
  const date = [...text.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s*(?:\S+\s+){0,3}?(20\d{2})\b/gi)].at(-1);
  if (!months || !date) return null;
  const month = MONTHS[date[1]!.toLowerCase()]!, day = Number(date[2]), year = Number(date[3]);
  return day >= 1 && day <= 31 ? { months, end: new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) } : null;
}

/** The newest quarter end explicitly dated by a release, within 120 days of filing. */
export function releasePeriodEnd(html: string, filedAt: string): string | undefined {
  const filed = Date.parse(filedAt);
  return clean(html).match(/\b(?:three\s+months|quarters?|fourth\s+quarter)\s+(?:and\s+fiscal\s+20\d{2},?\s+which\s+)?ended\s+(?:on\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+20\d{2}/gi)
    ?.map(text => { const [, name, day, year] = text.match(/(\w+)\s+(\d{1,2}),?\s+(20\d{2})$/)!; return new Date(Date.UTC(Number(year), MONTHS[name!.toLowerCase()]! - 1, Number(day))).toISOString().slice(0, 10); })
    .filter(end => Date.parse(end) <= filed && filed - Date.parse(end) <= 120 * 86400000).sort().at(-1);
}

/** Every table with period columns and a stated unit, in filing order. */
function releaseTables(documents: ReleaseDocument[]): Table[] {
  const tables: Table[] = [];
  for (const source of documents) {
    let previousScale: number | undefined;
    for (const match of source.html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
      const rows = grid(match[0]);
      const headerEnd = rows.findIndex(row => row.slice(1).some(c => numeric(c.text) !== null && !/^(?:19|20)\d{2}$/.test(c.text.trim())));
      if (headerEnd < 1) continue;
      // The unit the statement states nearest to it: "(In millions, except ... in thousands)" is in millions.
      const near = `${clean(source.html.slice(Math.max(0, match.index! - 6000), match.index)).slice(-400)} ${rows.slice(0, headerEnd).flat().map(c => c.text).join(" ")}`;
      const unit = near.match(/\bin (millions|thousands|billions)\b/i)?.[1]?.toLowerCase();
      const scale = unit ? unit === "billions" ? 1e9 : unit === "millions" ? 1e6 : 1e3 : previousScale;
      if (!scale) continue;
      previousScale = scale;
      const titleAt = [...near.matchAll(/(?:non-gaap\s+)?(?:condensed\s+)?consolidated\s+(?:condensed\s+)?statements?\s+of\s+(?:operations|income|earnings)|income statements?/gi)].at(-1)?.index;
      const title = titleAt === undefined ? near : near.slice(titleAt);
      const width = Math.max(...rows.flat().map(c => c.column + c.span));
      const header = rows.slice(0, headerEnd).map(row => {
        const printed = row.filter(c => c.text);
        return printed.map((c, i) => ({ ...c, span: Math.max(c.span, (printed[i + 1]?.column ?? width) - c.column) }));
      });
      const resolvedAt = (column: number) => period(header.flatMap(r => r.filter(x => x.text && x.column <= column && column < x.column + x.span)).map(x => x.text).join(" "));
      const leafRow = [...header].sort((a, b) => b.filter(c => resolvedAt(c.column)).length - a.filter(c => resolvedAt(c.column)).length)[0];
      if (!leafRow) continue;
      const columns = new Map<number, Column>();
      for (const leaf of leafRow.filter(c => c.text)) {
        const resolved = period(header.flatMap(row => row.filter(c => c.text && c.column <= leaf.column && leaf.column < c.column + c.span)).map(c => c.text).join(" "));
        if (resolved) columns.set(leaf.column, resolved);
      }
      if (columns.size) tables.push({ title, index: tables.length, url: source.url, rows, scale, columns, headerEnd });
    }
  }
  return tables;
}

/** Quarter codes, placed: the newest code in a table is the release quarter, the one before it the previous quarter. */
function placeCodes(tables: Table[], target: string, previousEnd: string) {
  for (const table of tables) {
    const codes = [...table.columns.values()].filter(c => c.code !== undefined);
    if (!codes.length) continue;
    const newest = Math.max(...codes.map(c => c.code!));
    for (const c of codes) c.end = c.code === newest ? target : c.code === newest - 1 ? previousEnd : undefined;
  }
}

/** A data row's value in the three-month column ending `end`, by the header leaf its value cell falls under. */
function valueAt(table: Table, row: Cell[], end: string): { value: number; column: number } | null {
  const leaves = [...table.columns.keys()].sort((a, b) => a - b);
  const starts = [...new Set(table.rows.slice(0, table.headerEnd).flat().filter(c => c.text).map(c => c.column))].sort((a, b) => a - b);
  for (const cell of row.slice(1)) {
    if (row.find(c => c.column === cell.column + cell.span)?.text === "%") continue;
    const value = numeric(cell.text);
    if (value === null && !dash(cell.text)) continue;
    const leaf = leaves.filter(l => l <= cell.column).at(-1);
    if (leaf === undefined) continue;
    const next = starts.find(s => s > leaf);
    if (next !== undefined && cell.column >= next && !table.columns.has(next)) continue;
    const column = table.columns.get(leaf);
    if (!column || column.months !== 3 || column.end !== end) continue;
    return { value: value !== null && value > 0 && row.find(c => c.column === cell.column + cell.span)?.text === ")" ? -value : value ?? 0, column: cell.column };
  }
  return null;
}

const FIGURE_LABELS = {
  revenue: ["total revenue", "total revenues", "revenue", "revenues", "total net revenue", "total net revenues", "net revenue", "net revenues", "total net sales", "net sales"],
  cost: ["total cost of revenue", "total cost of revenues", "cost of revenue", "cost of revenues", "total cost of sales", "cost of sales"],
  gross: ["gross margin", "gross profit"],
  operatingTotal: ["total operating expenses", "total costs and expenses", "costs and expenses", "total costs and operating expenses"],
  operating: ["operating income", "operating income (loss)", "operating loss", "income from operations", "income (loss) from operations", "loss from operations", "operating profit"],
  pretax: ["income before income taxes", "income (loss) before income taxes", "loss before income taxes", "income before provision for income taxes", "income before income tax", "income before income tax expense", "income before taxes", "income (loss) before provision for income taxes", "loss before provision for income taxes", "income/(loss) before income taxes", "net income/(loss) before income taxes"],
  tax: ["provision for income taxes", "income tax expense", "provision (benefit) for income taxes", "income tax expense (benefit)", "provision for (benefit from) income taxes", "benefit from income taxes", "income taxes", "(provision) benefit for income taxes", "income tax (expense) benefit", "income tax benefit"],
  net: ["net income", "net loss", "net income (loss)", "net (loss) income", "net income/(loss)"],
  noninterest: ["total noninterest expense", "noninterest expense"],
  provision: ["provision for credit losses", "provision for loan losses"],
} as const;
type Label = keyof typeof FIGURE_LABELS;
const COST = new Set<string>(FIGURE_LABELS.cost.map(labelKey));
const labelled = (row: Cell[]) => row.find(c => c.text)?.text ?? "";

/** The first row in a table printed with one of `labels` and a value in the target column. */
function find(table: Table, labels: readonly string[], end: string, same: (a: string, b: string) => boolean = (a, b) => a === b, from = 0, to = Infinity): Bound | null {
  const wanted = labels.map(labelKey);
  for (const [i, row] of table.rows.entries()) {
    if (i < Math.max(table.headerEnd, from) || i >= to) continue;
    const label = labelKey(labelled(row));
    if (!wanted.some(w => same(label, w))) continue;
    const at = valueAt(table, row, end);
    if (at) return { value: at.value, table, row: i, column: at.column };
  }
  return null;
}
/**
 * The rows printed between operating income and income before taxes in the release quarter's column, a dash read as
 * zero, each signed so all of them sum to `total` (pretax − operating, in the table's units): as printed when that
 * balances, else the one combination of signs that does. Several combinations, or none, give null. Zero rows are left out.
 */
function otherLines(statement: Table, operating: Bound | null, pretax: Bound | null, end: string, total: number): Array<{ value: number; row: number; column: number }> | null {
  if (!operating || !pretax || pretax.row <= operating.row) return null;
  const rows: Array<{ value: number; row: number; column: number }> = [];
  for (let i = operating.row + 1; i < pretax.row; i++) {
    const label = labelKey(labelled(statement.rows[i]!));
    if (!label || /^total\b/.test(label)) continue;
    const at = valueAt(statement, statement.rows[i]!, end);
    if (at) rows.push({ value: at.value, row: i, column: at.column });
  }
  const lines = rows.filter(r => r.value !== 0);
  if (!lines.length || lines.length > 8) return null;
  const tolerance = Math.max(1e-6, Math.abs(total) * 1e-9);
  const fits: number[][] = [];
  for (let mask = 0; mask < 1 << lines.length; mask++) {
    const signs = lines.map((_, i) => (mask >> i & 1 ? -1 : 1));
    if (Math.abs(lines.reduce((n, l, i) => n + signs[i]! * l.value, 0) - total) <= tolerance) fits.push(signs);
  }
  const chosen = fits.find(f => f.every(x => x === 1)) ?? (fits.length === 1 ? fits[0] : null);
  return chosen ? lines.map((l, i) => ({ ...l, value: chosen[i]! * l.value })) : null;
}
const group = (label: string): Line["group"] => /research and development/.test(label) ? "research"
  : /^(?:sales and marketing|marketing and sales|selling and marketing|selling|marketing)$/.test(label) ? "sales" : /^general and administrative$/.test(label) ? "administration" : "other";

/** Names the release defines for itself: `Architecture, Engineering, Construction, and Operations ("AECO")`. */
function abbreviations(documents: ReleaseDocument[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of documents) for (const m of clean(d.html).matchAll(/([A-Z][\w&,.' -]{2,90}?)\s*\(\s*"([A-Z][A-Za-z&]{1,9})"\s*\)/g)) {
    const words = m[1]!.split(/\s+/), initials = m[2]!.replace(/&/g, "").toUpperCase();
    let full: string | undefined;
    for (let i = words.length - 1; i >= 0; i--) {
      const name = words.slice(i).join(" ").replace(/^(?:and|the|our)\s+/i, "");
      const letters = name.split(/[^A-Za-z]+/).filter(w => w && !/^(?:and|the|of)$/i.test(w)).map(w => w[0]).join("").toUpperCase();
      if (letters === initials) { full = name; break; }
    }
    full ??= m[1]!.split(",").at(-1)!.trim().replace(/^(?:and|the|our)\s+/i, "");
    if (!map.has(labelKey(m[2]!))) map.set(labelKey(m[2]!), full);
  }
  return map;
}

/**
 * The release quarter after `previous`, or the reasons there is none. `previous` is the newest verified quarter; the
 * pair is checked as a publication would be.
 */
export function releaseQuarter(documents: ReleaseDocument[], previous: BusinessFlowQuarter, source: ReleaseSource): { quarter: BusinessFlowQuarter | null; issues: string[] } {
  const tables = releaseTables(documents);
  const prevEnd = Date.parse(previous.periodEnd);
  const next = (end: string) => { const gap = (Date.parse(end) - prevEnd) / 86_400_000; return gap >= 70 && gap <= 110; };
  const dated = [...new Set(tables.flatMap(t => [...t.columns.values()].filter(c => c.months === 3 && c.end && next(c.end)).map(c => c.end!)))].sort();
  if (dated.length > 1) return { quarter: null, issues: ["AMBIGUOUS_RELEASE_PERIOD"] };
  // A release dated only by quarter codes ends where the previous calendar quarter's month-end reaches.
  const coded = tables.some(t => [...t.columns.values()].some(c => c.code !== undefined));
  const end = dated[0] ?? (coded && previous.periodEnd === monthEnd(previous.periodEnd, 0) ? monthEnd(previous.periodEnd, 3) : null);
  if (!end) return { quarter: null, issues: ["NO_RELEASE_QUARTER"] };
  placeCodes(tables, end, previous.periodEnd);
  const statements = tables.filter(t => find(t, FIGURE_LABELS.net, end) && (find(t, FIGURE_LABELS.pretax, end) || find(t, FIGURE_LABELS.tax, end)) && find(t, FIGURE_LABELS.revenue, end));
  if (!statements.length) return { quarter: null, issues: ["NO_RELEASE_STATEMENT"] };
  const issues: string[] = [];
  // The fullest statement first: a summary table has the totals but not the lines.
  for (const statement of statements.sort((a, b) => b.rows.length - a.rows.length)) {
    const built = build(statement, tables, previous, source, end, abbreviations(documents));
    if (built.quarter) return built;
    issues.push(...built.issues);
  }
  return { quarter: null, issues: [...new Set(issues)] };
}

/** Revenue rows bound to a verified member name, either directly or inside that member's block. */
function segmentBounds(table: Table, names: string[], end: string, named: (a: string, b: string) => boolean): Bound[][] {
  const candidates = names.map(name => table.rows.flatMap((row, i) => {
    if (!named(labelKey(labelled(row)), labelKey(name))) return [];
    const direct = valueAt(table, row, end);
    if (direct) return [{ value: direct.value, table, row: i, column: direct.column }];
    const stop = table.rows.findIndex((r, j) => j > i && names.some(n => named(labelKey(labelled(r)), labelKey(n))));
    const bound = find(table, FIGURE_LABELS.revenue, end, undefined, i + 1, stop < 0 ? Infinity : stop);
    return bound ? [bound] : [];
  }));
  // Repeated names in revenue and operating-income sections are separate blocks, never mixed.
  const count = Math.min(...candidates.map(c => c.length));
  return Array.from({ length: count }, (_, i) => candidates.map(c => c[i]!));
}

const reconcilingLabel = (label: string) => /\b(?:hedging|eliminations?|reconciling)\b/i.test(label);

/** Enrich an independently verified revenue total. Only periodic-report names can authorize a release split. */
export function enrichReleaseHistory(documents: ReleaseDocument[], quarter: RevenueHistoryQuarter, verified: RevenueHistoryQuarter[]): RevenueHistoryQuarter {
  const tables = releaseTables(documents), end = quarter.periodEnd;
  const datedEnds = tables.flatMap(t => [...t.columns.values()].flatMap(c => c.months === 3 && c.end ? [c.end] : [])).sort();
  const latest = datedEnds.at(-1) ?? documents.map(d => releasePeriodEnd(d.html, quarter.source.filedAt)).filter((d): d is string => !!d).sort().at(-1) ?? end;
  for (const table of tables) {
    const codes = [...table.columns.values()].filter(c => c.code !== undefined);
    const newest = Math.max(...codes.map(c => c.code!));
    for (const c of codes) c.end = c.code === newest ? latest : latest === monthEnd(latest, 0) ? monthEnd(latest, (c.code! - newest) * 3) : undefined;
  }
  const source = { ...quarter.source, form: "8-K" }, start = quarter.periodStart;
  const lineage = (b: Bound, concept: string) => [{ accession: source.accession, url: b.table.url, concept: `release:${concept}`, contextId: `table-${b.table.index}:row-${b.row}:column-${b.column}`, periodStart: start, periodEnd: end, dimensions: {}, parserVersion: "release-history.v1" }];
  const sameRevenue = (b: Bound) => Math.abs(b.value * b.table.scale / quarter.scale - Number(quarter.revenue)) <= 1;
  const statements = tables.filter(t => /(?:statements? of (?:operations|income|earnings)|income statements?)(?! data)/i.test(t.title) && !/non-gaap|reconciliation of|income statement data/i.test(t.title) && find(t, FIGURE_LABELS.net, end) && (() => { const r = find(t, FIGURE_LABELS.revenue, end); return r && sameRevenue(r); })());
  const eps: Bound[] = [];
  for (const t of statements) {
    let perShare = false;
    for (const [i, row] of t.rows.entries()) {
      const label = labelKey(labelled(row));
      if (/per (?:common )?share|earnings per share/.test(label)) perShare = true;
      if (/weighted|shares used|number of shares|common shares|diluted shares/.test(label)) perShare = false;
      if (!/diluted/.test(label) || (!perShare && !/per share/.test(label)) || /shares|non gaap|adjusted/.test(label)) continue;
      const at = valueAt(t, row, end);
      if (at) eps.push({ ...at, table: t, row: i });
    }
  }
  let result: RevenueHistoryQuarter = { ...quarter, segments: [{id: "reported-company-total", name: "Total company (segment split not yet verified)", value: quarter.revenue, lineage: quarter.lineage}], revenueAdjustments: undefined };
  if (eps.length && new Set(eps.map(e => e.value)).size === 1) result.dilutedEps = { value: String(eps[0]!.value), basis: "reported", source: {...source, url: eps[0]!.table.url}, lineage: lineage(eps[0]!, "EarningsPerShareDiluted") };
  const anchors = verified.filter(q => q.source.form !== "8-K" && q.segments.length > 1).sort((a, b) => Math.abs(Date.parse(a.periodEnd) - Date.parse(end)) - Math.abs(Date.parse(b.periodEnd) - Date.parse(end)));
  const isBusiness = (s: RevenueHistoryQuarter["segments"][number]) => s.lineage?.some(l => Object.keys(l.dimensions).some(a => a.endsWith(":StatementBusinessSegmentsAxis")));
  const business = anchors.filter(q => q.segments.some(isBusiness) && q.segments.every(s => isBusiness(s)
    || (s.id === "corporate" && s.lineage?.some(l => Object.entries(l.dimensions).some(([a,m]) => a.endsWith(":ConsolidationItemsAxis") && m.endsWith(":CorporateNonSegmentMember"))))));
  const nearest = verified.filter(q => q.source.form !== "8-K").sort((a,b)=>Math.abs(Date.parse(a.periodEnd)-Date.parse(end))-Math.abs(Date.parse(b.periodEnd)-Date.parse(end)))[0];
  if (nearest?.segmentDisclosure === "single_reportable_segment") return {...result, segmentDisclosure: nearest.segmentDisclosure,
    segments: [{...result.segments[0]!, name: "Total company (single reportable segment)"}]};
  const anchor = business[0];
  if (!anchor) return result;
  const defined = abbreviations(documents);
  const named = (a: string, b: string) => loose(defined.get(a) ?? a) === loose(defined.get(b) ?? b);
  const successes: RevenueHistoryQuarter[] = [];
  for (const table of tables) for (const found of segmentBounds(table, anchor.segments.map(s => s.name), end, named)) {
    const segments = found.map((b, i) => ({ id: anchor.segments[i]!.id, name: anchor.segments[i]!.name, value: String(b.value * table.scale / quarter.scale), lineage: lineage(b, `segment:${anchor.segments[i]!.id}`) }));
    if (segments.some(s => Number(s.value) < 0)) continue;
    const from = Math.min(...found.map(b => b.row)), last = Math.max(...found.map(b => b.row));
    const stop = table.rows.findIndex((r, i) => i > last && (/^(?:total (?:net )?(?:sales|revenues?)|(?:segment )?operating (?:income|loss))/i.test(labelled(r))));
    const adjustments = table.rows.flatMap((r, i) => {
      if (i < from || (stop >= 0 && i >= stop) || !reconcilingLabel(labelled(r))) return [];
      const at = valueAt(table, r, end); if (!at) return [];
      return [{ id: `release-adjustment-${i}`, name: labelled(r), value: String(at.value * table.scale / quarter.scale), basis: "reported" as const, lineage: lineage({ ...at, table, row: i }, "revenue-adjustment") }];
    });
    const sum = [...segments, ...adjustments].reduce((n, s) => n + Number(s.value), 0);
    if (Math.abs(sum - Number(quarter.revenue)) <= 1) successes.push({ ...result, segments, revenueAdjustments: adjustments });
  }
  const distinct = [...new Map(successes.map(q => [JSON.stringify([q.segments.map(s => s.value), q.revenueAdjustments?.map(a => a.value)]), q])).values()];
  if (distinct.length === 1) result = distinct[0]!;
  return result;
}

function build(statement: Table, tables: Table[], previous: BusinessFlowQuarter, source: ReleaseSource, end: string, defined: Map<string, string>): { quarter: BusinessFlowQuarter | null; issues: string[] } {
  const scale = previous.scale, start = new Date(Date.parse(previous.periodEnd) + 86_400_000).toISOString().slice(0, 10);
  const amountOf = (bound: Bound, like: FlowAmount, concept: string): FlowAmount => ({
    value: String(Math.round(bound.value * bound.table.scale / scale)), basis: "reported", definition: like.definition, comparabilityKey: like.comparabilityKey,
    sourceIds: [source.accession], lineage: [{ accession: source.accession, url: bound.table.url, concept: `release:${concept}`, contextId: `table-${bound.table.index}:row-${bound.row}:column-${bound.column}`,
      periodStart: start, periodEnd: end, dimensions: {}, parserVersion: source.parserVersion }],
  });
  const derived = (value: number, like: FlowAmount, terms: FlowAmount[], formula: string): FlowAmount => ({
    value: String(value), basis: "derived", definition: like.definition, comparabilityKey: like.comparabilityKey, sourceIds: [source.accession], formula, lineage: terms.flatMap(t => t.lineage ?? []).slice(0, 50),
  });
  const num = (a: FlowAmount | undefined) => (a?.value == null ? null : Number(a.value));
  const rows = Object.fromEntries((Object.keys(FIGURE_LABELS) as Label[]).map(k => [k, find(statement, FIGURE_LABELS[k], end)])) as Record<Label, Bound | null>;
  const figures: BusinessFlowQuarter["figures"] = {};
  const take = (key: FlowMetric, bound: Bound | null) => { if (bound && previous.figures[key]) figures[key] = amountOf(bound, previous.figures[key]!, key); };
  for (const key of ["revenue", "cost", "gross", "operating", "pretax", "net"] as const) take(key, rows[key]);
  // Lines the statement places after income taxes (equity-method results, noncontrolling interests), by their labels.
  const afterTaxComponents: NonNullable<BusinessFlowQuarter["afterTaxComponents"]> = [];
  for (const c of previous.afterTaxComponents ?? []) {
    const bound = find(statement, [c.name], end, undefined, rows.tax?.row ?? rows.pretax?.row ?? 0, rows.net?.row ?? Infinity);
    if (!bound) return { quarter: null, issues: [`RELEASE_LINE_MISSING:${c.name}`] };
    afterTaxComponents.push({ ...c, amount: amountOf(bound, c.amount, `after-tax:${c.id}`) });
  }
  // A tax line printed as a negative charge is the same expense: the sign that closes pretax − tax + after-tax lines = net is the one.
  if (rows.tax && figures.pretax && figures.net && previous.figures.tax) {
    const tax = amountOf(rows.tax, previous.figures.tax, "tax"), value = Number(tax.value), net = num(figures.net)!;
    const pretax = num(figures.pretax)! + afterTaxComponents.reduce((n, c) => n + Number(c.amount.value), 0);
    figures.tax = Math.abs(pretax - value - net) <= Math.abs(pretax + value - net) ? tax : { ...tax, value: String(-value) };
  }
  if (previous.figures.gross && !figures.gross && num(figures.revenue) != null && num(figures.cost) != null)
    figures.gross = derived(num(figures.revenue)! - num(figures.cost)!, previous.figures.gross, [figures.revenue!, figures.cost!], "Release revenue − release cost of revenue");

  // Expense lines.
  const expenseComponents: Line[] = [];
  if (previous.incomeModel === "financial") {
    for (const c of previous.expenseComponents ?? []) {
      const bound = c.id === "noninterest-expense" ? rows.noninterest : c.id === "credit-loss-provision" ? rows.provision : find(statement, [c.name], end);
      if (!bound) return { quarter: null, issues: [`RELEASE_LINE_MISSING:${c.name}`] };
      expenseComponents.push({ ...c, amount: amountOf(bound, c.amount, `expense:${c.id}`) });
    }
  } else if (previous.incomeModel === "standard") {
    // The statement's own operating expense lines: after gross profit (or revenue), before the total or operating income;
    // cost of revenue lines listed among them belong to cost, not to operating expenses.
    const from = (rows.gross ?? rows.revenue)?.row ?? statement.headerEnd, to = Math.min(...[rows.operatingTotal?.row, rows.operating?.row].filter((r): r is number => r !== undefined && r > from));
    const known = new Map((previous.expenseComponents ?? []).map(c => [labelKey(c.name), c]));
    const seen = new Map<string, number>();
    for (let i = from + 1; i < to; i++) {
      const label = labelKey(labelled(statement.rows[i]!));
      if (!label || COST.has(label) || /^total\b/.test(label)) continue;
      const at = valueAt(statement, statement.rows[i]!, end);
      if (!at || at.value === 0) continue;
      const like = known.get(label), base = like?.id ?? `release-${label.replace(/[^a-z0-9]+/g, "-")}`, count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      const amount = amountOf({ value: at.value, table: statement, row: i, column: at.column }, like?.amount ?? previous.figures.operatingExpenses ?? previous.figures.revenue!, `expense:${label}`);
      expenseComponents.push({ id: count > 1 ? `${base}~${count}` : base, name: like?.name ?? labelled(statement.rows[i]!).replace(/\s*(?:\(\d{1,2}\))+\s*$/, ""), group: like?.group ?? group(label), amount: like ? amount : { ...amount, comparabilityKey: null } });
    }
  } else {
    for (const c of previous.expenseComponents ?? []) {
      const bound = /^reported-(?:costs-and-expenses|expense-total)$/.test(c.id) ? rows.operatingTotal : find(statement, [c.name], end);
      if (!bound) return { quarter: null, issues: [`RELEASE_LINE_MISSING:${c.name}`] };
      expenseComponents.push({ ...c, amount: amountOf(bound, c.amount, `expense:${c.id}`) });
    }
  }
  const sum = (list: Array<{ amount: FlowAmount }>) => list.reduce((n, c) => n + Number(c.amount.value), 0);
  if (previous.figures.operatingExpenses) {
    const like = previous.figures.operatingExpenses;
    if (previous.incomeModel === "financial") figures.operatingExpenses = derived(sum(expenseComponents), like, expenseComponents.map(c => c.amount), "Release noninterest expense + release provision for credit losses");
    else if (previous.incomeModel === "standard") {
      if (num(figures.gross) != null && num(figures.operating) != null)
        figures.operatingExpenses = derived(num(figures.gross)! - num(figures.operating)!, like, [figures.gross!, figures.operating!], "Release gross profit − release operating income (total operating expenses)");
    }
    else if (rows.operatingTotal) figures.operatingExpenses = amountOf(rows.operatingTotal, like, "operatingExpenses");
  }
  if (previous.figures.other && num(figures.pretax) != null && num(figures.operating) != null)
    figures.other = derived(num(figures.pretax)! - num(figures.operating)!, previous.figures.other, [figures.pretax!, figures.operating!], "Release income before income taxes − release operating income (signed other income, net)");
  // Lines between operating income and income before taxes: the statement's own rows, signed so they close
  // pretax = operating + Σ line, the way the filings' arithmetic signs them; else one derived total.
  let otherComponents: NonNullable<BusinessFlowQuarter["otherComponents"]> = [];
  if (previous.otherComponents && figures.other) {
    const lines = previous.incomeModel === "standard" || previous.incomeModel === "direct_operating" ? otherLines(statement, rows.operating, rows.pretax, end, Number(figures.other.value) * scale / statement.scale) : null;
    if (lines?.length) {
      const known = new Map(previous.otherComponents.map(c => [labelKey(c.name), c]));
      const seen = new Map<string, number>();
      otherComponents = lines.map(l => {
        const label = labelKey(labelled(statement.rows[l.row]!)), like = known.get(label), base = like?.id ?? `release-${label.replace(/[^a-z0-9]+/g, "-")}`, count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        const amount = amountOf({ value: l.value, table: statement, row: l.row, column: l.column }, like?.amount ?? previous.figures.other!, `other:${label}`);
        return { id: count > 1 ? `${base}~${count}` : base, name: like?.name ?? labelled(statement.rows[l.row]!).replace(/\s*(?:\(\d{1,2}\))+\s*$/, ""), amount: like ? amount : { ...amount, comparabilityKey: null } };
      });
    } else {
      const lump = previous.otherComponents.find(c => c.id === "reported-net-other");
      otherComponents = [{ id: "reported-net-other", name: "Other income (expense), net", amount: { ...figures.other, definition: lump?.amount.definition ?? figures.other.definition, comparabilityKey: lump?.amount.comparabilityKey ?? figures.other.comparabilityKey } }];
    }
  }
  for (const key of ["research", "sales", "administration"] as const) {
    if (!previous.figures[key]) continue;
    const lines = expenseComponents.filter(c => c.group === key);
    if (lines.length === 1) figures[key] = { ...lines[0]!.amount, definition: previous.figures[key]!.definition, comparabilityKey: previous.figures[key]!.comparabilityKey };
  }
  for (const key of Object.keys(previous.figures) as FlowMetric[]) if (!figures[key]) return { quarter: null, issues: [`RELEASE_FIGURE_MISSING:${key}`] };

  // Where the release also shows the previous quarter, every bound line repeats its verified amount.
  for (const key of Object.keys(previous.figures) as FlowMetric[]) {
    const lineage = figures[key]!.lineage?.[0], known = num(previous.figures[key]);
    if (figures[key]!.basis !== "reported" || !lineage || known == null) continue;
    const then = valueAt(statement, statement.rows[Number(lineage.contextId.match(/row-(\d+)/)![1])]!, previous.periodEnd);
    if (!then) continue;
    const shown = Math.round(then.value * statement.scale / scale), tolerance = statement.scale / scale / 2 + 1;
    if (Math.abs(shown - known) > tolerance && !(key === "tax" && Math.abs(shown + known) <= tolerance)) return { quarter: null, issues: [`RELEASE_PRIOR_QUARTER_MISMATCH:${key}`] };
  }

  const split = releaseSegments(tables, previous, figures.revenue!, end, source, amountOf, derived, defined);
  const quarter: BusinessFlowQuarter = {
    ...previous, id: end, label: `Three months ended ${end}`, periodStart: start, periodEnd: end, reportedAt: source.filedAt,
    basisLabel: "Earnings release (Form 8-K, Exhibit 99) · each line read by its printed label and checked against the release's totals · replaced by the quarterly report when it is filed",
    figures, segments: split.segments, segmentsComplete: true,
    sources: [{ id: source.accession, title: `Earnings release (Form 8-K) ${source.accession}`, url: statement.url, publishedAt: source.filedAt }],
  };
  delete quarter.revenueBreakdowns; delete quarter.revenueAdjustments; delete quarter.expenseComponents; delete quarter.otherComponents; delete quarter.segmentDisclosure;
  delete quarter.afterTaxComponents; delete quarter.basisChanges;
  if (previous.afterTaxComponents) quarter.afterTaxComponents = afterTaxComponents;
  if (previous.segmentDisclosure && split.segments[0]?.id === previous.segments[0]?.id) quarter.segmentDisclosure = previous.segmentDisclosure;
  if (split.adjustments.length) quarter.revenueAdjustments = split.adjustments;
  if (previous.expenseComponents) quarter.expenseComponents = expenseComponents;
  if (previous.otherComponents) quarter.otherComponents = otherComponents;
  const check = checkCompleteFlow({ schemaVersion: "business-flow.v1", ticker: "RELEASE", fetchedAt: null, quarters: [quarter, previous] });
  return check.complete ? { quarter, issues: split.issue ? [split.issue] : [] } : { quarter: null, issues: check.reasons.map(r => `RELEASE_${r}`) };
}

/**
 * The previous quarter's segments and adjustments, found together in one release table and summing to the release's
 * revenue. Rows are bound by the names the filings use (or the abbreviations the release defines). When a name is
 * gone, the prior-quarter column of one contiguous block binds each row back to the verified segment it still equals,
 * within half a printed unit. That block must have one row per segment, the pairing must be the only one, and its
 * current amounts must add up to revenue. An ambiguous pairing, a split or a merge, or a block that does not add up
 * is left unbound and named. A managed-basis reconciling line the release does not print is the difference to reported
 * revenue, stated as such. Segments that cannot be found leave the quarter at whole-company level.
 */
function releaseSegments(tables: Table[], previous: BusinessFlowQuarter, revenue: FlowAmount, end: string, source: ReleaseSource,
  amountOf: (b: Bound, like: FlowAmount, concept: string) => FlowAmount, derived: (v: number, like: FlowAmount, terms: FlowAmount[], f: string) => FlowAmount, defined: Map<string, string>):
  { segments: BusinessSegment[]; adjustments: NonNullable<BusinessFlowQuarter["revenueAdjustments"]>; issue?: string } {
  const only = previous.segments[0];
  // One segment that is the whole company carries the release's revenue as it is.
  if (previous.segments.length === 1 && only && (only.id === "reported-company-total" || previous.segmentDisclosure === "single_reportable_segment" || only.revenue?.value === previous.figures.revenue?.value)) {
    return { segments: [{ ...only, revenue: { ...revenue, definition: only.revenue?.definition ?? revenue.definition, comparabilityKey: only.revenue?.comparabilityKey ?? null }, sourceIds: [source.accession] }], adjustments: [] };
  }
  const whole = (issue: string) => ({ issue, adjustments: [], segments: [{ id: "reported-company-total", name: "Total company (segment split not yet verified)", revenue, description: "Consolidated amounts from the earnings release; the segment split follows with the quarterly report.", products: [], customers: null, monetization: null, disclosure: "Segment split not yet verified; only consolidated amounts are shown, with no segment shares allocated.", sourceIds: [source.accession] }] });
  const named = (a: string, b: string) => a === b || loose(a) === loose(b) || (!!defined.get(a) && loose(defined.get(a)!) === loose(b));
  const total = Number(revenue.value);
  const foots = (added: number) => Math.abs(added - total) <= Math.max(1, Math.abs(total) * 1e-9);
  // Names and prior-quarter amounts share one assembly: parts stay between the bound rows, and a reconciling line
  // the release omits is still the residual. `sum` means the rows were identified and do not add up to revenue.
  const assemble = (table: Table, found: Bound[]): { segments: BusinessSegment[]; adjustments: NonNullable<BusinessFlowQuarter["revenueAdjustments"]> } | "incomplete" | "sum" => {
    const rows = found.map(f => f.row).sort((a, b) => a - b);
    const parts = (s: BusinessSegment, at: Bound) => {
      if (!s.children?.length) return undefined;
      const from = (rows.filter(r => r < at.row).at(-1) ?? -1) + 1, to = rows.find(r => r > at.row) ?? Infinity;
      const bound = s.children.map(c => find(table, [c.name], end, named, from, to));
      if (bound.some(b => !b || b.row === at.row) || new Set(bound.map(b => b!.row)).size !== bound.length || bound.reduce((n, b) => n + b!.value, 0) !== at.value) return undefined;
      return s.children.map((c, i) => ({ ...c, revenue: amountOf(bound[i]!, c.revenue, `segment:${c.id}`) }));
    };
    const segments = previous.segments.map((s, i) => {
      const rest = omit(s, "children"), children = parts(s, found[i]!);
      return { ...rest, revenue: amountOf(found[i]!, s.revenue!, `segment:${s.id}`), sourceIds: [source.accession], ...(children ? { children } : {}) };
    });
    const adjustments: NonNullable<BusinessFlowQuarter["revenueAdjustments"]> = [];
    let missing: { id: string; name: string; amount: FlowAmount } | null = null, complete = true;
    for (const a of previous.revenueAdjustments ?? []) {
      const bound = find(table, [a.name], end, named);
      if (bound) adjustments.push({ ...a, amount: amountOf(bound, a.amount, `adjustment:${a.id}`) });
      else if (a.id === "reconciling-items" && !missing) missing = a;
      else complete = false;
    }
    const last = Math.max(...rows), stop = table.rows.findIndex((r, i) => i > last && /^(?:total (?:net )?(?:sales|revenues?)|(?:segment )?operating (?:income|loss))/i.test(labelled(r)));
    for (let i = Math.min(...rows); i < (stop < 0 ? table.rows.length : stop); i++) {
      const label = labelled(table.rows[i]!);
      if (!reconcilingLabel(label) || adjustments.some(a => named(labelKey(a.name), labelKey(label)))) continue;
      const at = valueAt(table, table.rows[i]!, end);
      if (at) adjustments.push({ id: `release-adjustment-${i}`, name: label, amount: amountOf({ ...at, table, row: i }, revenue, "revenue-adjustment") });
    }
    if (!complete) return "incomplete";
    const added = () => segments.reduce((n, s) => n + Number(s.revenue.value), 0) + adjustments.reduce((n, a) => n + Number(a.amount.value), 0);
    if (missing) adjustments.push({ ...missing, amount: derived(total - added(), missing.amount, [revenue, ...segments.map(s => s.revenue)], "Release reported revenue − the segments' managed revenue the release prints (reconciling items)") });
    return foots(added()) ? { segments, adjustments } : "sum";
  };
  const failures = ["RELEASE_SEGMENT_MATCH_AMBIGUOUS", "RELEASE_SEGMENT_COUNT_CHANGED", "RELEASE_SEGMENT_SUM_MISMATCH"];
  let failure: string | undefined;
  const note = (issue: string) => { if (!failure || failures.indexOf(issue) < failures.indexOf(failure)) failure = issue; };
  const successes: Array<{ segments: BusinessSegment[]; adjustments: NonNullable<BusinessFlowQuarter["revenueAdjustments"]> }> = [];
  const signature = (built: (typeof successes)[number]) => JSON.stringify({
    segments: built.segments.map(s => [s.id, s.revenue?.value, (s.children ?? []).map(c => [c.id, c.revenue.value])]),
    adjustments: built.adjustments.map(a => [a.id, a.amount.value]),
  });
  for (const table of tables) {
    for (const found of segmentBounds(table, previous.segments.map(s => s.name), end, named)) {
      const built = assemble(table, found as Bound[]);
      // Names that add up to revenue are the filing's own split. Old names reprinted under another section
      // (operating income below the revenue block) do not add up, so the prior-quarter block is still tried.
      if (typeof built !== "string") return built;
    }
    for (const outcome of priorQuarterBlocks(table, previous, end, named, total)) {
      if (outcome.kind === "bind") {
        const built = assemble(table, outcome.bounds);
        if (typeof built !== "string") successes.push(built);
        else if (built === "sum") note("RELEASE_SEGMENT_SUM_MISMATCH");
      } else note(outcome.issue);
    }
  }
  const distinct = [...new Map(successes.map(built => [signature(built), built])).values()];
  if (distinct.length === 1) return distinct[0]!;
  if (distinct.length > 1) return whole("RELEASE_SEGMENT_MATCH_AMBIGUOUS");
  return whole(failure ?? "RELEASE_SEGMENTS_NOT_FOUND");
}

/**
 * Contiguous blocks in one table whose prior-quarter column still adds up to the verified segments. A block is a
 * bind only when it has one row per segment and exactly one pairing within half a printed unit. A different row
 * count that still adds up, this quarter and last, is a split or a merge. The same count with no single pairing
 * is ambiguous. Consolidated total rows break a block; they are not segments.
 */
function priorQuarterBlocks(table: Table, previous: BusinessFlowQuarter, end: string, named: (a: string, b: string) => boolean, total: number):
  Array<{ kind: "bind"; bounds: Bound[] } | { kind: "issue"; issue: string }> {
  const priorEnd = previous.periodEnd;
  if (![...table.columns.values()].some(c => c.months === 3 && c.end === priorEnd)) return [];
  const known = previous.segments.map(s => Number(s.revenue?.value));
  if (known.some(n => !Number.isFinite(n))) return [];
  const segmentSum = known.reduce((sum, n) => sum + n, 0);
  const scaled = (printed: number) => Math.round(printed * table.scale / previous.scale);
  const tolerance = table.scale / previous.scale / 2 + 1;
  const revenueLabels = new Set(FIGURE_LABELS.revenue.map(labelKey));
  type Item = { row: number; current: number; prior: number; column: number };
  const runs: Item[][] = [];
  let run: Item[] = [];
  const flush = () => { if (run.length) runs.push(run); run = []; };
  for (let i = table.headerEnd; i < table.rows.length; i++) {
    const row = table.rows[i]!, label = labelKey(labelled(row));
    const current = valueAt(table, row, end), prior = valueAt(table, row, priorEnd);
    const namesSegment = !!label && previous.segments.some(s => named(labelKey(s.name), label));
    const consolidated = !label || (!namesSegment && (/^total\b/.test(label) || revenueLabels.has(label)));
    if (consolidated || !current || !prior) { flush(); continue; }
    run.push({ row: i, current: current.value, prior: prior.value, column: current.column });
  }
  flush();
  const outcomes: Array<{ kind: "bind"; bounds: Bound[] } | { kind: "issue"; issue: string }> = [];
  for (const items of runs) {
    for (let from = 0; from < items.length; from++) for (let to = from + 1; to <= items.length; to++) {
      const block = items.slice(from, to);
      const priorSum = block.reduce((sum, item) => sum + scaled(item.prior), 0);
      if (Math.abs(priorSum - segmentSum) > block.length * tolerance) continue;
      const currentSum = block.reduce((sum, item) => sum + scaled(item.current), 0);
      const currentFoots = Math.abs(currentSum - total) <= Math.max(1, Math.abs(total) * 1e-9);
      if (block.length !== known.length) {
        if (currentFoots) outcomes.push({ kind: "issue", issue: "RELEASE_SEGMENT_COUNT_CHANGED" });
        continue;
      }
      const assigned = uniqueAmountAssignment(known, block.map(item => scaled(item.prior)), tolerance);
      if (assigned === "none" || assigned === "many") {
        if (currentFoots) outcomes.push({ kind: "issue", issue: "RELEASE_SEGMENT_MATCH_AMBIGUOUS" });
        continue;
      }
      outcomes.push({ kind: "bind", bounds: assigned.map(index => ({ value: block[index]!.current, table, row: block[index]!.row, column: block[index]!.column })) });
    }
  }
  return outcomes;
}

/** The only pairing of verified amounts to printed amounts within `tolerance`, or why there is not exactly one. */
function uniqueAmountAssignment(known: number[], shown: number[], tolerance: number): number[] | "none" | "many" {
  const edges = known.map(amount => shown.flatMap((value, index) => Math.abs(value - amount) <= tolerance ? [index] : []));
  const used = shown.map(() => false), match: number[] = [], first: number[] = [];
  let found = 0;
  const walk = (segment: number) => {
    if (found > 1) return;
    if (segment === known.length) { found++; if (found === 1) first.push(...match); return; }
    for (const row of edges[segment]!) {
      if (used[row]) continue;
      used[row] = true; match[segment] = row; walk(segment + 1); used[row] = false;
      if (found > 1) return;
    }
  };
  walk(0);
  return found === 1 ? first : found === 0 ? "none" : "many";
}
