import { AI_RUN_KINDS, type AiCompanies, type AiCompanyDetail, type AiKindState, type AiRun, type AiRunKind, type AiRunStarted, type AiVersion, type AiVersionDetail } from "../../../../shared/analysis-contract/ai-runs-admin.ts";
import { AiRunStore, publishedAt, summarize, TERMINAL } from "../ai-runs/store.ts";
import { businessExplainerFingerprint, readBusinessExplainerResponse } from "../business-explainer/workflow.ts";
import { findSecurity } from "../catalog/security-directory.ts";
import { trackedTickersFor } from "../core.ts";
import { findingsFingerprint } from "../findings/workflow.ts";
import { readFindingsResponse } from "../findings/read.ts";
import { GuidanceStore } from "../guidance/store.ts";
import { earningsEvents, readGuidanceResponse } from "../guidance/workflow.ts";
import type { AiWorkflowBinding, SecPipelineEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { SecFilingFeed } from "../sec/sec.ts";
import { authenticateAdmin } from "./auth.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
/** A run with no news for this long is checked against the Workflow engine. */
const SETTLE_AFTER_MS = 60_000, MISSING_AFTER_MS = 10 * 60_000;

type Binding = AiWorkflowBinding<Record<string, unknown>>;
function binding(env: SecPipelineEnv, kind: AiRunKind): Binding | undefined {
  return (kind === "findings" ? env.FINDINGS_WORKFLOW : kind === "explainer" ? env.BUSINESS_EXPLAINER_WORKFLOW : env.GUIDANCE_WORKFLOW) as Binding | undefined;
}
function blocked(env: SecPipelineEnv, kind: AiRunKind): string | null {
  if (!binding(env, kind)) return "该任务的工作流未配置。";
  if (!env.DEEPSEEK_API_KEY) return "模型密钥未配置。";
  if (kind === "explainer" && !env.TAVILY_API_KEY) return "资料检索未配置，无法撰写业务解读。";
  return null;
}
function automatic(env: SecPipelineEnv, kind: AiRunKind): boolean {
  return kind === "findings" ? env.FINDINGS_ENABLED === "true" && !!env.FINDINGS_WORKFLOW
    : kind === "explainer" ? !!env.BUSINESS_EXPLAINER_WORKFLOW && !!env.TAVILY_API_KEY
    : env.GUIDANCE_ENABLED === "true" && !!env.GUIDANCE_WORKFLOW;
}
/** The publication readers are served now, validated the same way the public read API does. */
async function currentPublication(db: D1Database, kind: AiRunKind, ticker: string): Promise<unknown> {
  if (kind === "findings") return (await readFindingsResponse(db, ticker)).findings;
  if (kind === "explainer") return (await readBusinessExplainerResponse(db, ticker)).explainer;
  return (await readGuidanceResponse(db, ticker)).guidance;
}
function currentVersion(kind: AiRunKind, publication: unknown): AiVersion | null {
  const id = publication ? publishedAt(publication) : null;
  return id ? { id, savedAt: id, summary: summarize(kind, publication), current: true } : null;
}

/** Settles runs whose Workflow ended (or vanished) without writing its outcome, e.g. after termination. */
async function settle(env: SecPipelineEnv, store: AiRunStore, runs: AiRun[], now: number): Promise<AiRun[]> {
  const engine = runs.length ? binding(env, runs[0]!.kind) : undefined;
  if (!engine?.get) return runs;
  let checked = 0;
  return Promise.all(runs.map(async run => {
    if (TERMINAL.has(run.status) || now - Date.parse(run.updatedAt) < SETTLE_AFTER_MS || checked++ >= 5) return run;
    const at = new Date(now).toISOString();
    try {
      const state = await (await engine.get!(run.runId)).status();
      if (state.status === "errored" || state.status === "terminated") {
        const error = state.status === "terminated" ? "工作流已被终止。" : typeof state.error === "string" ? state.error : (state.error as { message?: string } | undefined)?.message ?? "工作流执行失败。";
        await store.finish(run.kind, run.ticker, run.runId, { status: "failed", error }, at);
        return { ...run, status: "failed" as const, error, finishedAt: at };
      }
      if (state.status === "complete") {
        await store.finish(run.kind, run.ticker, run.runId, { status: "succeeded", result: run.result }, at);
        return { ...run, status: "succeeded" as const, finishedAt: at };
      }
      return run;
    } catch {
      if (now - Date.parse(run.startedAt) < MISSING_AFTER_MS) return run;
      const error = "找不到对应的工作流实例。";
      await store.finish(run.kind, run.ticker, run.runId, { status: "failed", error }, at);
      return { ...run, status: "failed" as const, error, finishedAt: at };
    }
  }));
}

async function guidanceEvents(db: D1Database, env: SecPipelineEnv, ticker: string, now: number): Promise<AiCompanyDetail["events"]> {
  const feed = (await new D1SecRepository(db).getCache<SecFilingFeed>(`sec:filings:${ticker}`))?.payload ?? null;
  const known = new Map((await new GuidanceStore(db, env.SEC_FILINGS).events(ticker)).map(e => [e.accession, e]));
  return earningsEvents(feed, now).sort((a, b) => b.eventDate.localeCompare(a.eventDate))
    .map(e => ({ ...e, status: known.get(e.accession)?.status ?? null, transcriptStatus: known.get(e.accession)?.transcript_status ?? null }));
}

async function state(env: SecPipelineEnv, db: D1Database, kind: AiRunKind, ticker: string, latestRun: AiKindState["latestRun"]): Promise<AiKindState> {
  return { blocked: blocked(env, kind), automatic: automatic(env, kind), current: currentVersion(kind, await currentPublication(db, kind, ticker).catch(() => null)), latestRun };
}

async function start(env: SecPipelineEnv, db: D1Database, kind: AiRunKind, ticker: string, body: { requestId?: unknown; accession?: unknown }, now: number): Promise<Response> {
  if (typeof body.requestId !== "string" || !UUID.test(body.requestId)) return json({ error: "操作参数无效。" }, 400);
  const reason = blocked(env, kind);
  if (reason) return json({ error: reason }, 503);
  const store = new AiRunStore(db);
  const runId = `${kind}-manual-${ticker.replace(/[^A-Za-z0-9]/g, "-")}-${body.requestId}`;
  if (await store.get(kind, ticker, runId)) return json({ runId, reused: true } satisfies AiRunStarted, 202);

  let params: Record<string, unknown>, accession: string | null = null;
  if (kind === "guidance") {
    const events = await guidanceEvents(db, env, ticker, now);
    const event = typeof body.accession === "string" && body.accession ? events.find(e => e.accession === body.accession) : events[0];
    if (!event) return json({ error: typeof body.accession === "string" && body.accession ? "该业绩发布不在已缓存的 SEC 文件中。" : "尚未找到可读取的业绩发布 8-K。" }, 409);
    accession = event.accession;
    params = { ticker, accession: event.accession, eventDate: event.eventDate, manual: true };
  } else {
    const fingerprint = kind === "findings" ? await findingsFingerprint(env, ticker) : await businessExplainerFingerprint(env, ticker);
    if (!fingerprint) return json({ error: "业务地图尚无完整财报，暂时无法生成。" }, 409);
    params = { ticker, fingerprint };
  }
  const runs = await settle(env, store, await store.runs(kind, ticker), now);
  if (runs.some(r => !TERMINAL.has(r.status) && (kind !== "guidance" || r.accession === accession))) return json({ error: "该公司已有进行中的任务，请等待完成后再触发。" }, 409);

  const at = new Date(now).toISOString();
  await store.start({ kind, ticker, runId, trigger: "manual", accession }, at);
  try {
    await binding(env, kind)!.create({ id: runId, params });
  } catch (error) {
    if (/already exists|duplicate/i.test(String(error))) return json({ runId, reused: true } satisfies AiRunStarted, 202);
    await store.finish(kind, ticker, runId, { status: "failed", error: "工作流启动失败。" }, at);
    return json({ error: "工作流启动失败，请稍后重试。" }, 503);
  }
  return json({ runId, reused: false } satisfies AiRunStarted, 202);
}

export async function handleAiRunsAdminRequest(request: Request, env: SecPipelineEnv, now = Date.now()): Promise<Response> {
  if (!await authenticateAdmin(request, env.REPORT_ADMIN_PASSWORD, now)) return json({ error: "请登录管理后台。" }, 401);
  if (!env.DB) return json({ error: "数据服务尚未连接。" }, 503);
  const db = env.DB, tickers = trackedTickersFor(env);
  try {
    // Version ids are timestamps; the admin proxy percent-encodes their colons.
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path === "/admin/ai/companies" && request.method === "GET") {
      const latest = await new AiRunStore(db).latestRuns();
      const companies = await Promise.all(tickers.map(async ticker => ({
        ticker, name: findSecurity(ticker)?.name ?? ticker,
        kinds: Object.fromEntries(await Promise.all(AI_RUN_KINDS.map(async kind => [kind, await state(env, db, kind, ticker, latest.get(`${kind}:${ticker}`) ?? null)]))) as AiCompanies["companies"][number]["kinds"],
      })));
      return json({ companies } satisfies AiCompanies);
    }
    const match = /^\/admin\/ai\/companies\/([A-Z][A-Z0-9.-]{0,9})\/(findings|explainer|guidance)(?:\/(runs|versions\/([0-9T:.Z-]{10,40})))?$/.exec(path);
    if (!match) return json({ error: "Not found" }, 404);
    const [, ticker, kindName, action, versionId] = match;
    const kind = kindName as AiRunKind;
    if (!tickers.includes(ticker!)) return json({ error: "该公司不在 AI 分析范围内。" }, 404);
    const store = new AiRunStore(db);

    if (action === "runs" && request.method === "POST") return start(env, db, kind, ticker!, await request.json() as Record<string, unknown>, now);
    if (request.method !== "GET" || action === "runs") return json({ error: "Not found" }, 404);

    const current = await currentPublication(db, kind, ticker!).catch(() => null);
    if (versionId) {
      const version = currentVersion(kind, current);
      if (version?.id === versionId) return json({ kind, ticker: ticker!, version, publication: current } satisfies AiVersionDetail);
      const stored = await store.version(kind, ticker!, versionId);
      if (!stored) return json({ error: "版本不存在。" }, 404);
      return json({ kind, ticker: ticker!, version: { id: versionId, savedAt: stored.savedAt, summary: stored.summary, current: false }, publication: stored.publication } satisfies AiVersionDetail);
    }
    const runs = await settle(env, store, await store.runs(kind, ticker!), now);
    const head = currentVersion(kind, current);
    // History starts with the first publication saved after versions were kept; the one served now is always listed.
    const versions = [...(head ? [head] : []), ...(await store.versions(kind, ticker!)).filter(v => v.id !== head?.id)];
    const latestRun = runs[0] ? { runId: runs[0].runId, status: runs[0].status, stage: runs[0].stage, trigger: runs[0].trigger, startedAt: runs[0].startedAt, updatedAt: runs[0].updatedAt } : null;
    return json({
      ticker: ticker!, name: findSecurity(ticker!)?.name ?? ticker!, kind,
      state: { blocked: blocked(env, kind), automatic: automatic(env, kind), current: head, latestRun },
      runs, versions, events: kind === "guidance" ? await guidanceEvents(db, env, ticker!, now) : [],
    } satisfies AiCompanyDetail);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof URIError) return json({ error: "操作参数无效。" }, 400);
    console.error(JSON.stringify({ event: "ai-runs-admin", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "AI 任务服务暂时不可用，请重试。" }, 503);
  }
}
