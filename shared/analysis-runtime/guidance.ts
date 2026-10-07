import { z } from "zod";
import type {
  GuidanceAction, GuidanceBasis, GuidanceDirection, GuidanceForm, GuidanceHorizon, GuidanceItem, GuidanceMaterialKind,
  GuidanceMeasure, GuidanceMetric, GuidancePublication, GuidanceUnit,
} from "../analysis-contract/guidance.ts";

const METRICS = ["revenue", "segment_revenue", "gross_margin", "operating_margin", "operating_income", "eps", "free_cash_flow", "operating_cash_flow", "capex", "rpo", "billings", "other"] as const;
const MEASURES = ["amount", "growth", "margin", "per_share"] as const;
const BASES = ["gaap", "non_gaap", "constant_currency", "unspecified"] as const;
const HORIZONS = ["quarter", "annual", "long_term"] as const;
const FORMS = ["range", "point", "floor", "ceiling", "qualitative"] as const;
const UNITS = ["USD", "percent", "USD_per_share"] as const;
const DIRECTIONS = ["up", "down", "flat"] as const;
const ACTIONS = ["initiated", "raised", "lowered", "reaffirmed", "narrowed", "widened", "updated"] as const;
const KINDS = ["press_release", "shareholder_letter", "deck", "transcript"] as const;

/** Model output, read leniently: anything unrecognised becomes null and is then rejected by verification. */
const loose = <T extends readonly string[]>(values: T) => z.unknown().transform(v => (typeof v === "string" && (values as readonly string[]).includes(v.trim()) ? v.trim() : null) as T[number] | null);
const num = z.unknown().transform(v => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/,/g, "")) : NaN;
  return Number.isFinite(n) ? n : null;
});
const str = (max: number) => z.unknown().transform(v => typeof v === "string" ? v.trim().slice(0, max) : "");
const extractedItemSchema = z.object({
  metric: loose(METRICS), measure: loose(MEASURES), segment: z.unknown().transform(v => typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null),
  label: str(160), basis: loose(BASES), horizon: loose(HORIZONS), form: loose(FORMS),
  fiscalYear: num, fiscalQuarter: num, unit: loose(UNITS), currency: str(8), low: num, high: num,
  direction: loose(DIRECTIONS), text: str(300), quote: str(700),
});
export type ExtractedGuidance = z.infer<typeof extractedItemSchema>;

export function readExtractedGuidance(value: unknown): ExtractedGuidance[] {
  const items = value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items) ? (value as { items: unknown[] }).items : [];
  return items.slice(0, 60).flatMap(item => { const parsed = extractedItemSchema.safeParse(item); return parsed.success ? [parsed.data] : []; });
}

/** Case, whitespace, typographic quotes and dashes differ between HTML, PDF text and transcripts. */
export function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase()
    .replace(/[‘’‛′]/g, "'").replace(/[“”‟″]/g, "\"")
    .replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim();
}

function quoteInSource(quote: string, source: string): boolean {
  // Models shorten long passages with an ellipsis; each kept piece must still be verbatim and in order.
  const pieces = normalizeForMatch(quote).split(/\s*(?:\.\.\.|…)\s*/).filter(Boolean);
  if (!pieces.length || pieces.join("").length < 12) return false;
  let from = 0;
  for (const piece of pieces) {
    const at = source.indexOf(piece, from);
    if (at < 0) return false;
    from = at + piece.length;
  }
  return true;
}

const SCALE: Record<string, number> = { trillion: 1e12, billion: 1e9, million: 1e6, thousand: 1e3, t: 1e12, b: 1e9, bn: 1e9, m: 1e6, mm: 1e6, k: 1e3 };
const NUMBER = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(%|percent\b|basis points?\b|bps\b|trillion\b|billion\b|million\b|thousand\b|bn\b|mm\b|[tbmk]\b)?/gi;

/**
 * Every value a quote can be read as. A scale word also applies to an earlier bare number in the
 * same range ("$15.0 to $15.2 billion"), and basis points read as percentage points.
 */
export function quoteNumbers(quote: string): number[] {
  const text = quote.normalize("NFKC");
  const found = [...text.matchAll(NUMBER)].map(m => ({ value: Number(`${m[1].replace(/,/g, "")}${m[2] ? `.${m[2]}` : ""}`), suffix: (m[3] ?? "").toLowerCase(), start: m.index!, end: m.index! + m[0].length }));
  const values: number[] = [];
  found.forEach((current, index) => {
    values.push(current.value);
    let suffix = current.suffix;
    const next = found[index + 1];
    if (!suffix && next?.suffix && /^\s*(?:to|-|–|—|and|or)\s*\$?\s*$/i.test(text.slice(current.end, next.start))) suffix = next.suffix;
    if (SCALE[suffix]) values.push(current.value * SCALE[suffix]);
    if (/^(basis|bps)/.test(suffix)) values.push(current.value / 100);
  });
  return values;
}

const near = (a: number, b: number, unit: GuidanceUnit | null) => unit === "USD"
  ? Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-3)
  : Math.abs(a - b) <= 1e-6;

export type VerifiedGuidance = {
  metric: GuidanceMetric; measure: GuidanceMeasure; segment: string | null; label: string; basis: GuidanceBasis;
  horizon: GuidanceHorizon; form: GuidanceForm; fiscalYear: number | null; fiscalQuarter: 1 | 2 | 3 | 4 | null;
  unit: GuidanceUnit | null; low: number | null; high: number | null; direction: GuidanceDirection | null; text: string; quote: string;
};

/**
 * Deterministic acceptance for one extracted item. A rejected item never reaches the publication;
 * its issues go back to the model once as a repair request.
 */
export function verifyGuidance(item: ExtractedGuidance, normalizedSource: string): { item: VerifiedGuidance | null; issues: string[] } {
  const issues: string[] = [];
  if (!item.metric) issues.push("metric is not one of the allowed values");
  if (!item.measure) issues.push("measure is not one of the allowed values");
  if (!item.horizon) issues.push("horizon is not one of the allowed values");
  if (!item.form) issues.push("form is not one of the allowed values");
  if (!item.text) issues.push("text is empty");
  if (!item.quote || !quoteInSource(item.quote, normalizedSource)) issues.push("quote is not verbatim from the source");
  if (item.currency && item.currency.toUpperCase() !== "USD" && item.unit !== "percent") issues.push("only USD guidance is supported");
  const fiscalQuarter = item.fiscalQuarter && [1, 2, 3, 4].includes(item.fiscalQuarter) ? item.fiscalQuarter as 1 | 2 | 3 | 4 : null;
  const fiscalYear = item.fiscalYear && Number.isInteger(item.fiscalYear) && item.fiscalYear >= 2000 && item.fiscalYear <= 2100 ? item.fiscalYear : null;
  if (item.horizon === "quarter" && (!fiscalYear || !fiscalQuarter)) issues.push("quarter guidance needs fiscalYear and fiscalQuarter");
  if (item.horizon === "annual" && !fiscalYear) issues.push("annual guidance needs fiscalYear");
  let { low, high } = item;
  const qualitative = item.form === "qualitative";
  if (qualitative) {
    low = null; high = null;
    if (!item.direction) issues.push("qualitative guidance needs direction");
  } else {
    if (item.form === "point") { low ??= high; high ??= low; }
    if (item.form === "floor") high = null;
    if (item.form === "ceiling") low = null;
    if ((item.form === "range" || item.form === "point") && (low === null || high === null)) issues.push("range and point guidance need low and high");
    if (item.form === "floor" && low === null) issues.push("floor guidance needs low");
    if (item.form === "ceiling" && high === null) issues.push("ceiling guidance needs high");
    if (low !== null && high !== null && low > high) issues.push("low is greater than high");
    const expected: GuidanceUnit | null = item.measure === "amount" ? "USD" : item.measure === "per_share" ? "USD_per_share" : item.measure ? "percent" : null;
    if (item.unit !== expected) issues.push(`unit must be ${expected ?? "consistent with measure"}`);
    const candidates = item.quote ? quoteNumbers(item.quote) : [];
    // A decline ("down 2% to 4%") is written without a sign; growth may be negative.
    for (const value of [low, high]) if (value !== null && !candidates.some(c => near(item.unit === "percent" ? Math.abs(value) : value, c, item.unit))) issues.push(`value ${value} does not appear in the quote`);
  }
  if (issues.length) return { item: null, issues };
  return {
    item: {
      metric: item.metric!, measure: item.measure!, segment: item.metric === "segment_revenue" || item.segment ? item.segment : null,
      label: item.label || item.metric!, basis: item.basis ?? "unspecified", horizon: item.horizon!, form: item.form!,
      fiscalYear, fiscalQuarter: item.horizon === "quarter" ? fiscalQuarter : null, unit: qualitative ? null : item.unit,
      low: low ?? null, high: high ?? null, direction: item.direction, text: item.text, quote: item.quote,
    },
    issues,
  };
}

export type FiscalAnchor = { fiscalYear: number; fiscalPeriod: string; periodEnd: string };

/**
 * Maps a fiscal year/quarter to the end of its calendar month using any reported period of the same
 * company as an anchor. 52/53-week calendars land within days of the true end, which is why period
 * matching downstream uses a tolerance rather than equality.
 */
export function resolvePeriodEnd(fiscalYear: number | null, fiscalQuarter: number | null, horizon: GuidanceHorizon, anchors: FiscalAnchor[]): string | null {
  if (!fiscalYear) return null;
  const quarter = horizon === "quarter" ? fiscalQuarter : 4;
  // Annual filings establish the fiscal-year boundary; quarterly DEI years can lag that boundary.
  const valid = anchors.filter(a => /^(Q[1-4]|FY)$/.test(a.fiscalPeriod) && /^\d{4}-\d{2}-\d{2}$/.test(a.periodEnd));
  const anchor = valid.find(a => a.fiscalPeriod === "FY") ?? valid[0];
  if (!quarter || !anchor) return null;
  const anchorQuarter = anchor.fiscalPeriod === "FY" ? 4 : Number(anchor.fiscalPeriod.slice(1));
  // An anchor on the 1st-7th belongs to the previous month (52/53-week years end on a weekday near month end).
  const [y, m, d] = anchor.periodEnd.split("-").map(Number);
  const anchorMonth = y * 12 + (m - 1) - (d <= 7 ? 1 : 0);
  const target = anchorMonth + ((fiscalYear - anchor.fiscalYear) * 4 + (quarter - anchorQuarter)) * 3;
  const year = Math.floor(target / 12), month = target % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

export const samePeriod = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 20 * 86_400_000;

export function classifyAction(previous: { low: number | null; high: number | null; direction?: GuidanceDirection | null } | null, next: { low: number | null; high: number | null; direction?: GuidanceDirection | null }): GuidanceAction {
  if (!previous) return "initiated";
  const mid = (v: { low: number | null; high: number | null }) => v.low !== null && v.high !== null ? (v.low + v.high) / 2 : v.low ?? v.high;
  const a = mid(previous), b = mid(next);
  if (a === null || b === null) return a === null && b === null && previous.direction === next.direction ? "reaffirmed" : "updated";
  const tolerance = Math.max(Math.abs(a), Math.abs(b)) * 1e-6 + 1e-9;
  if (b > a + tolerance) return "raised";
  if (b < a - tolerance) return "lowered";
  const width = (v: { low: number | null; high: number | null }) => v.low !== null && v.high !== null ? v.high - v.low : null;
  const wa = width(previous), wb = width(next);
  if (wa === null || wb === null) return "reaffirmed";
  if (wb < wa - tolerance) return "narrowed";
  if (wb > wa + tolerance) return "widened";
  return "reaffirmed";
}

/** One verified item as stored, with the event and material it came from. */
export type GuidanceEntry = VerifiedGuidance & {
  eventAccession: string;
  eventDate: string;
  materialKind: GuidanceMaterialKind;
  sourceId: string;
  periodEnd: string | null;
};

const PRIORITY: Record<GuidanceMaterialKind, number> = { press_release: 0, shareholder_letter: 1, deck: 2, transcript: 3 };
const targetKey = (e: VerifiedGuidance) => [e.metric, e.measure, (e.segment ?? "").toLowerCase(), e.horizon, e.fiscalYear ?? "", e.fiscalQuarter ?? "", e.metric === "other" ? e.label.toLowerCase() : ""].join("|");
const basisMatches = (a: GuidanceBasis, b: GuidanceBasis) => a === b || a === "unspecified" || b === "unspecified";
const sameValues = (a: VerifiedGuidance, b: VerifiedGuidance) => a.form === b.form && a.low === b.low && a.high === b.high && (a.form !== "qualitative" || a.direction === b.direction);

/**
 * Collapses the same statement repeated across a release, deck and call into one item, then links
 * each target to its value at the previous earnings event to classify the revision.
 */
export function consolidateGuidance(entries: GuidanceEntry[]): GuidanceItem[] {
  const events = [...new Set(entries.map(e => `${e.eventDate}|${e.eventAccession}`))].sort();
  const merged: Array<{ event: string; entry: GuidanceEntry; sourceIds: string[] }> = [];
  for (const event of events) {
    const own = entries.filter(e => `${e.eventDate}|${e.eventAccession}` === event).sort((a, b) => PRIORITY[a.materialKind] - PRIORITY[b.materialKind]);
    const kept: Array<{ event: string; entry: GuidanceEntry; sourceIds: string[] }> = [];
    for (const entry of own) {
      const match = kept.find(k => targetKey(k.entry) === targetKey(entry) && basisMatches(k.entry.basis, entry.basis));
      if (!match) { kept.push({ event, entry, sourceIds: [entry.sourceId] }); continue; }
      // A lower-priority source repeating the statement adds a citation; one that disagrees is dropped.
      if (sameValues(match.entry, entry)) {
        if (!match.sourceIds.includes(entry.sourceId)) match.sourceIds.push(entry.sourceId);
        if (match.entry.basis === "unspecified") match.entry = { ...match.entry, basis: entry.basis };
      }
    }
    merged.push(...kept);
  }
  return merged.map(({ event, entry, sourceIds }) => {
    const earlier = merged.filter(m => m.event < event && targetKey(m.entry) === targetKey(entry));
    const previous = (earlier.filter(m => m.entry.basis === entry.basis).at(-1) ?? earlier.filter(m => basisMatches(m.entry.basis, entry.basis)).at(-1))?.entry ?? null;
    return {
      id: `${targetKey(entry)}|${entry.basis}|${entry.eventAccession}`.replace(/[^A-Za-z0-9|._-]+/g, "-").slice(0, 240),
      metric: entry.metric, measure: entry.measure, segment: entry.segment, label: entry.label, basis: entry.basis,
      horizon: entry.horizon, form: entry.form, fiscalYear: entry.fiscalYear, fiscalQuarter: entry.fiscalQuarter, periodEnd: entry.periodEnd,
      unit: entry.unit, low: entry.low, high: entry.high, direction: entry.direction, derived: null, actual: null,
      text: entry.text, quote: clip(entry.quote, 200), sourceIds: sourceIds.slice(0, 6), issuedAt: entry.eventDate,
      action: classifyAction(previous, entry),
      previous: previous ? { low: previous.low, high: previous.high, issuedAt: previous.eventDate } : null,
    };
  });
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export type RevenueActual = { periodStart: string; periodEnd: string; value: number };

/**
 * Adds what can be computed from reported revenue: growth guidance as an amount (from the prior-year
 * quarter, or the four prior-year quarters for a fiscal year) and the actual for a guided quarter.
 */
export function attachRevenueContext(items: GuidanceItem[], quarters: RevenueActual[]): GuidanceItem[] {
  const quarterAt = (end: string) => quarters.find(q => samePeriod(q.periodEnd, end)) ?? null;
  const yearBefore = (end: string) => new Date(Date.parse(end) - 365 * 86_400_000).toISOString().slice(0, 10);
  return items.map(item => {
    if (item.metric !== "revenue" || item.segment || !item.periodEnd) return item;
    let derived: GuidanceItem["derived"] = null;
    let actual: GuidanceItem["actual"] = null;
    if (item.horizon === "quarter") {
      const found = quarterAt(item.periodEnd);
      if (found) actual = { value: found.value, periodEnd: found.periodEnd };
      const base = quarterAt(yearBefore(item.periodEnd));
      if (item.basis !== "constant_currency" && item.measure === "growth" && base && item.low !== null && item.high !== null) {
        derived = { low: Math.round(base.value * (1 + item.low / 100)), high: Math.round(base.value * (1 + item.high / 100)), basePeriodEnd: base.periodEnd, base: base.value };
      }
    } else if (item.basis !== "constant_currency" && item.horizon === "annual" && item.measure === "growth" && item.low !== null && item.high !== null) {
      const priorEnd = yearBefore(item.periodEnd);
      const year = [0, 1, 2, 3].map(i => quarterAt(new Date(Date.parse(priorEnd) - i * 91 * 86_400_000).toISOString().slice(0, 10)));
      if (year.every(Boolean) && new Set(year.map(q => q!.periodEnd)).size === 4) {
        const base = year.reduce((sum, q) => sum + q!.value, 0);
        derived = { low: Math.round(base * (1 + item.low / 100)), high: Math.round(base * (1 + item.high / 100)), basePeriodEnd: year[0]!.periodEnd, base };
      }
    }
    return { ...item, derived, actual };
  });
}

const https = z.string().max(2000).refine(v => { try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}/).max(40);
const amount = z.number().finite().nullable();
const publicItem = z.object({
  id: z.string().min(1).max(240), metric: z.enum(METRICS), measure: z.enum(MEASURES), segment: z.string().max(120).nullable(),
  label: z.string().max(160), basis: z.enum(BASES), horizon: z.enum(HORIZONS), form: z.enum(FORMS),
  fiscalYear: z.number().int().nullable(), fiscalQuarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullable(),
  periodEnd: date.nullable(), unit: z.enum(UNITS).nullable(), low: amount, high: amount, direction: z.enum(DIRECTIONS).nullable(),
  derived: z.object({ low: z.number().finite(), high: z.number().finite(), basePeriodEnd: date, base: z.number().finite() }).nullable(),
  actual: z.object({ value: z.number().finite(), periodEnd: date }).nullable(),
  text: z.string().min(1).max(300), quote: z.string().min(1).max(200), sourceIds: z.array(z.string().max(80)).min(1).max(6),
  issuedAt: date, action: z.enum(ACTIONS).nullable(),
  previous: z.object({ low: amount, high: amount, issuedAt: date }).nullable(),
});
export const guidancePublicationSchema = z.object({
  schemaVersion: z.literal("guidance.v1"),
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/),
  updatedAt: z.string().max(40),
  items: z.array(publicItem).max(400),
  sources: z.array(z.object({ id: z.string().min(1).max(80), kind: z.enum(KINDS), sourceKind: z.enum(["sec", "transcript_api", "ir"]), title: z.string().min(1).max(300), url: https, publishedAt: date })).max(200),
  coverage: z.array(z.object({ eventDate: date, accession: z.string().max(40), materials: z.array(z.object({ kind: z.enum(KINDS), status: z.enum(["extracted", "unsupported", "unavailable", "failed"]) })).max(12) })).max(40),
});

/** Parses a publication for one ticker; items citing a source not listed in it are dropped. */
export function readGuidancePublication(value: unknown, ticker: string): GuidancePublication | null {
  const parsed = guidancePublicationSchema.safeParse(value);
  if (!parsed.success || parsed.data.ticker !== ticker) return null;
  const ids = new Set(parsed.data.sources.map(s => s.id));
  return { ...parsed.data, items: parsed.data.items.filter(item => item.sourceIds.every(id => ids.has(id))) };
}
