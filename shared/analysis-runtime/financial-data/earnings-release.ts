import type { BusinessFlowQuarter, BusinessSegment, FlowAmount, FlowMetric } from "../../analysis-contract/business-flow.ts";
import { checkCompleteFlow } from "./completeness.ts";

/**
 * The quarter an earnings release (Form 8-K, Exhibit 99) reports, read before the quarterly report is filed.
 *
 * Nothing is inferred. The release's quarter takes the structure of the newest quarter already verified from a 10-Q
 * or 10-K: each of its figures is read from the release's income statement by the issuer's own printed label, in the
 * column dated one quarter later; its expense lines are the statement's own lines; its segments and revenue
 * adjustments are found together in one release table by the names the filings use, and must add up to revenue. The
 * pair is then held to the same completeness gate as any publication: every subtotal reconciles and every figure's
 * definition matches the previous quarter's. Where the release also shows the previous quarter, each line must repeat
 * its verified amount. A release that cannot be read this way yields no quarter, and the quarter waits for the 10-Q.
 */
export type ReleaseDocument = { url: string; html: string };
export type ReleaseSource = { accession: string; filedAt: string; parserVersion: string };
type Cell = { text: string; column: number; span: number };
/** A value column: a dated period, or a quarter code ("3Q26", "Q2 FY27") placed relative to the newest code. */
type Column = { months: number; end?: string; code?: number };
type Table = { index: number; url: string; rows: Cell[][]; scale: number; columns: Map<number, Column>; headerEnd: number };
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
  return code ? Number(code[2]!.length === 2 ? `20${code[2]}` : code[2]) * 4 + Number(code[1]) : null;
}

/** A column's period from every header cell above it. Change and ratio columns are not periods. */
function period(text: string): Column | null {
  const lower = text.toLowerCase();
  if (/\bchange\b|%|\bvs\.?\b|\byoy\b|\bq\/q\b|\by\/y\b/.test(lower)) return null;
  const code = quarterCode(text);
  if (code !== null) return { months: 3, code };
  const months = /\bthree months\b|\bquarters? ended\b|\b13 weeks\b/.test(lower) ? 3 : /\bsix months\b/.test(lower) ? 6 : /\bnine months\b/.test(lower) ? 9 : /\b(?:twelve months|year ended|fiscal year)\b/.test(lower) ? 12 : 0;
  const date = [...text.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s*(?:\S+\s+){0,3}?(20\d{2})\b/gi)].at(-1);
  if (!months || !date) return null;
  const month = MONTHS[date[1]!.toLowerCase()]!, day = Number(date[2]), year = Number(date[3]);
  return day >= 1 && day <= 31 ? { months, end: new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) } : null;
}

/** Every table with period columns and a stated unit, in filing order. */
export function releaseTables(documents: ReleaseDocument[]): Table[] {
  const tables: Table[] = [];
  for (const source of documents) {
    for (const match of source.html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
      const rows = grid(match[0]);
      const headerEnd = rows.findIndex(row => row.slice(1).some(c => numeric(c.text) !== null && !/^(?:19|20)\d{2}$/.test(c.text.trim())));
      if (headerEnd < 1) continue;
      // The unit the statement states nearest to it: "(In millions, except ... in thousands)" is in millions.
      const near = `${clean(source.html.slice(Math.max(0, match.index! - 6000), match.index)).slice(-400)} ${rows.slice(0, headerEnd).flat().map(c => c.text).join(" ")}`;
      const unit = near.match(/\bin (millions|thousands|billions)\b/i)?.[1]?.toLowerCase();
      if (!unit) continue;
      const scale = unit === "billions" ? 1e9 : unit === "millions" ? 1e6 : 1e3;
      const header = rows.slice(0, headerEnd);
      const leafRow = [...header].reverse().find(row => row.some(c => c.text && period(header.flatMap(r => r.filter(x => x.text && x.column <= c.column && c.column < x.column + x.span)).map(x => x.text).join(" "))));
      if (!leafRow) continue;
      const columns = new Map<number, Column>();
      for (const leaf of leafRow.filter(c => c.text)) {
        const resolved = period(header.flatMap(row => row.filter(c => c.text && c.column <= leaf.column && leaf.column < c.column + c.span)).map(c => c.text).join(" "));
        if (resolved) columns.set(leaf.column, resolved);
      }
      if (columns.size) tables.push({ index: tables.length, url: source.url, rows, scale, columns, headerEnd });
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
    const value = numeric(cell.text);
    if (value === null && !dash(cell.text)) continue;
    const leaf = leaves.filter(l => l <= cell.column).at(-1);
    if (leaf === undefined) continue;
    const next = starts.find(s => s > leaf);
    if (next !== undefined && cell.column >= next && !table.columns.has(next)) continue;
    const column = table.columns.get(leaf);
    if (!column || column.months !== 3 || column.end !== end) continue;
    return { value: value ?? 0, column: cell.column };
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
    // The full name is the words ending at the abbreviation whose initials start like it.
    for (let i = words.length - 1; i >= 0; i--) {
      const name = words.slice(i).join(" ").replace(/^(?:and|the|our)\s+/i, "");
      if (name[0]?.toUpperCase() === initials[0]) { if (!map.has(labelKey(m[2]!))) map.set(labelKey(m[2]!), name); break; }
    }
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
    else if (previous.incomeModel === "standard") figures.operatingExpenses = num(figures.gross) != null && num(figures.operating) != null
      ? derived(num(figures.gross)! - num(figures.operating)!, like, [figures.gross!, figures.operating!], "Release gross profit − release operating income (total operating expenses)") : undefined as never;
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
 * The previous quarter's segments and adjustments, found together in one release table by the names the filings
 * use (or the abbreviations the release defines for them) and summing to the release's revenue. A managed-basis
 * reconciling line the release does not print is the difference to reported revenue, stated as such. Segments that
 * cannot be found leave the quarter at whole-company level.
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
  if (previous.segments.some(s => s.children?.length)) return whole("RELEASE_SEGMENT_CHILDREN_UNSUPPORTED");
  const named = (a: string, b: string) => a === b || loose(a) === loose(b) || (!!defined.get(a) && loose(defined.get(a)!) === loose(b));
  const total = Number(revenue.value);
  for (const table of tables) {
    const found = previous.segments.map(s => find(table, [s.name], end, named));
    if (found.some(f => !f) || new Set(found.map(f => f!.row)).size !== found.length) continue;
    const segments = previous.segments.map((s, i) => ({ ...s, revenue: amountOf(found[i]!, s.revenue!, `segment:${s.id}`), sourceIds: [source.accession] }));
    const adjustments: NonNullable<BusinessFlowQuarter["revenueAdjustments"]> = [];
    let missing: { id: string; name: string; amount: FlowAmount } | null = null, complete = true;
    for (const a of previous.revenueAdjustments ?? []) {
      const bound = find(table, [a.name], end, named);
      if (bound) adjustments.push({ ...a, amount: amountOf(bound, a.amount, `adjustment:${a.id}`) });
      else if (a.id === "reconciling-items" && !missing) missing = a;
      else complete = false;
    }
    if (!complete) continue;
    const added = () => segments.reduce((n, s) => n + Number(s.revenue.value), 0) + adjustments.reduce((n, a) => n + Number(a.amount.value), 0);
    if (missing) adjustments.push({ ...missing, amount: derived(total - added(), missing.amount, [revenue, ...segments.map(s => s.revenue)], "Release reported revenue − the segments' managed revenue the release prints (reconciling items)") });
    if (Math.abs(added() - total) <= Math.max(1, Math.abs(total) * 1e-9)) return { segments, adjustments };
  }
  return whole("RELEASE_SEGMENTS_NOT_FOUND");
}
