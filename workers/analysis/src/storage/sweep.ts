import type { AnalysisEnv } from "../operations.ts";

/** Removes expired model checkpoints, replay results and web-search cache objects. */
export const STORAGE_SWEEP_VERSION = "storage-sweep.v2";

const HOUR = 60 * 60_000, DAY = 24 * HOUR;
/** R2 list pages one run reads, and keys per delete call (R2 accepts up to 1,000). */
const PAGES_PER_RUN = 12, DELETE_BATCH = 500;
const CURSOR_KEY = "storage-sweep:v2:cursor";

export type SweepContext = { now: number; liveSearchObjects: Set<string> };
export type SweepRule = { prefix: string; why: string; dead(key: string, uploaded: number, ctx: SweepContext): boolean };

const SWEEP_RULES: SweepRule[] = [
  {
    // A model checkpoint resumes a call inside a Workflow step; no step retries for a week.
    prefix: "model-recovery/v1/", why: "model checkpoint older than a week",
    dead: (_key, uploaded, ctx) => ctx.now - uploaded > 7 * DAY,
  },
  {
    // A large step result is read when its Workflow replays; instances are kept for 30 days.
    prefix: "workflow-results/v1/", why: "Workflow step result older than instance retention",
    dead: (_key, uploaded, ctx) => ctx.now - uploaded > 30 * DAY,
  },
  {
    // The search cache reads only the object its D1 row points at, and never one older than 30 days (`service.ts`).
    prefix: "web-search/v1/", why: "search result replaced by a newer one, or past the longest cache age",
    dead: (key, uploaded, ctx) => ctx.now - uploaded > 30 * DAY || (ctx.liveSearchObjects.size > 0 && !ctx.liveSearchObjects.has(key) && ctx.now - uploaded > HOUR),
  },
];

/** D1 cache rows of features that were removed or replaced; no code reads these prefixes any more. */
export const RETIRED_CACHE_PREFIXES = [
  "sec:text:", "sec:ticker-map", "sec:business-flow:", "narrative:v1:", "figures:v1:",
  "findings:", "dossier:", "analyst:", "checkup:", "reader-pin:",
  "item-analysis:", "items:", "ai-version:v1:analyst:", "ai-version:v1:findings:",
  "ai-run:v1:analyst:", "ai-run:v1:findings:", "i18n:v1:zh-CN:item:", "i18n:v1:zh-CN:findings:",
  "operating-metrics:", "ownership:", "admin:backup:",
];

type Cursor = { rule: number; cursor?: string };

async function context(env: AnalysisEnv, now: number): Promise<SweepContext> {
  const live = (await env.DB!.prepare("SELECT object_key FROM web_search_cache WHERE object_key IS NOT NULL").all<{ object_key: string }>()).results;
  return { now, liveSearchObjects: new Set(live.map(r => r.object_key)) };
}

/** One run: a few list pages through the rules in order, resuming where the last run stopped; the cache rows go first. */
export async function sweepStorage(env: AnalysisEnv, now = Date.now()): Promise<{ done: boolean; listed: number; deleted: Record<string, number>; bytes: number; cacheRows: number }> {
  const db = env.DB!, bucket = env.SEC_FILINGS;
  const stored = (await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = ?").bind(CURSOR_KEY).first<{ payload: string }>())?.payload;
  let position: Cursor = stored ? JSON.parse(stored) as Cursor : { rule: 0 };
  let cacheRows = 0;
  if (!stored) {
    // Key ranges, not LIKE: D1 caps LIKE patterns, and a range uses the primary key.
    for (const prefix of RETIRED_CACHE_PREFIXES) {
      const result = await db.prepare("DELETE FROM sec_cache WHERE cache_key >= ? AND cache_key < ?").bind(prefix, `${prefix}￿`).run();
      cacheRows += result.meta?.changes ?? 0;
    }
  }
  const ctx = await context(env, now);
  const deleted: Record<string, number> = {};
  let listed = 0, bytes = 0, pages = 0;
  const deadSearch: string[] = [];
  while (position.rule < SWEEP_RULES.length && pages < PAGES_PER_RUN) {
    const rule = SWEEP_RULES[position.rule]!;
    const page = await bucket.list({ prefix: rule.prefix, cursor: position.cursor, limit: 1000 }) as { objects: Array<{ key: string; uploaded: Date; size?: number }>; truncated: boolean; cursor?: string };
    pages++; listed += page.objects.length;
    const dead = page.objects.filter(o => rule.dead(o.key, o.uploaded.getTime(), ctx));
    for (let i = 0; i < dead.length; i += DELETE_BATCH) await bucket.delete(dead.slice(i, i + DELETE_BATCH).map(o => o.key));
    if (dead.length) deleted[rule.prefix] = (deleted[rule.prefix] ?? 0) + dead.length;
    bytes += dead.reduce((n, o) => n + (o.size ?? 0), 0);
    if (rule.prefix === "web-search/v1/") deadSearch.push(...dead.map(o => o.key));
    position = page.truncated && page.cursor ? { rule: position.rule, cursor: page.cursor } : { rule: position.rule + 1 };
  }
  // A search row whose object is gone reads as a cache miss; drop it unless a writer holds its lease right now.
  for (let i = 0; i < deadSearch.length; i += 200) {
    await db.prepare("DELETE FROM web_search_cache WHERE object_key IN (SELECT value FROM json_each(?)) AND lease_until <= ?").bind(JSON.stringify(deadSearch.slice(i, i + 200)), now).run();
  }
  const done = position.rule >= SWEEP_RULES.length;
  const at = new Date(now).toISOString();
  await (done
    ? db.prepare("DELETE FROM sec_cache WHERE cache_key = ?").bind(CURSOR_KEY)
    : db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at").bind(CURSOR_KEY, JSON.stringify(position), at)).run();
  return { done, listed, deleted, bytes, cacheRows };
}
