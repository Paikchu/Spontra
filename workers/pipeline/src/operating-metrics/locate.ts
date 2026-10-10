/** A number followed by something counted or a capacity, in the company's own prose. */
const QUANTITY = /\b\d[\d,.]*\s*(?:MW|GW|megawatts?|gigawatts?|data\s?cent(?:er|re)s?|sites?|regions?|GPUs?|servers?|racks?|clusters?|units?|vehicles?|subscribers?|customers?|members?|users?|employees?|stores?|locations?|patents?|satellites?|aircraft|rigs?|wells?|stations?|reactors?|modules?)\b/i;
const CAPACITY = /\b(?:active|contracted|installed|deployed|delivered|operating|under construction|in operation|capacity|footprint)\b/i;
const MONEY = /[$€£¥]\s?\d|\b(?:million|billion|bn)\b.*\b(?:revenue|income|cash|expense|cost|debt|notes)\b/i;
const BOILERPLATE = /forward-looking statements|safe harbor|private securities litigation|undue reliance|non-gaap financial measures? (?:are|is)/i;
const MAX_UNIT = 1200;
const BUDGET = 24_000;

function units(text: string): string[] {
  return text.split(/\n+/).map(p => p.trim()).filter(Boolean).flatMap(paragraph => {
    if (paragraph.length <= MAX_UNIT) return [paragraph];
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
 * Deterministic pre-filter: only passages that count or size something are sent to the model,
 * with the neighbour before them for the date they refer to. Pure currency passages are skipped.
 * Every passage is verbatim, so quotes from it verify against the full source.
 */
export function locateOperating(text: string): { excerpt: string; selected: number; total: number } {
  const all = units(text);
  if (text.length <= 6_000) return { excerpt: text, selected: all.length, total: all.length };
  const keep = new Set<number>();
  all.forEach((unit, index) => {
    if (BOILERPLATE.test(unit)) return;
    if (QUANTITY.test(unit) || (CAPACITY.test(unit) && /\d/.test(unit) && !MONEY.test(unit))) {
      keep.add(index);
      if (index > 0) keep.add(index - 1);
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
