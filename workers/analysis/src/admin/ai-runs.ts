import { extractArtifactTranslation } from "../../../../shared/analysis-runtime/artifact/localization.ts";
import { readArtifactVersion } from "../artifact/store.ts";
import { readValuationResponse } from "../valuation/store.ts";
import { valuationFingerprint } from "../valuation/workflow.ts";
import { AI_RUN_KINDS, type AiCompanies, type AiCompanyDetail, type AiKindState, type AiRun, type AiRunKind, type AiRunStarted, type AiUsageDay, type AiVersion, type AiVersionDetail } from "../../../../shared/analysis-contract/ai-runs-admin.ts";
import { translationsAdmin } from "../translation/admin.ts";
import { AiRunStore, publishedAt, summarize, TERMINAL } from "../ai-runs/store.ts";
import { businessExplainerFingerprint, readBusinessExplainerResponse } from "../business-explainer/workflow.ts";
import { FEATURES, type Feature } from "../../../../shared/analysis-contract/business-features.ts";
import { featureEnabled, featureTickersFor } from "../financial-data/company-policy.ts";
const FEATURE_NAME: Record<Feature, string> = { filings: "SEC 文件解析", findings: "关键点", tree: "业务解析", valuation: "估值评估" };
import { businessTreeFingerprint, readBusinessTreeResponse } from "../business-tree/workflow.ts";
import { securities } from "../catalog/issuer-directory.ts";
import type { AiWorkflowBinding, AnalysisEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { authenticateAdmin } from "./auth.ts";
import { researchSearchConfigured } from "../web-search/research-search.ts";
import { json } from "./http.ts";
import { z } from "zod";
import type { TranslationStarted } from "../../../../shared/analysis-contract/translations-admin.ts";
import { failedInputKey } from "../pipeline/workflow-task.ts";
import { readSources, TRANSLATION_VERSION } from "../translation/translate.ts";
import { sha256 } from "../sha256.ts";
import { scopeTickers } from "../pipeline/router.ts";
import { contentPublishedStatement } from "../publication/publish.ts";
import { flushOutbox } from "../pipeline/outbox.ts";
import { scheduledAnalysisPauses } from "../pipeline/scheduled-analysis.ts";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const translationRequest = z.object({ requestId: z.string().regex(UUID) });
/** A run with no news for this long is checked against the Workflow engine. */
const SETTLE_AFTER_MS = 60_000, MISSING_AFTER_MS = 10 * 60_000;

type Binding = AiWorkflowBinding<Record<string, unknown>>;
function binding(env: AnalysisEnv, kind: AiRunKind): Binding | undefined {
  return (kind === "explainer" ? env.BUSINESS_EXPLAINER_WORKFLOW : kind === "tree" ? env.BUSINESS_TREE_WORKFLOW : kind === "valuation" ? env.VALUATION_WORKFLOW : undefined) as Binding | undefined;
}
/** Each kind runs for the companies its feature is switched on for. */
const featureOf = (kind: AiRunKind): Feature => kind === "analyst" ? "findings" : kind === "explainer" ? "tree" : kind;
function enabled(env: AnalysisEnv, kind: AiRunKind, ticker: string): boolean {
  if (kind === "findings" || kind === "analyst") return false;
  return featureTickersFor(env, featureOf(kind)).includes(ticker);
}
function blocked(env: AnalysisEnv, kind: AiRunKind, ticker: string): string | null {
  if (kind === "findings" || kind === "analyst") return "该功能已移除。";
  if (!featureEnabled(env, featureOf(kind))) return `${FEATURE_NAME[featureOf(kind)]}生成已全局暂停。`;
  if (!enabled(env, kind, ticker)) return `该公司的${FEATURE_NAME[featureOf(kind)]}生成已关闭。`;
  if (!binding(env, kind)) return "该任务的工作流未配置。";
  if (!env.DEEPSEEK_API_KEY) return "模型密钥未配置。";
  return null;
}
function automatic(env: AnalysisEnv, kind: AiRunKind, ticker: string): boolean {
  if (!enabled(env, kind, ticker)) return false;
  return kind === "explainer" ? !!env.BUSINESS_EXPLAINER_WORKFLOW && researchSearchConfigured(env)
    : kind === "tree" ? !!env.BUSINESS_TREE_WORKFLOW && researchSearchConfigured(env)
    : kind === "valuation" ? !!env.VALUATION_WORKFLOW && env.VALUATION_ENABLED !== "false"
    : false;
}
/** The publication readers are served now, validated the same way the public read API does. */
async function currentPublication(db: D1Database, kind: AiRunKind, ticker: string): Promise<unknown> {
  if (kind === "findings" || kind === "analyst") return null;
  if (kind === "explainer") return (await readBusinessExplainerResponse(db, ticker)).explainer;
  if (kind === "tree") return (await readBusinessTreeResponse(db, ticker, { research: true })).tree;
  return (await readValuationResponse(db, ticker)).report;
}
function currentVersion(kind: AiRunKind, publication: unknown): AiVersion | null {
  const id = publication ? publishedAt(publication) : null;
  return id ? { id, savedAt: id, summary: summarize(kind, publication), current: true } : null;
}

/** Settles runs whose Workflow ended (or vanished) without writing its outcome, e.g. after termination. */
async function settle(env: AnalysisEnv, store: AiRunStore, runs: AiRun[], now: number): Promise<AiRun[]> {
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
    } catch (cause) {
      console.error(JSON.stringify({ event: "ai-run-status", kind: run.kind, ticker: run.ticker, runId: run.runId, error: cause instanceof Error ? cause.message : String(cause) }));
      if (now - Date.parse(run.startedAt) < MISSING_AFTER_MS) return run;
      const error = "找不到对应的工作流实例。";
      await store.finish(run.kind, run.ticker, run.runId, { status: "failed", error }, at);
      return { ...run, status: "failed" as const, error, finishedAt: at };
    }
  }));
}

/** The ledger kinds one admin kind spends: the lens agent's calls belong to the findings run. */
const USAGE_KINDS: Record<AiRunKind, string[]> = { findings: ["findings", "lens"], analyst: ["analyst"], explainer: ["explainer"], tree: ["tree"], valuation: ["valuation", "valuation-research"] };
/** The last 30 days of the `ai_usage` ledger (migration 0023) by day; undefined when the table cannot be read. */
async function usage(db: D1Database, kind: AiRunKind, ticker: string, now: number): Promise<AiUsageDay[] | undefined> {
  const kinds = USAGE_KINDS[kind], since = new Date(now - 30 * 86_400_000).toISOString();
  try {
    const { results } = await db.prepare(`SELECT substr(at, 1, 10) AS day, COUNT(*) AS calls, SUM(input_tokens) AS inputTokens, SUM(cached_tokens) AS cachedTokens, SUM(output_tokens) AS outputTokens, SUM(search_calls) AS searchCalls
      FROM ai_usage WHERE ticker = ? AND kind IN (${kinds.map(() => "?").join(", ")}) AND at >= ? GROUP BY day ORDER BY day DESC LIMIT 30`).bind(ticker, ...kinds, since).all<AiUsageDay>();
    return results;
  } catch (error) {
    console.warn(JSON.stringify({ event: "ai-usage-admin", outcome: "unavailable", error: error instanceof Error ? error.message : String(error) }));
    return undefined;
  }
}

async function state(env: AnalysisEnv, db: D1Database, kind: AiRunKind, ticker: string, latestRun: AiKindState["latestRun"]): Promise<AiKindState> {
  return { enabled: enabled(env, kind, ticker), blocked: blocked(env, kind, ticker), automatic: automatic(env, kind, ticker), current: currentVersion(kind, await currentPublication(db, kind, ticker).catch(() => null)), latestRun };
}

async function start(env: AnalysisEnv, db: D1Database, kind: AiRunKind, ticker: string, body: { requestId?: unknown }, now: number): Promise<Response> {
  if (typeof body.requestId !== "string" || !UUID.test(body.requestId)) return json({ error: "操作参数无效。" }, 400);
  const reason = blocked(env, kind, ticker);
  if (reason) return json({ error: reason }, enabled(env, kind, ticker) ? 503 : 404);
  const store = new AiRunStore(db);
  const runId = `${kind}-manual-${ticker.replace(/[^A-Za-z0-9]/g, "-")}-${body.requestId}`;
  if (await store.get(kind, ticker, runId)) return json({ runId, reused: true } satisfies AiRunStarted, 202);

  const fingerprint = kind === "tree" ? await businessTreeFingerprint(env, ticker) : kind === "valuation" ? await valuationFingerprint(env, ticker) : kind === "explainer" ? await businessExplainerFingerprint(env, ticker) : null;
  if (!fingerprint) return json({ error: "业务地图尚无完整财报，暂时无法生成。" }, 409);
  const params: Record<string, unknown> = { ticker, fingerprint };
  const runs = await settle(env, store, await store.runs(kind, ticker), now);
  if (runs.some(r => !TERMINAL.has(r.status))) return json({ error: "该公司已有进行中的任务，请等待完成后再触发。" }, 409);

  const at = new Date(now).toISOString();
  await store.start({ kind, ticker, runId, trigger: "manual" }, at);
  try {
    await binding(env, kind)!.create({ id: runId, params });
  } catch (error) {
    if (/already exists|duplicate/i.test(String(error))) return json({ runId, reused: true } satisfies AiRunStarted, 202);
    await store.finish(kind, ticker, runId, { status: "failed", error: "工作流启动失败。" }, at);
    return json({ error: "工作流启动失败，请稍后重试。" }, 503);
  }
  return json({ runId, reused: false } satisfies AiRunStarted, 202);
}

/** Only this pinned artifact's sole numeric-literal rejections become pending, once per repair receipt. */
export function artifactNumericRepairStatements(db: D1Database, receiptKey: string, unitHashes: string[]): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < unitHashes.length; i += 400) statements.push(db.prepare(`DELETE FROM i18n_strings
    WHERE locale='zh-CN' AND status='rejected' AND version=?
      AND source_sha256 IN (SELECT value FROM json_each(?))
      AND json_valid(problems) AND json_array_length(problems)=1
      AND json_extract(problems,'$[0]')=?
      AND EXISTS (SELECT 1 FROM sec_cache WHERE cache_key=? AND json_extract(payload,'$.resetPending')=1)`)
    .bind(TRANSLATION_VERSION, JSON.stringify(unitHashes.slice(i, i + 400)), "artifact numbers must remain protected placeholders; do not add numeric literals", receiptKey));
  return statements;
}

/** Repair one frozen edition without regenerating research or translating unrelated reports. */
async function repairArtifactTranslation(request: Request, env: AnalysisEnv, db: D1Database, ticker: string, now: number): Promise<Response> {
  const parsed = z.object({ requestId: z.string().regex(UUID), artifactId: z.string().min(1).max(240), sourceVersion: z.number().int().positive(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(await request.json());
  if (!parsed.success) return json({ error: "操作参数无效。" }, 400);
  if ((await scheduledAnalysisPauses(db)).at(ticker) !== null) return json({ error: "该公司的定时任务已关闭，翻译已暂停。" }, 409);
  if (env.TRANSLATION_ENABLED === "false" || !env.DEEPSEEK_API_KEY || !env.TRANSLATE_WORKFLOW) return json({ error: "翻译工作流未启用或未配置。" }, 503);
  const { artifactId, sourceVersion, sourceHash } = parsed.data;
  const current = await db.prepare("SELECT artifact_id FROM analysis_artifacts WHERE artifact_id=? AND ticker=? AND published_version=? AND published_hash=?")
    .bind(artifactId, ticker, sourceVersion, sourceHash).first();
  if (!current) return json({ error: "报告版本已变化，请重新读取当前版本。" }, 409);
  const stored = await readArtifactVersion(env, artifactId, sourceVersion);
  if (!stored || stored.hash !== sourceHash || stored.document.ticker !== ticker || stored.document.lang !== "en") return json({ error: "固定的英文报告版本不可用。" }, 409);
  const unitHashes = [...new Set(await Promise.all(extractArtifactTranslation(stored.document).units.map(unit => sha256(unit.text))))];
  // Repair revision is separate from the translator version: no unrelated report is re-enqueued.
  // Stable across request IDs so concurrent clicks cannot buy duplicate repairs.
  const fingerprint = await sha256(`protected-literals-v3-durations|${ticker}|${artifactId}|${sourceVersion}|${sourceHash}`);
  const runId = `translate-repair-${fingerprint.slice(0, 40)}`, key = `translate:repair:${fingerprint}`, at = new Date(now).toISOString();
  const first = "EXISTS (SELECT 1 FROM sec_cache WHERE cache_key=? AND json_extract(payload, '$.resetPending')=1)";
  await db.batch([
    db.prepare("INSERT INTO sec_cache (cache_key,payload,fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO NOTHING")
      .bind(key, JSON.stringify({ ticker, artifactId, sourceVersion, sourceHash, requestId: parsed.data.requestId, runId, resetPending: true }), at),
    ...artifactNumericRepairStatements(db, key, unitHashes),
    // Keep published_r2_key / published_hash intact until the replacement passes review.
    db.prepare(`UPDATE analysis_artifact_translations SET status='translating', error=NULL, updated_at=? WHERE artifact_id=? AND source_version=? AND source_hash=? AND locale='zh-CN' AND ${first}`)
      .bind(at, artifactId, sourceVersion, sourceHash, key),
    db.prepare(`UPDATE sec_cache SET payload=json_remove(payload,'$.resetPending') WHERE cache_key=? AND ${first}`).bind(key, key),
  ]);
  try { await env.TRANSLATE_WORKFLOW.create({ id: runId, params: { ticker, fingerprint, artifact: { artifactId, sourceVersion, sourceHash } } }); }
  catch (error) {
    if (/already exists|duplicate/i.test(String(error))) return json({ runId, reused: true, artifactId, sourceVersion }, 202);
    return json({ error: "翻译启动失败；可使用相同请求重试，旧发布版本保留。", runId }, 503);
  }
  return json({ runId, reused: false, artifactId, sourceVersion }, 202);
}

/** Re-announces existing publications to their shared post-publication processing; no content is generated. */
async function startTranslation(request: Request, env: AnalysisEnv, db: D1Database, ticker: string, now: number): Promise<Response> {
  const parsed = translationRequest.safeParse(await request.json());
  if (!parsed.success) return json({ error: "操作参数无效。" }, 400);
  if ((await scheduledAnalysisPauses(db)).at(ticker) !== null) return json({ error: "该公司的定时任务已关闭，翻译已暂停。" }, 409);
  if (env.TRANSLATION_ENABLED === "false") return json({ error: "中文翻译已关闭。" }, 503);
  if (!env.DEEPSEEK_API_KEY || !env.TRANSLATE_WORKFLOW) return json({ error: "翻译工作流尚未配置。" }, 503);
  if (!env.PIPELINE_EVENTS) return json({ error: "发布通知队列未配置。" }, 503);
  const { requestId } = parsed.data, at = new Date(now).toISOString(), key = `translate:request:v1:${requestId}`;
  const sources = await readSources(db, ticker, env);
  const hashes = await Promise.all([...new Set(sources.flatMap(source => source.strings))].map(sha256));
  // The receipt and every reset commit together; repeats of the request never reset a later failure or a ready translation.
  const firstRequest = "EXISTS (SELECT 1 FROM sec_cache WHERE cache_key = ? AND json_extract(payload, '$.ticker') = ? AND json_extract(payload, '$.resetPending') = 1)";
  const statements = [
    db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO NOTHING")
      .bind(key, JSON.stringify({ ticker, resetPending: true }), at),
    db.prepare(`DELETE FROM sec_cache WHERE cache_key IN (?, ?) AND ${firstRequest}`)
      .bind(failedInputKey("translate", ticker), `translate:stalled:v1:${ticker}`, key, ticker),
    db.prepare(`UPDATE analysis_artifact_translations SET status = 'translating', error = NULL, updated_at = ?
      WHERE locale = 'zh-CN' AND status = 'failed' AND EXISTS (
        SELECT 1 FROM analysis_artifacts a WHERE a.ticker = ? AND a.artifact_id = analysis_artifact_translations.artifact_id
        AND a.published_version = analysis_artifact_translations.source_version AND a.published_hash = analysis_artifact_translations.source_hash
      ) AND ${firstRequest}`).bind(at, ticker, key, ticker),
  ];
  for (let i = 0; i < hashes.length; i += 500) {
    statements.push(db.prepare(`DELETE FROM i18n_strings WHERE locale = 'zh-CN' AND status = 'rejected'
      AND source_sha256 IN (SELECT value FROM json_each(?)) AND ${firstRequest}`)
      .bind(JSON.stringify(hashes.slice(i, i + 500)), key, ticker));
  }
  statements.push(contentPublishedStatement(db, ticker, at, { sql: firstRequest, binds: [key, ticker] }, requestId));
  statements.push(db.prepare(`UPDATE sec_cache SET payload = json_remove(payload, '$.resetPending') WHERE cache_key = ? AND ${firstRequest}`)
    .bind(key, key, ticker));
  const written = await db.batch(statements);
  const receipt = (await db.prepare("SELECT json_extract(payload, '$.ticker') ticker FROM sec_cache WHERE cache_key = ?")
    .bind(key).first<{ ticker: string }>())!;
  if (receipt.ticker !== ticker) return json({ error: "操作标识已用于其他公司。" }, 409);
  await flushOutbox(env);
  return json({ requestId, status: "queued", reused: written[0]!.meta.changes === 0 } satisfies TranslationStarted, 202);
}

export async function handleAiRunsAdminRequest(request: Request, env: AnalysisEnv, now = Date.now()): Promise<Response> {
  if (!await authenticateAdmin(request, env.REPORT_ADMIN_PASSWORD, now)) return json({ error: "请登录管理后台。" }, 401);
  if (!env.DB) return json({ error: "数据服务尚未连接。" }, 503);
  const db = env.DB, tickers = [...new Set(FEATURES.flatMap(feature => featureTickersFor(env, feature)))].sort();
  try {
    // Version ids are timestamps; the admin proxy percent-encodes their colons.
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path === "/admin/ai/companies" && request.method === "GET") {
      const [latest, named, published] = await Promise.all([new AiRunStore(db).latestRuns(), securities(db), scopeTickers(env, "publication")]);
      const listed = [...new Set([...tickers, ...published])].sort();
      const companies = await Promise.all(listed.map(async ticker => ({
        ticker, name: named(ticker)?.name ?? ticker,
        kinds: Object.fromEntries(await Promise.all(AI_RUN_KINDS.map(async kind => [kind, await state(env, db, kind, ticker, latest.get(`${kind}:${ticker}`) ?? null)]))) as AiCompanies["companies"][number]["kinds"],
      })));
      return json({ companies } satisfies AiCompanies);
    }
    const artifactTranslation = /^\/admin\/ai\/companies\/([A-Z][A-Z0-9.-]{0,11})\/translations\/artifact$/.exec(path);
    if (artifactTranslation && request.method === "POST") return repairArtifactTranslation(request, env, db, artifactTranslation[1]!, now);
    // The company's Chinese: coverage per resource and every string with its translation.
    const translations = /^\/admin\/ai\/companies\/([A-Z][A-Z0-9.-]{0,11})\/translations$/.exec(path);
    if (translations && (request.method === "GET" || request.method === "POST")) {
      if (!(await scopeTickers(env, "publication")).includes(translations[1]!)) return json({ error: "该公司没有已发布内容。" }, 404);
      if (request.method === "POST") return startTranslation(request, env, db, translations[1]!, now);
      return json(await translationsAdmin(env, translations[1]!));
    }
    const match = /^\/admin\/ai\/companies\/([A-Z][A-Z0-9.-]{0,11})\/(findings|analyst|explainer|tree|valuation)(?:\/(runs|versions\/([0-9T:.Z-]{10,40})))?$/.exec(path);
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
    const [runs, spent] = await Promise.all([settle(env, store, await store.runs(kind, ticker!), now), usage(db, kind, ticker!, now)]);
    const head = currentVersion(kind, current);
    // History starts with the first publication saved after versions were kept; the one served now is always listed.
    const versions = [...(head ? [head] : []), ...(await store.versions(kind, ticker!)).filter(v => v.id !== head?.id)];
    const latestRun = runs[0] ? { runId: runs[0].runId, status: runs[0].status, stage: runs[0].stage, trigger: runs[0].trigger, startedAt: runs[0].startedAt, updatedAt: runs[0].updatedAt } : null;
    return json({
      ticker: ticker!, name: (await securities(db))(ticker!)?.name ?? ticker!, kind,
      state: { enabled: enabled(env, kind, ticker!), blocked: blocked(env, kind, ticker!), automatic: automatic(env, kind, ticker!), current: head, latestRun },
      runs, versions,
      ...(spent ? { usage: spent } : {}),
    } satisfies AiCompanyDetail);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof URIError) return json({ error: "操作参数无效。" }, 400);
    console.error(JSON.stringify({ event: "ai-runs-admin", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "AI 任务服务暂时不可用，请重试。" }, 503);
  }
}
