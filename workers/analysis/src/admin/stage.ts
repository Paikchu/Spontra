import type { StageAdmin } from "../../../../shared/analysis-contract/stage-admin.ts";
import { getAgentByName } from "agents";
import type { AnalysisEnv } from "../operations.ts";
import type { StageAgent } from "../stage/agent.ts";
import { STAGE_LIMITS } from "../stage/budget.ts";
import { sha256 } from "../sha256.ts";
import { authenticateAdmin } from "./auth.ts";
import { json } from "./http.ts";


async function stageAdmin(db: D1Database): Promise<StageAdmin> {
  const day = new Date().toISOString().slice(0, 10);
  const budget = (await db.prepare("SELECT feature, units FROM feature_budget WHERE day = ? AND feature LIKE 'stage-%'").bind(day).all<{ feature: string; units: number }>().catch(() => ({ results: [] }))).results;
  const usage = await db.prepare("SELECT count(*) calls, coalesce(sum(input_tokens),0) input, coalesce(sum(output_tokens),0) output FROM ai_usage WHERE kind = 'stage' AND at >= ?").bind(day).first<{ calls: number; input: number; output: number }>().catch(() => null);
  const rows = (await db.prepare("SELECT id, user_id, ticker, created_at, last_at, turns, status FROM stage_conversations ORDER BY last_at DESC LIMIT 50").bind().all<{ id: string; user_id: string; ticker: string; created_at: string; last_at: string; turns: number; status: string }>().catch(() => ({ results: [] }))).results;
  return {
    today: Object.entries(STAGE_LIMITS).map(([feature, limits]) => ({ feature, units: budget.find(b => b.feature === feature)?.units ?? 0, cap: limits.global })),
    usage: { calls: usage?.calls ?? 0, inputTokens: usage?.input ?? 0, outputTokens: usage?.output ?? 0 },
    // The admin sees a reader only as a hash, never the id that would let it act as them.
    conversations: await Promise.all(rows.map(async r => ({ id: r.id, reader: (await sha256(r.user_id)).slice(0, 12), ticker: r.ticker, createdAt: r.created_at, lastAt: r.last_at, turns: r.turns, status: r.status }))),
  };
}

/** `GET /admin/ai/stage` reads the stage's spend and conversations; the stage itself is open on every company page. */
export async function handleStageAdminRequest(request: Request, env: AnalysisEnv, now = Date.now()): Promise<Response> {
  if (!await authenticateAdmin(request, env.REPORT_ADMIN_PASSWORD, now)) return json({ error: "请登录管理后台。" }, 401);
  if (!env.DB) return json({ error: "数据服务尚未连接。" }, 503);
  const path = new URL(request.url).pathname;
  if (path === "/admin/ai/stage" && request.method === "GET") return json(await stageAdmin(env.DB));
  const detail = /^\/admin\/ai\/stage\/conversations\/([0-9a-f]{32})$/.exec(path);
  const namespace = (env as AnalysisEnv & { StageAgent?: DurableObjectNamespace }).StageAgent;
  if (detail && request.method === "GET" && namespace) {
    const row = await env.DB.prepare("SELECT id FROM stage_conversations WHERE id = ?").bind(detail[1]).first();
    if (!row) return json({ error: "Not found" }, 404);
    const runs = (await env.DB.prepare("SELECT id, kind, status, started_at, finished_at, result, error FROM user_runs WHERE conversation_id = ? ORDER BY started_at DESC LIMIT 50").bind(detail[1]).all()).results;
    const usage = (await env.DB.prepare("SELECT at, stage, model, outcome, input_tokens, cached_tokens, output_tokens FROM ai_usage WHERE conversation_id = ? ORDER BY at DESC LIMIT 200").bind(detail[1]).all()).results;
    const agent = await getAgentByName(namespace as unknown as DurableObjectNamespace<StageAgent>, detail[1]);
    const inspected = await agent.inspect() as unknown as Record<string, unknown>;
    return json({ ...inspected, runs, usage });
  }
  return json({ error: "Not found" }, 404);
}
