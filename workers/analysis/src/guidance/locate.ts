import type { GuidanceMaterialKind } from "../../../../shared/analysis-contract/guidance.ts";

const FORWARD = /\b(outlook|guidance|guiding|guide[sd]?|expects?|expected|expecting|anticipates?|forecasts?|projects?|projected|targets?|framework|long[- ]term model|next quarter|(?:first|second|third|fourth|1st|2nd|3rd|4th) quarter|q[1-4]\b|full[- ]year|fiscal (?:year )?20\d{2}|fy ?'?\d{2}|for the year)\b/i;
const SIGNAL = /\d|\b(accelerat|decelerat|increas|decreas|grow|growth|improv|expan|declin|moderat|flat|higher|lower)/i;
const BOILERPLATE = /forward-looking statements|safe harbor|private securities litigation|undue reliance|risk factors (?:in|described)|non-gaap financial measures? (?:are|is) (?:not|supplemental)/i;
const HEADING = /^(?:(?:business|financial|fiscal(?: year)?(?: 20\d{2})?|q[1-4]|quarterly|annual|full[- ]year|20\d{2})\s+)?(?:outlook|guidance)\b.{0,60}$/i;
const MAX_UNIT = 1200;
const BUDGET = 24_000;

function units(text: string): string[] {
  const paragraphs = text.split(/\n+/).map(p => p.trim()).filter(Boolean);
  return paragraphs.flatMap(paragraph => {
    if (paragraph.length <= MAX_UNIT) return [paragraph];
    // Long call turns are split on sentence ends so one guidance sentence does not pull in a whole monologue.
    const out: string[] = [];
    let current = "";
    for (const sentence of paragraph.split(/(?<=[.!?])\s+(?=[A-Z"'(])/)) {
      if (current && current.length + sentence.length > MAX_UNIT / 2) { out.push(current); current = ""; }
      current = current ? `${current} ${sentence}` : sentence;
    }
    if (current) out.push(current);
    return out;
  });
}

/**
 * Deterministic pre-filter: only passages that read as forward-looking and carry a number or a
 * direction are sent to the model, with one neighbour on each side for the period they refer to.
 * Short documents are sent whole. Every passage is verbatim, so quotes from it verify against the
 * full source.
 */
export function locateGuidance(text: string, kind: GuidanceMaterialKind): { excerpt: string; selected: number; total: number } {
  const all = units(text);
  if (text.length <= 6_000) return { excerpt: text, selected: all.length, total: all.length };
  const keep = new Set<number>();
  let section = 0;
  all.forEach((unit, index) => {
    if (BOILERPLATE.test(unit)) { section = 0; return; }
    // An Outlook/Guidance heading keeps the passages under it, where tables put labels and numbers on separate lines.
    if (unit.length <= 80 && HEADING.test(unit)) { section = 12; keep.add(index); return; }
    if (section > 0) { section--; keep.add(index); return; }
    if (FORWARD.test(unit) && SIGNAL.test(unit)) {
      keep.add(index);
      if (kind === "transcript" || kind === "deck") { if (index > 0) keep.add(index - 1); keep.add(index + 1); }
    }
  });
  const chosen = [...keep].filter(i => i < all.length && !BOILERPLATE.test(all[i])).sort((a, b) => a - b);
  const pieces: string[] = [];
  let used = 0, last = -2;
  for (const index of chosen) {
    const unit = all[index];
    if (used + unit.length > BUDGET) break;
    pieces.push(index === last + 1 || !pieces.length ? unit : `[...]\n${unit}`);
    used += unit.length;
    last = index;
  }
  return { excerpt: pieces.join("\n"), selected: pieces.length, total: all.length };
}
