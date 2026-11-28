import { AI_EFFORTS, AI_MODELS, type AiEffort, type AiEndpoint, type AiModelSettings, type AiToolModelRow } from "./types/ai-models-admin.ts";
import { AI_TOOL_NAMES, AI_TOOLS, defaultModelFor, defaultReasoningFor } from "../../ai/config.ts";
import { listEndpoints } from "../../ai/pi/endpoints.ts";
import type { AnalysisEnv } from "../../operations.ts";
import { authenticateAdmin } from "./auth.ts";
import { json } from "./http.ts";

type Row = { tool: string; model: string | null; effort: string | null; updated_at: string };
const isEffort = (value: unknown): value is AiEffort => typeof value === "string" && (AI_EFFORTS as readonly string[]).includes(value);
const NAME = /^[A-Za-z0-9._-]{1,64}$/;

function publicEndpoint(row: { name: string; url: string; apiKey: string; thinkingLevel: AiEffort }, updatedAt: string): AiEndpoint {
  const hint = row.apiKey.length > 4 ? row.apiKey.slice(-4) : "";
  return { name: row.name, url: row.url, thinkingLevel: row.thinkingLevel, keyHint: hint, updatedAt };
}

/** Every AI tool with its deployment default and the stored choice, read from the table rather than the request's environment. */
export async function aiModelSettings(db: D1Database, env: AnalysisEnv): Promise<AiModelSettings> {
  const rows = await db.prepare("SELECT tool, model, effort, updated_at FROM ai_tool_settings").bind().all<Row>().catch(() => null);
  const endpoints = await listEndpoints(db);
  const names = new Set<string>([...AI_MODELS, ...endpoints.map((endpoint) => endpoint.name)]);
  const stored = new Map((rows?.results ?? []).map(row => [row.tool, row]));
  const tools: AiToolModelRow[] = AI_TOOL_NAMES.map(tool => {
    const row = stored.get(tool);
    return {
      tool, label: AI_TOOLS[tool].label, defaultModel: defaultModelFor(env, tool), defaultEffort: defaultReasoningFor(env, tool),
      model: row?.model && names.has(row.model) ? row.model : null, effort: isEffort(row?.effort) ? row.effort : null, updatedAt: row?.updated_at ?? null,
    };
  });
  const stamps = await db.prepare("SELECT name, updated_at FROM ai_endpoints").all<{ name: string; updated_at: string }>().catch(() => null);
  const updated = new Map((stamps?.results ?? []).map((row) => [row.name, row.updated_at]));
  return { tools, models: AI_MODELS, efforts: AI_EFFORTS, endpoints: endpoints.map((endpoint) => publicEndpoint(endpoint, updated.get(endpoint.name) ?? "")) };
}

/** `GET /admin/ai/models` lists the tools; `POST /admin/ai/models/:tool` stores one tool's model and effort (null = default). */
export async function handleAiModelsAdminRequest(request: Request, env: AnalysisEnv, now = Date.now()): Promise<Response> {
  if (!await authenticateAdmin(request, env.REPORT_ADMIN_PASSWORD, now)) return json({ error: "请登录管理后台。" }, 401);
  if (!env.DB) return json({ error: "数据服务尚未连接。" }, 503);
  const path = new URL(request.url).pathname;
  if (path === "/admin/ai/models" && request.method === "GET") return json(await aiModelSettings(env.DB, env));
  if (path === "/admin/ai/endpoints" && request.method === "POST") return saveEndpoint(request, env, now);
  const removed = /^\/admin\/ai\/endpoints\/([A-Za-z0-9._-]{1,64})$/.exec(path);
  if (removed && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM ai_endpoints WHERE name = ?").bind(decodeURIComponent(removed[1]!)).run();
    return json(await aiModelSettings(env.DB, env));
  }
  const match = /^\/admin\/ai\/models\/([a-z-]{2,40})$/.exec(path);
  if (!match || request.method !== "POST") return json({ error: "Not found" }, 404);
  const tool = match[1]!;
  if (!(tool in AI_TOOLS)) return json({ error: "未知的功能。" }, 404);
  let body: { model?: unknown; effort?: unknown };
  try { body = await request.json() as typeof body; } catch { return json({ error: "请求格式无效。" }, 400); }
  const known = new Set<string>([...AI_MODELS, ...(await listEndpoints(env.DB)).map((endpoint) => endpoint.name)]);
  if (body.model !== null && (typeof body.model !== "string" || !known.has(body.model))) return json({ error: "不支持的模型。" }, 400);
  if (body.effort !== null && !isEffort(body.effort)) return json({ error: "不支持的推理强度。" }, 400);
  if (body.model === null && body.effort === null) await env.DB.prepare("DELETE FROM ai_tool_settings WHERE tool = ?").bind(tool).run();
  else await env.DB.prepare(`INSERT INTO ai_tool_settings (tool, model, effort, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (tool) DO UPDATE SET model = excluded.model, effort = excluded.effort, updated_at = excluded.updated_at`)
    .bind(tool, body.model, body.effort, new Date(now).toISOString()).run();
  return json(await aiModelSettings(env.DB, env));
}

async function saveEndpoint(request: Request, env: AnalysisEnv, now: number): Promise<Response> {
  let body: { name?: unknown; url?: unknown; apiKey?: unknown; thinkingLevel?: unknown };
  try { body = await request.json() as typeof body; } catch { return json({ error: "请求格式无效。" }, 400); }
  if (typeof body.name !== "string" || !NAME.test(body.name)) return json({ error: "名称只能使用字母、数字、点、下划线和短横线。" }, 400);
  if ((body as { remove?: unknown }).remove === true) {
    await env.DB!.prepare("DELETE FROM ai_endpoints WHERE name = ?").bind(body.name).run();
    return json(await aiModelSettings(env.DB!, env));
  }
  let url: URL;
  try { url = new URL(typeof body.url === "string" ? body.url : ""); } catch { return json({ error: "API 地址无效。" }, 400); }
  if (url.protocol !== "https:" && url.protocol !== "http:") return json({ error: "API 地址需要是 http 或 https。" }, 400);
  if (!isEffort(body.thinkingLevel)) return json({ error: "不支持的推理强度。" }, 400);
  const existing = (await listEndpoints(env.DB!)).find((endpoint) => endpoint.name === body.name);
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey && !existing) return json({ error: "需要填写 API Key。" }, 400);
  if (apiKey && (apiKey.length < 8 || apiKey.length > 400)) return json({ error: "API Key 长度不对。" }, 400);
  const base = url.origin + url.pathname.replace(/\/$/, "");
  await env.DB!.prepare(`INSERT INTO ai_endpoints (name, base_url, api_key, thinking_level, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET base_url = excluded.base_url, api_key = excluded.api_key, thinking_level = excluded.thinking_level, updated_at = excluded.updated_at`)
    .bind(body.name, base, apiKey || existing!.apiKey, body.thinkingLevel, new Date(now).toISOString()).run();
  return json(await aiModelSettings(env.DB!, env));
}
