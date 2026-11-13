export type Transcript = { id: string; periodEnd: string; title: string; filedAt: string; content: string };
export async function transcripts(db: D1Database, ticker: string, limit = 6): Promise<Transcript[]> {
  const rows = await db.prepare("SELECT id, period_end, title, filed_at, content FROM company_transcripts WHERE ticker = ? AND status = 'ready' AND content IS NOT NULL ORDER BY period_end DESC LIMIT ?").bind(ticker, limit)
    .all<{ id: string; period_end: string; title: string | null; filed_at: string; content: string }>();
  return rows.results.map(r => ({ id: r.id, periodEnd: r.period_end, title: r.title ?? `${ticker} earnings call`, filedAt: r.filed_at, content: r.content }));
}

/** The parts of a long text around the given terms, in the order they appear. */
export function excerpts(text: string, terms: string[], budget = 9000): string {
  const lower = text.toLowerCase();
  const spots = [...new Set(terms.flatMap(t => { const found: number[] = []; let at = lower.indexOf(t.toLowerCase()); while (at >= 0 && found.length < 3) { found.push(at); at = lower.indexOf(t.toLowerCase(), at + 1500); } return found; }))].sort((a, b) => a - b);
  if (!spots.length) return text.slice(0, Math.min(budget, 3000));
  const share = Math.max(900, Math.floor(budget / spots.length));
  const pieces: string[] = [];
  let last = -1;
  for (const at of spots) {
    const from = Math.max(last + 1, at - Math.floor(share * 0.3)), to = Math.min(text.length, from + share);
    if (from >= to) continue;
    pieces.push(text.slice(from, to).trim());
    last = to;
  }
  return pieces.join("\n…\n").slice(0, budget);
}
