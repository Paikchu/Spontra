import { getAgentByName, routeAgentRequest } from "agents";
import type { AnalysisEnv } from "../operations.ts";
import { reserve } from "./budget.ts";
import { issueReader, readerOf } from "./identity.ts";
import { readStageSwitch, stageOpenFor } from "./settings.ts";
import type { StageAgent, StageProps } from "./agent.ts";

/**
 * The stage's only door (docs/stage-agent-design.md §3.1), reached from the business map over a Service Binding to this
 * named entrypoint, so the binding is the credential. The map passes the reader's signed token (from its HttpOnly
 * cookie) and a hash of the address; everything that decides who the reader is and what they may spend happens here.
 * Only StageAgent is routable, and only for a conversation registered to the reader: an unknown name is a 404 that
 * never creates an object.
 */
const TICKER = /^[A-Z][A-Z0-9.-]{0,11}$/;
const CONVERSATION = /^[0-9a-f]{32}$/;
const LOCALES = new Set(["en", "zh-CN"]);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

export async function handleStageRequest(request: Request, env: AnalysisEnv & { StageAgent?: DurableObjectNamespace }): Promise<Response> {
  const url = new URL(request.url);
  const db = env.DB;
  if (!db) return json({ error: "unavailable" }, 503);
  const address = /^[0-9a-f]{64}$/.test(request.headers.get("x-spontra-address") ?? "") ? `ip:${request.headers.get("x-spontra-address")}` : null;
  const reader = await readerOf(env.REPORT_ADMIN_PASSWORD, request.headers.get("x-spontra-token"));

  // Whether the stage is open for a company: the page asks before it shows the entry button.
  if (url.pathname === "/agents/status" && request.method === "GET") {
    const ticker = url.searchParams.get("ticker") ?? "";
    const open = TICKER.test(ticker) && stageOpenFor(await readStageSwitch(env), ticker);
    return json({ open, reader: reader != null });
  }

  // A new anonymous reader: limited per address, so ids cannot be minted in bulk.
  if (url.pathname === "/agents/identity" && request.method === "POST") {
    if (reader) return json({ reader: true });
    if (!env.REPORT_ADMIN_PASSWORD) return json({ error: "unavailable" }, 503);
    const spent = await reserve(db, "stage-identities", { reader: null, address });
    if (!spent.ok) return json({ error: "quota", which: spent.which }, 429);
    const issued = await issueReader(env.REPORT_ADMIN_PASSWORD);
    return json({ reader: true, token: issued.token });
  }

  if (!reader) return json({ error: "no-reader" }, 401);

  if (url.pathname === "/agents/conversations" && request.method === "GET") {
    const ticker = url.searchParams.get("ticker") ?? "";
    if (!TICKER.test(ticker)) return json({ error: "bad-request" }, 400);
    const rows = (await db.prepare("SELECT id, last_at, turns FROM stage_conversations WHERE user_id = ? AND ticker = ? AND status = 'active' ORDER BY last_at DESC LIMIT 20").bind(reader, ticker).all<{ id: string; last_at: string; turns: number }>()).results;
    return json({ conversations: rows.map(r => ({ id: r.id, lastAt: r.last_at, turns: r.turns })) });
  }

  if (url.pathname === "/agents/conversations" && request.method === "POST") {
    const body = await request.json().catch(() => null) as { ticker?: unknown; locale?: unknown } | null;
    const ticker = typeof body?.ticker === "string" ? body.ticker : "";
    const locale = typeof body?.locale === "string" && LOCALES.has(body.locale) ? body.locale : "en";
    if (!TICKER.test(ticker)) return json({ error: "bad-request" }, 400);
    if (!stageOpenFor(await readStageSwitch(env), ticker)) return json({ error: "stage-off" }, 503);
    const spent = await reserve(db, "stage-conversations", { reader, address });
    if (!spent.ok) return json({ error: "quota", which: spent.which }, 429);
    const now = new Date().toISOString();
    // Thirty days on, a reader's conversations are archived and their objects emptied when they next start one.
    const expired = (await db.prepare("SELECT id FROM stage_conversations WHERE user_id = ? AND status = 'active' AND last_at < ?").bind(reader, new Date(Date.now() - 30 * 86_400_000).toISOString()).all<{ id: string }>()).results;
    for (const row of expired) await forget(env, row.id);
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
    await db.prepare("INSERT INTO stage_conversations (id, user_id, ticker, locale, created_at, last_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, reader, ticker, locale, now, now).run();
    // Twenty open conversations at most: the oldest goes.
    const extra = (await db.prepare("SELECT id FROM stage_conversations WHERE user_id = ? AND status = 'active' ORDER BY last_at DESC LIMIT -1 OFFSET 20").bind(reader).all<{ id: string }>()).results;
    for (const row of extra) await forget(env, row.id);
    return json({ id }, 201);
  }

  const agent = /^\/agents\/stage-agent\/([^/]+)(?:\/.*)?$/.exec(url.pathname);
  if (agent && env.StageAgent) {
    const id = agent[1]!;
    if (!CONVERSATION.test(id)) return json({ error: "not-found" }, 404);
    const row = await db.prepare("SELECT ticker, locale FROM stage_conversations WHERE id = ? AND user_id = ? AND status = 'active'").bind(id, reader).first<{ ticker: string; locale: string }>();
    if (!row) return json({ error: "not-found" }, 404);
    const forwarded = new Request(request);
    forwarded.headers.delete("x-spontra-token");
    forwarded.headers.set("x-spontra-reader", reader);
    if (address) forwarded.headers.set("x-spontra-address", address); else forwarded.headers.delete("x-spontra-address");
    const props: StageProps = { userId: reader, ticker: row.ticker, locale: row.locale === "zh-CN" ? "zh-CN" : "en" };
    return await routeAgentRequest(forwarded, { StageAgent: env.StageAgent }, { props }) ?? json({ error: "not-found" }, 404);
  }
  return json({ error: "not-found" }, 404);
}

/** Archives a conversation and empties its object. */
async function forget(env: AnalysisEnv & { StageAgent?: DurableObjectNamespace }, id: string): Promise<void> {
  await env.DB!.prepare("UPDATE stage_conversations SET status = 'archived' WHERE id = ?").bind(id).run().catch(() => {});
  if (!env.StageAgent) return;
  try { await (await getAgentByName(env.StageAgent as unknown as DurableObjectNamespace<StageAgent>, id)).purge(); } catch { /* An object that never started has nothing to empty. */ }
}
