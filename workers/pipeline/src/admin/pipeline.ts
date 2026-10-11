import { MANUAL_PIPELINE_EVENTS, type PipelineDead, type PipelineDue, type PipelineLogEntry, type PipelineOverview, type PipelineTrail } from "../../../../shared/analysis-contract/pipeline-admin.ts";
import type { SecPipelineEnv } from "../operations.ts";
import { readEventMessage, readTaskMessage } from "../pipeline/messages.ts";
import { emit } from "../pipeline/outbox.ts";
import { delaySeconds, scopeTickers } from "../pipeline/router.ts";
import { TASK_NAMES } from "../pipeline/registry.ts";
import { TASK_IMPLEMENTATIONS } from "../pipeline/tasks.ts";
import { authenticateAdmin } from "./auth.ts";
import { DISCOVERY_HEARTBEAT_KEY } from "../pipeline/discovery.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
const LOG_COLUMNS = "id, message_id AS messageId, cause_id AS causeId, kind, name, ticker, outcome, detail, created_at AS createdAt";
const TICKER = /^[A-Z][A-Z0-9.-]{0,11}$/;

async function overview(env: SecPipelineEnv, db: D1Database, ticker: string | null): Promise<PipelineOverview> {
  const [outbox, due, dead, log, versions, heartbeat, companies] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS pending, MIN(created_at) AS oldestAt FROM pipeline_outbox").first<{ pending: number; oldestAt: string | null }>(),
    db.prepare("SELECT ticker, task, due_at AS dueAt, first_requested_at AS firstRequestedAt, cause_id AS causeId FROM pipeline_due ORDER BY due_at LIMIT 200").all<PipelineDue>(),
    db.prepare("SELECT id, kind, name, ticker, attempts, created_at AS createdAt, body FROM pipeline_dead ORDER BY created_at DESC LIMIT 100").all<PipelineDead>(),
    ticker
      ? db.prepare(`SELECT ${LOG_COLUMNS} FROM pipeline_log WHERE ticker = ? ORDER BY created_at DESC LIMIT 200`).bind(ticker).all<PipelineLogEntry>()
      : db.prepare(`SELECT ${LOG_COLUMNS} FROM pipeline_log ORDER BY created_at DESC LIMIT 200`).all<PipelineLogEntry>(),
    db.prepare("SELECT payload, deployed_at FROM pipeline_versions WHERE id = 'tasks'").first<{ payload: string; deployed_at: string }>(),
    db.prepare("SELECT fetched_at FROM sec_cache WHERE cache_key = ?").bind(DISCOVERY_HEARTBEAT_KEY).first<{ fetched_at: string }>(),
    scopeTickers(env, "data"),
  ]);
  let announced: Record<string, string> | null = null;
  try { announced = versions ? JSON.parse(versions.payload) as Record<string, string> : null; } catch { /* shown as unknown */ }
  return {
    discoveryAt: heartbeat?.fetched_at ?? null,
    discoveryStale: !!heartbeat && Date.now() - Date.parse(heartbeat.fetched_at) > 30 * 60_000,
    outbox: { pending: outbox?.pending ?? 0, oldestAt: outbox?.oldestAt ?? null, stale: !!outbox?.oldestAt && Date.now() - Date.parse(outbox.oldestAt) > 15 * 60_000 },
    due: due.results, dead: dead.results, log: log.results,
    versions: { current: Object.fromEntries(TASK_NAMES.map(task => [task, TASK_IMPLEMENTATIONS[task].version])), announced, deployedAt: versions?.deployed_at ?? null },
    companies,
  };
}

/** Follows `cause_id` from one message back to the event that started its chain. */
async function trail(db: D1Database, messageId: string): Promise<PipelineTrail> {
  const entries: PipelineLogEntry[] = [];
  let next: string | null = messageId;
  for (let step = 0; next && step < 20; step++) {
    const entry: PipelineLogEntry | null = await db.prepare(`SELECT ${LOG_COLUMNS} FROM pipeline_log WHERE message_id = ? ORDER BY created_at DESC LIMIT 1`).bind(next).first<PipelineLogEntry>();
    if (!entry) break;
    entries.push(entry);
    next = entry.causeId;
  }
  return { entries };
}

/** Puts a dead message back: an event goes through the outbox again, a task is made due now. */
async function replay(env: SecPipelineEnv, db: D1Database, id: string): Promise<Response> {
  const row = await db.prepare("SELECT body FROM pipeline_dead WHERE id = ?").bind(id).first<{ body: string }>();
  if (!row) return json({ error: "该消息不存在或已处理。" }, 404);
  const body = JSON.parse(row.body) as unknown;
  const event = readEventMessage(body), task = readTaskMessage(body);
  if (event) {
    await emit(env, [{ type: event.type, ticker: event.ticker, cik: event.cik, task: event.task, detail: event.detail, causeId: event.id }]);
  } else if (task) {
    if (!env.PIPELINE_TASKS) return json({ error: "任务队列未配置。" }, 503);
    const now = Date.now(), dueAt = new Date(now).toISOString();
    await db.prepare(`INSERT INTO pipeline_due (ticker, task, due_at, first_requested_at, cause_id) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (ticker, task) DO UPDATE SET due_at = excluded.due_at, first_requested_at = excluded.first_requested_at, cause_id = excluded.cause_id`)
      .bind(task.ticker, task.task, dueAt, dueAt, task.id).run();
    await env.PIPELINE_TASKS.send({ ...task, id: crypto.randomUUID(), causeId: task.id, dueAt }, { contentType: "json", delaySeconds: delaySeconds(dueAt, now) });
  } else {
    return json({ error: "无法识别该消息，只能关闭。" }, 409);
  }
  await db.prepare("DELETE FROM pipeline_dead WHERE id = ?").bind(id).run();
  return json({ status: "replayed" }, 202);
}

async function manualEvent(env: SecPipelineEnv, body: { type?: unknown; ticker?: unknown }): Promise<Response> {
  const definition = MANUAL_PIPELINE_EVENTS.find(e => e.type === body.type);
  if (!definition) return json({ error: "不支持手动发送该事件。" }, 400);
  let ticker = "*";
  if (definition.scope === "company") {
    if (typeof body.ticker !== "string" || !TICKER.test(body.ticker)) return json({ error: "请选择公司。" }, 400);
    if (!(await scopeTickers(env, "data")).includes(body.ticker)) return json({ error: "该公司不在数据白名单中。" }, 404);
    ticker = body.ticker;
  }
  await emit(env, [{ type: definition.type, ticker, causeId: null }]);
  return json({ status: "sent" }, 202);
}

export async function handlePipelineAdminRequest(request: Request, env: SecPipelineEnv): Promise<Response> {
  if (!await authenticateAdmin(request, env.REPORT_ADMIN_PASSWORD)) return json({ error: "请登录管理后台。" }, 401);
  if (!env.DB) return json({ error: "数据服务尚未连接。" }, 503);
  const db = env.DB, url = new URL(request.url), path = url.pathname;
  try {
    if (path === "/admin/pipeline" && request.method === "GET") {
      const ticker = url.searchParams.get("ticker");
      return json(await overview(env, db, ticker && TICKER.test(ticker) ? ticker : null));
    }
    const trailMatch = /^\/admin\/pipeline\/trail\/([A-Za-z0-9-]{1,64})$/.exec(path);
    if (trailMatch && request.method === "GET") return json(await trail(db, trailMatch[1]!));
    if (path === "/admin/pipeline/events" && request.method === "POST") return manualEvent(env, await request.json() as Record<string, unknown>);
    const deadMatch = /^\/admin\/pipeline\/dead\/([A-Za-z0-9-]{1,64})\/(replay|dismiss)$/.exec(path);
    if (deadMatch && request.method === "POST") {
      if (deadMatch[2] === "replay") return replay(env, db, deadMatch[1]!);
      await db.prepare("DELETE FROM pipeline_dead WHERE id = ?").bind(deadMatch[1]).run();
      return json({ status: "dismissed" });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: "操作参数无效。" }, 400);
    console.error(JSON.stringify({ event: "pipeline-admin", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "事件服务暂时不可用，请重试。" }, 503);
  }
}
