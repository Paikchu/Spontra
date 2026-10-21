import { parseTrackedTickers } from "../sec/config.ts";

/**
 * The stage's switch and company list (docs/stage-agent-design.md §3.4), in `stage_settings`: the row for `*` is the
 * global switch, a company's row adds or removes it. Default off; the default list is the AI list. Kept in D1 so turning the stage off needs no deploy.
 */
export type StageSwitch = { enabled: boolean; tickers: string[] };
type Env = { DB?: D1Database; STAGE_ENABLED?: string; SEC_AI_TICKERS?: string; SEC_TRACKED_TICKERS?: string };

export async function readStageSwitch(env: Env): Promise<StageSwitch> {
  const tickers = new Set(parseTrackedTickers(env.SEC_AI_TICKERS ?? env.SEC_TRACKED_TICKERS ?? ""));
  let enabled = env.STAGE_ENABLED === "true";
  const rows = env.DB ? await env.DB.prepare("SELECT ticker, enabled FROM stage_settings").bind().all<{ ticker: string; enabled: number }>().catch(() => null) : null;
  for (const row of rows?.results ?? []) {
    if (row.ticker === "*") enabled = !!row.enabled;
    else if (row.enabled) tickers.add(row.ticker); else tickers.delete(row.ticker);
  }
  return { enabled, tickers: [...tickers].sort() };
}

export const stageOpenFor = (s: StageSwitch, ticker: string) => s.enabled && s.tickers.includes(ticker);

/** Sets the global switch (`ticker` null) or one company's. */
export async function writeStageSwitch(db: D1Database, ticker: string | null, on: boolean, now: string): Promise<void> {
  await db.prepare("INSERT INTO stage_settings (ticker, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(ticker) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at")
    .bind(ticker ?? "*", on ? 1 : 0, now).run();
}
