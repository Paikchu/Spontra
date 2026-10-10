import type { AiRun, AiRunKind, AiRunStatus, AiRunTrigger, AiVersion, AiVersionSummary } from "../../../../shared/analysis-contract/ai-runs-admin.ts";
import { sha256 } from "../company-analysis/api.ts";

/**
 * Run records and published versions of the findings, explainer and guidance workflows, kept in
 * `sec_cache` under ordered keys so each company and kind reads as one key range. The current
 * publication stays under its own key; this is the audit trail beside it.
 */
const KEEP_RUNS = 20, KEEP_VERSIONS = 30, KEEP_LOG = 80;
const runPrefix = (kind: AiRunKind, ticker: string) => `ai-run:v1:${kind}:${ticker}:`;
const versionPrefix = (kind: AiRunKind, ticker: string) => `ai-version:v1:${kind}:${ticker}:`;
/** Keys use letters, digits and `-:.`; `~` sorts after all of them and closes the range. */
const range = (prefix: string) => [prefix, `${prefix}~`] as const;
export const TERMINAL: ReadonlySet<AiRunStatus> = new Set(["succeeded", "empty", "superseded", "failed"]);

type VersionRecord = { savedAt: string; hash: string; summary: AiVersionSummary; publication: unknown };

export function summarize(kind: AiRunKind, publication: unknown): AiVersionSummary {
  const p = (publication ?? {}) as Record<string, unknown>;
  const list = (key: string) => Array.isArray(p[key]) ? (p[key] as unknown[]).length : 0;
  return {
    items: list(kind === "findings" ? "findings" : kind === "explainer" || kind === "figures" ? "businesses" : kind === "metrics" ? "metrics" : "items"),
    sources: list("sources"),
    periodEnd: typeof p.periodEnd === "string" ? p.periodEnd : null,
    model: typeof p.model === "string" ? p.model : null,
  };
}
/** When a publication was produced; it names the version. */
export function publishedAt(publication: unknown): string | null {
  const p = (publication ?? {}) as { generatedAt?: unknown; updatedAt?: unknown };
  const at = typeof p.generatedAt === "string" ? p.generatedAt : p.updatedAt;
  return typeof at === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(at) ? at : null;
}
/** Content only: two publications that differ in their timestamp alone are one version. */
async function contentHash(publication: unknown): Promise<string> {
  const { generatedAt: _g, updatedAt: _u, ...rest } = (publication ?? {}) as Record<string, unknown>;
  void _g; void _u;
  return sha256(JSON.stringify(rest));
}

export class AiRunStore {
  private readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }

  /** A new record for a run about to start; a retried request keeps the first record. */
  async start(run: { kind: AiRunKind; ticker: string; runId: string; trigger: AiRunTrigger; accession?: string | null }, now: string): Promise<void> {
    const record: AiRun = { ...run, accession: run.accession ?? null, status: "queued", stage: null, log: [], startedAt: now, updatedAt: now, finishedAt: null, result: null, error: null };
    await this.db.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO NOTHING")
      .bind(runPrefix(run.kind, run.ticker) + run.runId, JSON.stringify(record), now).run();
    await this.prune(runPrefix(run.kind, run.ticker), "$.startedAt", KEEP_RUNS);
  }

  /** Applies a change to a run, creating the record for runs started before records existed. */
  async update(kind: AiRunKind, ticker: string, runId: string, patch: Partial<Pick<AiRun, "status" | "stage" | "finishedAt" | "result" | "error">>, now: string): Promise<void> {
    const base: AiRun = { runId, kind, ticker, trigger: "schedule", status: "running", stage: null, log: [], startedAt: now, updatedAt: now, finishedAt: null, accession: null, result: null, error: null };
    const change = JSON.stringify({ ...patch, updatedAt: now });
    // json_patch treats null as "remove", so nulls are written by json_set instead.
    await this.db.prepare(`INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?1,json_patch(?2,?3),?4)
      ON CONFLICT(cache_key) DO UPDATE SET payload=json_patch(sec_cache.payload,?3),fetched_at=?4`)
      .bind(runPrefix(kind, ticker) + runId, JSON.stringify(base), change, now).run();
  }

  /** Records the step a run has reached; a repeat of the last step (a retry or a replay) is not logged twice. */
  async step(kind: AiRunKind, ticker: string, runId: string, stage: string, now: string, attempt?: number, status: AiRunStatus = "running"): Promise<void> {
    await this.update(kind, ticker, runId, { status, stage }, now);
    const entry = JSON.stringify(attempt && attempt > 1 ? { stage, at: now, attempt } : { stage, at: now });
    await this.db.prepare(`UPDATE sec_cache SET payload=CASE
        WHEN json_array_length(payload,'$.log')>=?3 THEN payload
        WHEN json_extract(payload,'$.log['||max(json_array_length(payload,'$.log')-1,0)||'].stage')=?2 AND ?4 IS NULL THEN payload
        ELSE json_insert(payload,'$.log[#]',json(?5)) END
      WHERE cache_key=?1`).bind(runPrefix(kind, ticker) + runId, stage, KEEP_LOG, attempt && attempt > 1 ? attempt : null, entry).run();
  }

  async finish(kind: AiRunKind, ticker: string, runId: string, outcome: { status: AiRunStatus; result?: unknown; error?: string | null }, now: string): Promise<void> {
    await this.update(kind, ticker, runId, { status: outcome.status, finishedAt: now }, now);
    await this.db.prepare("UPDATE sec_cache SET payload=json_set(payload,'$.result',json(?2),'$.error',?3) WHERE cache_key=?1")
      .bind(runPrefix(kind, ticker) + runId, JSON.stringify(outcome.result ?? null), outcome.error?.slice(0, 1000) ?? null).run();
  }

  async get(kind: AiRunKind, ticker: string, runId: string): Promise<AiRun | null> {
    const row = await this.db.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(runPrefix(kind, ticker) + runId).first<{ payload: string }>();
    return row ? JSON.parse(row.payload) as AiRun : null;
  }

  async runs(kind: AiRunKind, ticker: string, limit = KEEP_RUNS): Promise<AiRun[]> {
    const [from, to] = range(runPrefix(kind, ticker));
    const { results } = await this.db.prepare("SELECT payload FROM sec_cache WHERE cache_key>=? AND cache_key<? ORDER BY json_extract(payload,'$.startedAt') DESC LIMIT ?")
      .bind(from, to, limit).all<{ payload: string }>();
    return results.map(r => JSON.parse(r.payload) as AiRun);
  }

  /** The newest run of every company and kind, without logs or results. */
  async latestRuns(): Promise<Map<string, Pick<AiRun, "runId" | "status" | "stage" | "trigger" | "startedAt" | "updatedAt">>> {
    const [from, to] = range("ai-run:v1:");
    const { results } = await this.db.prepare(`SELECT json_extract(payload,'$.kind') kind,json_extract(payload,'$.ticker') ticker,json_extract(payload,'$.runId') runId,
      json_extract(payload,'$.status') status,json_extract(payload,'$.stage') stage,json_extract(payload,'$.trigger') "trigger",
      json_extract(payload,'$.startedAt') startedAt,json_extract(payload,'$.updatedAt') updatedAt FROM sec_cache WHERE cache_key>=? AND cache_key<?`)
      .bind(from, to).all<{ kind: AiRunKind; ticker: string } & Pick<AiRun, "runId" | "status" | "stage" | "trigger" | "startedAt" | "updatedAt">>();
    const latest = new Map<string, Pick<AiRun, "runId" | "status" | "stage" | "trigger" | "startedAt" | "updatedAt">>();
    for (const { kind, ticker, ...run } of results) {
      const key = `${kind}:${ticker}`, seen = latest.get(key);
      if (!seen || seen.startedAt < run.startedAt) latest.set(key, run);
    }
    return latest;
  }

  /** Keeps a copy of a publication as a version unless the newest version already has the same content. */
  async saveVersion(kind: AiRunKind, ticker: string, publication: unknown, now: string): Promise<void> {
    const id = publishedAt(publication) ?? now;
    const hash = await contentHash(publication);
    const [from, to] = range(versionPrefix(kind, ticker));
    const newest = await this.db.prepare("SELECT json_extract(payload,'$.hash') hash FROM sec_cache WHERE cache_key>=? AND cache_key<? ORDER BY cache_key DESC LIMIT 1")
      .bind(from, to).first<{ hash: string }>();
    if (newest?.hash === hash) return;
    const record: VersionRecord = { savedAt: now, hash, summary: summarize(kind, publication), publication };
    await this.db.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO NOTHING")
      .bind(versionPrefix(kind, ticker) + id, JSON.stringify(record), now).run();
    await this.prune(versionPrefix(kind, ticker), null, KEEP_VERSIONS);
  }

  async versions(kind: AiRunKind, ticker: string): Promise<AiVersion[]> {
    const prefix = versionPrefix(kind, ticker), [from, to] = range(prefix);
    const { results } = await this.db.prepare("SELECT cache_key,json_extract(payload,'$.savedAt') savedAt,json_extract(payload,'$.summary') summary FROM sec_cache WHERE cache_key>=? AND cache_key<? ORDER BY cache_key DESC")
      .bind(from, to).all<{ cache_key: string; savedAt: string; summary: string }>();
    return results.map(r => ({ id: r.cache_key.slice(prefix.length), savedAt: r.savedAt, summary: JSON.parse(r.summary) as AiVersionSummary, current: false }));
  }

  async version(kind: AiRunKind, ticker: string, id: string): Promise<{ savedAt: string; summary: AiVersionSummary; publication: unknown } | null> {
    const row = await this.db.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(versionPrefix(kind, ticker) + id).first<{ payload: string }>();
    return row ? JSON.parse(row.payload) as VersionRecord : null;
  }

  private async prune(prefix: string, order: string | null, keep: number): Promise<void> {
    const [from, to] = range(prefix);
    const by = order ? `json_extract(payload,'${order}')` : "cache_key";
    await this.db.prepare(`DELETE FROM sec_cache WHERE cache_key IN (SELECT cache_key FROM sec_cache WHERE cache_key>=? AND cache_key<? ORDER BY ${by} DESC LIMIT -1 OFFSET ?)`)
      .bind(from, to, keep).run();
  }
}

/** Never lets bookkeeping fail the work it describes. */
export async function quietly(work: () => Promise<unknown>): Promise<void> {
  try { await work(); } catch (error) { console.warn(JSON.stringify({ event: "ai-run-record", error: error instanceof Error ? error.message : String(error) })); }
}
