import { z } from "zod";
import type { SecPipelineEnv } from "../operations.ts";
import type { ResearchMonitorState } from "../../../../shared/analysis-contract/research.ts";
import { ResearchRepository } from "./repository.ts";
import type { ResearchUniverse } from "./monitor.ts";

const universeSchema = z.strictObject({ tickers: z.array(z.string().regex(/^[A-Z0-9.^=-]{1,20}$/)).max(100), asOf: z.string().datetime() });
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
export async function handleResearchRequest(request: Request, env: SecPipelineEnv): Promise<Response> {
  // Separate credential: public analysis read keys cannot inspect a personal research universe.
  if (!env.RESEARCH_SYNC_KEY || request.headers.get("authorization") !== `Bearer ${env.RESEARCH_SYNC_KEY}`) return json({ error: "Unauthorized" }, 401);
  if (!env.DB) return json({ error: "Research storage unavailable" }, 503);
  const url = new URL(request.url), repo = new ResearchRepository(env.DB);
  if (url.pathname === "/research/universe" && request.method === "POST") {
    if (Number(request.headers.get("content-length")) > 16_384) return json({ error: "Request too large" }, 413);
    const text = await request.text();
    if (text.length > 16_384) return json({ error: "Request too large" }, 413);
    let value: unknown; try { value = JSON.parse(text); } catch { return json({ error: "Invalid JSON" }, 400); }
    const parsed = universeSchema.safeParse(value); if (!parsed.success) return json({ error: "Invalid universe" }, 400);
    const now = new Date().toISOString();
    if (Date.parse(parsed.data.asOf) > Date.now() + 60_000) return json({ error: "Future holdings timestamp" }, 400);
    const previous = await repo.state<ResearchUniverse>("universe");
    if (previous && parsed.data.asOf < previous.asOf) return json({ status: "older_snapshot_ignored" });
    const tickers = [...new Set(parsed.data.tickers)].sort();
    await repo.setState("universe", { tickers, asOf: parsed.data.asOf, receivedAt: now } satisfies ResearchUniverse, now);
    return json({ status: "synchronized", count: tickers.length });
  }
  if (url.pathname === "/research/feed" && request.method === "GET") {
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && (!/^\d{1,15}$/.test(cursor) || Number(cursor) <= 0)) return json({ error: "Invalid cursor" }, 400);
    const monitor = await repo.state<ResearchMonitorState>("monitor") ?? {
      enabled: false, holdingsAsOf: null, lastScanAt: null, tickers: [], issues: [],
    };
    return json({ ...await repo.reports(cursor ? Number(cursor) : undefined), monitor });
  }
  return json({ error: "Research route not found" }, 404);
}
