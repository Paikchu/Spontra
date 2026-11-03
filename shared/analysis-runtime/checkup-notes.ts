import type { CheckupNote, FindingMaterial, FindingPassage, FindingRef, FindingSpan } from "../analysis-contract/findings.ts";
import type { AssessedMetric, Flag } from "../analysis-contract/statement-analysis.ts";
import { evidenceCandidates, numberSupported, proseNumbers, refLabel, resolveEvidence, resolveRef, spanLabel, type FindingData } from "./findings.ts";
import { formatDelta, formatResolved } from "./lens/format.ts";
import { verifyQuote } from "./lens/verify.ts";
import { formatMetric, formatMetricChange, METRIC_DEFS, thresholdsOf } from "./statement-analysis.ts";

/**
 * The written side of the three-statement checkup (docs/three-statement-analysis-design.md): the figures a note about
 * one metric may state, and the check a note must pass before the page shows it. Spontra Analysis's writer is held to the
 * same check before it may finish, so the reader never sees a number or a quote the data and the filings do not hold.
 */

/** A note reads a report's filing as earlier when it reports a period ending more than this many days before. */
export const EARLIER_DAYS = 45;
const DAY = 86_400_000;

/** The figures a note may state, written for the writer; and every number they allow, for the check. */
export type NoteFigures = { lines: string[]; candidates: number[] };

/** The references a metric is made of: a ratio's two sides, a spread's two growths, or the figure itself. */
function partsOf(metric: Pick<AssessedMetric, "id">): FindingRef[] {
  const def = METRIC_DEFS.get(metric.id);
  if (!def) return [];
  if (def.measure === "spread" && def.against) return [def.ref, def.against];
  return "ratio" in def.ref ? [def.ref.ratio.numerator, def.ref.ratio.denominator] : [def.ref];
}

/**
 * Everything a note about this metric may cite: its value at every shown quarter, its change on the year and the
 * quarter, the thresholds its rules test, and the figures it is made of now and a year earlier. Written the way the
 * findings ledger writes them ("$75.7 billion" reads as "$75.7B" here; both state 75.7).
 */
export function noteFigures(data: FindingData, metric: AssessedMetric, flags: Flag[]): NoteFigures {
  const def = METRIC_DEFS.get(metric.id);
  const form = metric.form;
  const lines: string[] = [];
  const candidates: number[] = [];
  const add = (...values: Array<number | null | undefined>) => { for (const v of values) if (v != null && Number.isFinite(v)) candidates.push(v, Math.abs(v)); };
  const label = def?.label[0] ?? metric.id;
  const span = metric.span === "fiscal_year" ? "trailing four quarters" : "quarter";
  lines.push(`${label} (${span}), by quarter: ${metric.series.map(p => `${p.periodEnd.slice(0, 7)} ${formatMetric(p.value, form)}`).join(" · ")}`);
  add(...metric.series.map(p => p.value));
  const changes = [metric.yoy != null ? `YoY ${formatMetricChange(metric.yoy, form)}` : null, metric.qoq != null ? `QoQ ${formatMetricChange(metric.qoq, form)}` : null].filter(Boolean);
  if (changes.length) lines.push(`${label} change at the report: ${changes.join(", ")}`);
  add(metric.yoy, metric.qoq);
  for (const f of flags) { lines.push(`rule ${f.ruleId} (${f.level}): ${f.threshold}; holding since ${f.since.slice(0, 7)}`); add(...thresholdsOf(f)); }
  const ends = metric.series.map(p => p.periodEnd);
  for (const ref of partsOf(metric)) {
    const at = (end: string, s: FindingSpan) => resolveRef(data, ref, end, s);
    const now = resolveEvidence(data, { ref, periodEnd: metric.evidence.periodEnd, span: metric.span, compare: "yoy" }) ?? resolveEvidence(data, { ref, periodEnd: metric.evidence.periodEnd, span: metric.span });
    if (!now) continue;
    const name = refLabel(data, ref);
    lines.push(`${name} (${spanLabel(now.current)}): ${formatResolved(now.current, ref)}${now.compare ? `; a year earlier ${formatResolved(now.compare, ref)}${now.delta != null ? ` (${formatDelta(now.delta, now.current.unit, ref)})` : ""}` : ""}`);
    candidates.push(...evidenceCandidates(now));
    const history = ends.flatMap(end => { const v = at(end, metric.span); return v && !v.range ? [{ end, v }] : []; });
    if (history.length > 1) lines.push(`${name} by quarter: ${history.map(h => `${h.end.slice(0, 7)} ${formatResolved(h.v, ref)}`).join(" · ")}`);
    for (const h of history) candidates.push(...evidenceCandidates({ evidence: { ref, periodEnd: h.end, span: metric.span }, label: name, current: h.v, compare: null, compareLabel: null, delta: null, ratio: null, guidance: null }));
  }
  return { lines, candidates };
}

/** The report a material comes from is earlier when its filing reports a period well before the note's report. */
export function earlierMaterial(material: Pick<FindingMaterial, "title" | "publishedAt">, periodEnd: string): boolean {
  // Filing materials are titled "<ticker> <form> <report date>"; the filing date stands in when the title has none.
  const reported = /(\d{4}-\d{2}-\d{2})\s*$/.exec(material.title)?.[1] ?? material.publishedAt?.slice(0, 10) ?? null;
  return !!reported && Date.parse(periodEnd) - Date.parse(reported) > EARLIER_DAYS * DAY;
}

export type NoteIssue = string;
/**
 * What keeps a note off the page: a number its figures do not hold, a source or quote that is not a material it read,
 * a quote not found in its passage, and, when an earlier report was available, no quote from one. Empty when it holds.
 */
export function noteIssues(note: Pick<CheckupNote, "paragraphs" | "quotes">, figures: NoteFigures, materials: FindingMaterial[], passages: FindingPassage[], periodEnd: string, earlierAvailable: boolean): NoteIssue[] {
  const issues: NoteIssue[] = [];
  const ids = new Set(materials.map(m => m.id));
  if (!note.paragraphs.length) issues.push("no paragraph");
  note.paragraphs.forEach((p, i) => {
    const unsupported = proseNumbers(p.text).filter(n => !numberSupported(n, figures.candidates));
    if (unsupported.length) issues.push(`paragraph ${i + 1}: numbers ${unsupported.join(", ")} are not among the figures`);
    if (!p.sourceIds.length || p.sourceIds.some(id => !ids.has(id))) issues.push(`paragraph ${i + 1}: sourceIds must name materials read in this run`);
  });
  const quoted = note.quotes.map(q => ({ q, verified: verifyQuote(materials, passages, q.materialId, q.text) }));
  quoted.forEach(({ q, verified }, i) => {
    if (q.text.trim().length < 20) issues.push(`quote ${i + 1}: shorter than 20 characters`);
    else if (!verified) issues.push(`quote ${i + 1}: not found verbatim in material ${q.materialId}`);
  });
  if (earlierAvailable && !quoted.some(({ verified }) => verified && earlierMaterial(verified.material, periodEnd))) issues.push("no quote from an earlier report: read the earlier filing (read_section with previous: true) and quote what it said");
  return issues;
}

/** A note as the page shows it: the paragraphs whose numbers hold, and the quotes found in their passages, each marked earlier or current. */
export type VerifiedNote = {
  metricId: string;
  paragraphs: CheckupNote["paragraphs"];
  quotes: Array<{ text: string; material: FindingMaterial; passage: FindingPassage; earlier: boolean }>;
};

/**
 * The note the page can stand behind: a paragraph with a number the metric's figures do not hold, or citing nothing it
 * can find, is left out; a quote not found in its passage as served now is left out. Null when no paragraph is left.
 */
export function verifyNote(note: CheckupNote, data: FindingData, metric: AssessedMetric, flags: Flag[], materials: FindingMaterial[] | undefined): VerifiedNote | null {
  const figures = noteFigures(data, metric, flags);
  const ids = new Set((materials ?? []).map(m => m.id));
  const paragraphs = note.paragraphs.filter(p => proseNumbers(p.text).every(n => numberSupported(n, figures.candidates)) && p.sourceIds.some(id => ids.has(id)));
  if (!paragraphs.length) return null;
  const quotes = note.quotes.flatMap(q => { const v = verifyQuote(materials, data.passages, q.materialId, q.text); return v ? [{ text: q.text, material: v.material, passage: v.passage, earlier: earlierMaterial(v.material, metric.evidence.periodEnd) }] : []; });
  return { metricId: note.metricId, paragraphs, quotes };
}
