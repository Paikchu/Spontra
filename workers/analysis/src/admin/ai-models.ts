import { AI_EFFORTS, AI_MODELS, type AiEffort, type AiModel, type AiModelSettings, type AiToolModelRow } from "../../../../shared/analysis-contract/ai-models-admin.ts";
import { AI_TOOL_NAMES, AI_TOOLS, defaultModelFor, defaultReasoningFor } from "../ai-config.ts";
import type { AnalysisEnv } from "../operations.ts";
import { authenticateAdmin } from "./auth.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
type Row = { tool: string; model: string | null; effort: string | null; updated_at: string };
const isModel = (value: unknown): value is AiModel => typeof value === "string" && (AI_MODELS as readonly string[]).includes(value);
const isEffort = (value: unknown): value is AiEffort => typeof value === "string" && (AI_EFFORTS as readonly string[]).includes(value);

/** Every AI tool with its deployment default and the stored choice, read from the table rather than the request's environment. */
export async function aiModelSettings(db: D1Database, env: AnalysisEnv): Promise<AiModelSettings> {
  const rows = await db.prepare("SELECT tool, model, effort, updated_at FROM ai_tool_settings").bind().all<Row>().catch(() => null);
  const stored = new Map((rows?.results ?? []).map(row => [row.tool, row]));
  const tools: AiToolModelRow[] = AI_TOOL_NAMES.map(tool => {
    const row = stored.get(tool);
    return {
      tool, label: AI_TOOLS[tool].label, defaultModel: defaultModelFor(env, tool), defaultEffort: defaultReasoningFor(env, tool),
      model: isModel(row?.model) ? row.model : null, effort: isEffort(row?.effort) ? row.effort : null, updatedAt: row?.updated_at ?? null,
    };
  });
  return { tools, models: AI_MODELS, efforts: AI_EFFORTS };
}

/** `GET /admin/ai/models` lists the tools; `POST /admin/ai/models/:tool` stores one tool's model and effort (null = default). */
export async function handleAiModelsAdminRequest(request: Request, env: AnalysisEnv, now = Date.now()): Promise<Response> {
  if (!await authenticateAdmin(request, env.REPORT_ADMIN_PASSWORD, now)) return json({ error: "请登录管理后台。" }, 401);
  if (!env.DB) return json({ error: "数据服务尚未连接。" }, 503);
  const path = new URL(request.url).pathname;
  if (path === "/admin/ai/models" && request.method === "GET") return json(await aiModelSettings(env.DB, env));
  const match = /^\/admin\/ai\/models\/([a-z-]{2,40})$/.exec(path);
  if (!match || request.method !== "POST") return json({ error: "Not found" }, 404);
  const tool = match[1]!;
  if (!(tool in AI_TOOLS)) return json({ error: "未知的功能。" }, 404);
  let body: { model?: unknown; effort?: unknown };
  try { body = await request.json() as typeof body; } catch { return json({ error: "请求格式无效。" }, 400); }
  if (body.model !== null && !isModel(body.model)) return json({ error: "不支持的模型。" }, 400);
  if (body.effort !== null && !isEffort(body.effort)) return json({ error: "不支持的推理强度。" }, 400);
  if (body.model === null && body.effort === null) await env.DB.prepare("DELETE FROM ai_tool_settings WHERE tool = ?").bind(tool).run();
  else await env.DB.prepare(`INSERT INTO ai_tool_settings (tool, model, effort, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (tool) DO UPDATE SET model = excluded.model, effort = excluded.effort, updated_at = excluded.updated_at`)
    .bind(tool, body.model, body.effort, new Date(now).toISOString()).run();
  return json(await aiModelSettings(env.DB, env));
}
