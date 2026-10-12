import type { FindingRef, FindingSpan } from "../../analysis-contract/findings.ts";
import { LENS_ASPECT, type LensChart, type LensColorToken, type LensMark, type LensSeries } from "../../analysis-contract/lens.ts";
import type { CompiledAxis, CompiledChart, CompiledSeries } from "../../analysis-contract/lens-frame.ts";
import { refLabel, resolveEvidence, resolveRef, shiftPeriod, type FindingData, type ResolvedValue, type ValueUnit } from "../findings.ts";
import { ratioForm } from "../highlights.ts";
import { formatDelta, formatResolved, periodLabel, tickLabel } from "./format.ts";

export type CompileOptions = {
  /** The page's colour for a reference (a business node's own hue); unset falls back to the design tokens by what the figure is. */
  colorOf?: (ref: FindingRef, index: number) => string | null;
};
export type CompileResult = { chart: CompiledChart | null; errors: string[]; notes: string[] };

const TOKEN_VAR: Record<LensColorToken, string> = {
  revenue: "var(--flow-revenue)", profit: "var(--flow-profit)", expense: "var(--flow-expense)", loss: "var(--loss)", up: "var(--up)", muted: "var(--muted-foreground)",
  "biz-0": "var(--biz-0)", "biz-1": "var(--biz-1)", "biz-2": "var(--biz-2)", "biz-3": "var(--biz-3)", "biz-4": "var(--biz-4)",
};
export const colorVar = (token: LensColorToken) => TOKEN_VAR[token];

/** Series colour follows what the figure is: revenue neutral, profit and cash generated teal, costs and capital spending amber. */
export function defaultColor(ref: FindingRef, index: number): string {
  if ("ratio" in ref) return defaultColor(ref.ratio.numerator, index);
  if ("metric" in ref) return ref.metric === "revenue" ? TOKEN_VAR.revenue : ["gross", "operating", "pretax", "net"].includes(ref.metric) ? TOKEN_VAR.profit : TOKEN_VAR.expense;
  if ("capital" in ref) return ["operatingCashFlow", "cash", "equity", "rpo", "rpoNext12MonthsShare"].includes(ref.capital) ? TOKEN_VAR.profit : ref.capital === "freeCashFlow" || ref.capital === "totalAssets" ? TOKEN_VAR["biz-1"] : TOKEN_VAR.expense;
  if ("rpoBucket" in ref) return TOKEN_VAR[(["biz-4", "biz-1", "biz-3", "biz-0"] as const)[ref.rpoBucket % 4]];
  return TOKEN_VAR[(["biz-3", "biz-4", "biz-2", "biz-0", "biz-1"] as const)[index % 5]];
}

/** Period ends a chart draws: `count` spans ending at the finding's report. */
export function chartPeriods(periodEnd: string, span: FindingSpan, count: number): string[] {
  const step = span === "quarter" ? -3 : -12;
  return Array.from({ length: count }, (_, i) => shiftPeriod(periodEnd, step * (count - 1 - i)));
}

const STACKED = new Set(["stacked_bar", "stacked_area"]);
const FROM_ZERO = new Set(["bar", "area", "stacked_bar", "stacked_area", "waterfall"]);

type Resolved = { value: number | null; text: string | null; range: { low: number; high: number } | null; unit: ValueUnit | null; currency: string | null };

function resolveSeries(data: FindingData, s: LensSeries, end: string, span: FindingSpan): Resolved {
  const none: Resolved = { value: null, text: null, range: null, unit: null, currency: null };
  if (!s.transform || s.transform === "value") {
    const v = resolveRef(data, s.ref, end, span);
    return v ? { value: v.value, text: formatResolved(v, s.ref), range: v.range && v.range.low !== v.range.high ? v.range : null, unit: v.unit, currency: v.currency } : none;
  }
  // A change is the evidence comparison the verifier makes: percent for amounts, points for rates, turns for multiples.
  const r = resolveEvidence(data, { ref: s.ref, periodEnd: end, span, compare: s.transform });
  if (!r || r.delta == null) return none;
  // An amount changes in percent, a rate in points (a margin written as a percentage scales by a hundred to match its text), a multiple in turns.
  const percentForm = r.current.unit === "ratio" && ratioForm(s.ref) === "percent";
  const unit: ValueUnit = r.current.unit === "USD" || r.current.unit === "per_share" || r.current.unit === "shares" ? "percent" : r.current.unit === "ratio" && !percentForm ? "ratio" : "points";
  return { value: percentForm ? r.delta * 100 : r.delta, text: formatDelta(r.delta, r.current.unit, s.ref), range: null, unit, currency: null };
}

/** Three round ticks spanning the domain, zero among them when the domain crosses it. */
function ticksFor(min: number, max: number): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / 3, power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * power).find(s => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(12)));
  return out.length >= 2 ? out : [min, max];
}

function axisFor(series: CompiledSeries[], marks: LensMark[], refs: Map<string, FindingRef>): { axis: CompiledAxis | null; error: string | null } {
  if (!series.length) return { axis: null, error: null };
  const units = [...new Set(series.map(s => s.unit))];
  if (units.length > 1) return { axis: null, error: `an axis mixes ${units.join(" and ")} series; put one of them on the other axis` };
  let min = Infinity, max = -Infinity;
  const fromZero = marks.some(m => FROM_ZERO.has(m.type) && m.series.some(id => series.some(s => s.id === id)));
  for (const m of marks) {
    const mine = m.series.map(id => series.find(s => s.id === id)).filter((s): s is CompiledSeries => !!s);
    if (!mine.length) continue;
    if (STACKED.has(m.type)) {
      for (let i = 0; i < (mine[0]?.values.length ?? 0); i++) {
        let up = 0, down = 0;
        for (const s of mine) { const v = s.values[i]; if (v == null) continue; if (v >= 0) up += v; else down += v; }
        min = Math.min(min, down); max = Math.max(max, up);
      }
    } else for (const s of mine) for (const [i, v] of s.values.entries()) {
      if (v == null) continue;
      const r = s.ranges?.[i];
      min = Math.min(min, r ? r.low : v); max = Math.max(max, r ? r.high : v);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { axis: null, error: null };
  if (fromZero) { min = Math.min(0, min); max = Math.max(0, max); }
  if (min === max) { const pad = Math.abs(min) || 1; min -= pad * 0.5; max += pad * 0.5; }
  // Lines float: a little headroom so the top point is not on the frame.
  if (!fromZero) { const pad = (max - min) * 0.12; min -= pad; max += pad; }
  const first = series[0]!, ref = refs.get(first.id);
  const ticks = ticksFor(min, max).map(value => ({ value, label: tickLabel(value, first.unit, first.currency, ref) }));
  return { axis: { unit: first.unit, currency: first.currency, min: Math.min(min, ticks[0]?.value ?? min), max: Math.max(max, ticks.at(-1)?.value ?? max), ticks, zero: min < 0 && max > 0 }, error: null };
}

const periodIndex = (periods: string[], at: string): number => at === "first" ? 0 : at === "latest" ? periods.length - 1
  : periods.findIndex(end => Math.abs(Date.parse(end) - Date.parse(at)) <= 20 * 86_400_000);
const PLACEHOLDER = /\{(value|change|label|period)\}/g;

/**
 * Resolves every series of a chart against the data, fixes its scales and formats every figure the
 * frame will write. The result is the whole picture as JSON; the errors say what a model must change.
 */
export function compileChart(chart: LensChart, data: FindingData, periodEnd: string, options: CompileOptions = {}): CompileResult {
  const errors: string[] = [], notes: string[] = [];
  const ends = chartPeriods(periodEnd, chart.span, chart.periods);
  const refs = new Map(chart.series.map(s => [s.id, s.ref]));
  const ids = new Set<string>();
  for (const s of chart.series) { if (ids.has(s.id)) errors.push(`series id ${s.id} is used twice`); ids.add(s.id); }
  for (const m of chart.marks) {
    for (const id of m.series) if (!ids.has(id)) errors.push(`mark ${m.type} names unknown series ${id}`);
    if (m.type === "waterfall" && m.series.length !== 1) errors.push("a waterfall draws exactly one series");
  }
  for (const s of chart.series) if (!chart.marks.some(m => m.series.includes(s.id))) errors.push(`series ${s.id} is not drawn by any mark`);
  if (errors.length) return { chart: null, errors, notes };

  const resolved = chart.series.map(s => ends.map(end => resolveSeries(data, s, end, chart.span)));
  // Leading periods no series can answer are left out, so a short history does not open with empty slots.
  const lead = ends.findIndex((_, i) => resolved.some(r => r[i]!.value != null));
  if (lead < 0) { errors.push(`no series resolves at any of the ${chart.periods} ${chart.span} periods ending ${periodEnd}`); return { chart: null, errors, notes }; }
  const periods = ends.slice(lead).map((end, i, all) => ({ end, label: periodLabel(end, chart.span), current: i === all.length - 1 }));
  const series: CompiledSeries[] = chart.series.map((s, i) => {
    const rows = resolved[i]!.slice(lead);
    const count = rows.filter(r => r.value != null).length;
    if (count === 0) errors.push(`series ${s.id} (${refLabel(data, s.ref)}) resolves nothing at ${chart.span} periods ending ${periodEnd}`);
    else if (count === 1 && periods.length > 1) notes.push(`series ${s.id} has one value in ${periods.length} periods`);
    const mark = chart.marks.find(m => m.series.includes(s.id))!;
    const unit = rows.find(r => r.unit)?.unit ?? "USD";
    const suffix = s.transform === "yoy" ? " YoY" : s.transform === "qoq" ? " QoQ" : "";
    return {
      id: s.id, label: (s.label ?? refLabel(data, s.ref)) + suffix, unit, currency: rows.find(r => r.currency)?.currency ?? null,
      color: mark.color ? colorVar(mark.color) : options.colorOf?.(s.ref, i) ?? defaultColor(s.ref, i), axis: mark.axis ?? "left",
      values: rows.map(r => r.value), text: rows.map(r => r.text), ...(rows.some(r => r.range) ? { ranges: rows.map(r => r.range) } : {}),
    };
  });
  if (errors.length) return { chart: null, errors, notes };
  for (const m of chart.marks.filter(m => STACKED.has(m.type))) {
    const units = new Set(m.series.map(id => series.find(s => s.id === id)!.unit));
    if (units.size > 1) errors.push(`${m.type} stacks series in different units (${[...units].join(", ")})`);
  }
  const left = axisFor(series.filter(s => s.axis === "left"), chart.marks, refs), right = axisFor(series.filter(s => s.axis === "right"), chart.marks, refs);
  if (left.error) errors.push(`left ${left.error}`);
  if (right.error) errors.push(`right ${right.error}`);
  const annotations = (chart.annotations ?? []).flatMap(a => {
    const s = series.find(s => s.id === a.series);
    if (!s) { errors.push(`annotation names unknown series ${a.series}`); return []; }
    const i = periodIndex(periods.map(p => p.end), a.period);
    if (i < 0 || s.values[i] == null) { errors.push(`annotation on ${a.series} at ${a.period}: no value there`); return []; }
    const change = resolveEvidence(data, { ref: refs.get(s.id)!, periodEnd: periods[i]!.end, span: chart.span, compare: "yoy" }) ?? resolveEvidence(data, { ref: refs.get(s.id)!, periodEnd: periods[i]!.end, span: chart.span, compare: "qoq" });
    if (/\{change\}/.test(a.text) && (!change || change.delta == null)) { errors.push(`annotation on ${a.series} at ${a.period} asks for {change} but no comparison exists`); return []; }
    const residual = a.text.replace(PLACEHOLDER, "");
    if (/\d/.test(residual)) { errors.push(`annotation "${a.text}" states a figure; use {value} or {change}`); return []; }
    const text = a.text.replace(PLACEHOLDER, (_, key: string) => key === "value" ? s.text[i]! : key === "label" ? s.label : key === "period" ? periods[i]!.label : formatDelta(change!.delta!, change!.current.unit, refs.get(s.id)));
    return [{ series: s.id, period: i, text }];
  });
  const bands = (chart.bands ?? []).flatMap(b => {
    const from = periodIndex(periods.map(p => p.end), b.from), to = periodIndex(periods.map(p => p.end), b.to);
    if (from < 0 || to < 0 || from > to) { errors.push(`band ${b.from}–${b.to} does not fit the drawn periods`); return []; }
    return [{ from, to, label: b.label ?? null }];
  });
  if (errors.length) return { chart: null, errors, notes };
  const latest = periods.length - 1;
  const summary = `${chart.title ?? series.map(s => s.label).join(", ")} over ${periods.length} ${chart.span === "quarter" ? "quarters" : "fiscal years"} to ${periods[latest]!.label}: ${series.map(s => `${s.label} ${s.text[latest] ?? "not disclosed"}`).join("; ")}.`;
  return {
    chart: {
      id: chart.id, title: chart.title ?? null, aspect: chart.aspect, span: chart.span, periods, series, marks: chart.marks.map(m => ({ type: m.type, series: m.series })),
      axes: { left: left.axis, right: right.axis }, annotations, bands, periodLabels: chart.periodLabels ?? "all", legend: chart.legend ?? (series.length > 1 ? "top" : "none"), summary,
    }, errors, notes,
  };
}

/** Pixel height the host gives a chart cell of a given width; the audit estimates with the same rule. */
export const chartHeight = (width: number, aspect: keyof typeof LENS_ASPECT) => Math.max(200, Math.min(420, Math.round(width * LENS_ASPECT[aspect])));
export const resolvedText = (v: ResolvedValue, ref?: FindingRef) => formatResolved(v, ref);
