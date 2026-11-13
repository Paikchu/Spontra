export type FilingStatus = "registered" | "waiting" | "running" | "published" | "failed";
export type FilingRow = { ticker: string; accession: string; form: string; filedAt: string; profile: string; status: FilingStatus };
type Row = { ticker: string; accession_number: string; form: string; filed_at: string; profile: string; status: FilingStatus };

/** Registers filings not seen before; one already registered keeps its state. */
export async function registerFilings(db: D1Database, filings: Array<Omit<FilingRow, "status">>, now: string): Promise<void> {
  if (!filings.length) return;
  const statement = db.prepare("INSERT INTO filing_analyses (ticker, accession_number, form, filed_at, profile, status, updated_at) VALUES (?, ?, ?, ?, ?, 'registered', ?) ON CONFLICT(ticker, accession_number) DO NOTHING");
  await db.batch(filings.map(f => statement.bind(f.ticker, f.accession, f.form, f.filedAt, f.profile, now)));
}

/** The filings a run should start, oldest first, or the one a manual run names, whatever it came to before. */
export async function dueFilings(db: D1Database, ticker: string, accession: string | null): Promise<FilingRow[]> {
  const rows = accession
    ? await db.prepare("SELECT * FROM filing_analyses WHERE ticker = ? AND accession_number = ?").bind(ticker, accession).all<Row>()
    : await db.prepare("SELECT * FROM filing_analyses WHERE ticker = ? AND status IN ('registered', 'waiting') ORDER BY filed_at, accession_number").bind(ticker).all<Row>();
  return rows.results.map(r => ({ ticker: r.ticker, accession: r.accession_number, form: r.form, filedAt: r.filed_at, profile: r.profile, status: r.status }));
}

export type FilingUpdate = { status: FilingStatus; reason?: string | null; runId?: string; tokens?: number; publishedAt?: string };
export const updateFiling = (db: D1Database, ticker: string, accession: string, update: FilingUpdate, now: string) =>
  db.prepare("UPDATE filing_analyses SET status = ?, reason = ?, run_id = COALESCE(?, run_id), tokens = COALESCE(?, tokens), published_at = COALESCE(?, published_at), updated_at = ? WHERE ticker = ? AND accession_number = ?")
    .bind(update.status, update.reason?.slice(0, 900) ?? null, update.runId ?? null, update.tokens ?? null, update.publishedAt ?? null, now, ticker, accession).run();

/** One call of a session, as its trail recorded it (docs/filing-analysis-optimization.md §4.9). A lost row never fails the session. */
export const recordRunTurn = (db: D1Database, runId: string, entry: { turn: number; action: string; input: string; failed?: boolean }) =>
  db.prepare("INSERT INTO filing_run_turns (run_id, turn, action, input, failed, at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(runId, entry.turn, entry.action.slice(0, 60), entry.input.slice(0, 2000), entry.failed ? 1 : 0, new Date().toISOString()).run().then(() => undefined, () => undefined);

export type RunSummary = { runId: string; ticker: string; accession: string; profile: string; status: "published" | "failed"; settledBy: string | null;
  reviewRounds: number; renderRounds: number; sectionsRead: string[]; charsRead?: number; blocks: number; degraded: string[]; detail?: Record<string, unknown> };
/** The summary of a session, written when it publishes and again when its run ends, from the turns recorded and the state it ended with. */
export async function recordRunSummary(db: D1Database, summary: RunSummary): Promise<void> {
  const turns = await db.prepare("SELECT action, COUNT(*) n, MAX(turn) turn, MIN(at) first FROM filing_run_turns WHERE run_id = ? GROUP BY action").bind(summary.runId).all<{ action: string; n: number; turn: number; first: string }>();
  const tools = Object.fromEntries(turns.results.map(r => [r.action, r.n]));
  const started = turns.results.map(r => r.first).sort()[0] ?? null;
  await db.prepare(`INSERT INTO filing_run_summary (run_id, ticker, accession_number, profile, status, settled_by, started_at, ended_at, turns, tools, review_rounds, render_rounds, sections_read, chars_read, compactions, blocks, degraded, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, settled_by = excluded.settled_by, started_at = excluded.started_at, ended_at = excluded.ended_at, turns = excluded.turns, tools = excluded.tools,
      review_rounds = excluded.review_rounds, render_rounds = excluded.render_rounds, sections_read = excluded.sections_read, chars_read = excluded.chars_read, compactions = excluded.compactions,
      blocks = excluded.blocks, degraded = excluded.degraded, detail = excluded.detail`)
    .bind(summary.runId, summary.ticker, summary.accession, summary.profile, summary.status, summary.settledBy, started, new Date().toISOString(), Math.max(0, ...turns.results.map(r => r.turn)), JSON.stringify(tools),
      summary.reviewRounds, summary.renderRounds, summary.sectionsRead.length, summary.charsRead ?? 0, tools.compaction ?? 0, summary.blocks, JSON.stringify(summary.degraded), JSON.stringify(summary.detail ?? {})).run();
}
