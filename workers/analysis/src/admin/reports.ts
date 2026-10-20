import type { ReportAdminDetail, ReportAdminItem, ReportAdminPage, ReportAdminJob } from "../../../../shared/analysis-contract/admin.ts";
import type { PublishedSecReport, SecFilingSummary } from "../../../../shared/analysis-contract/report.ts";
import { trackedTickersFor, type SecCronEnv } from "../core.ts";
import { D1SecRepository, SEC_ANALYSIS_JOB_LEASE_MS } from "../sec/d1.ts";
import { getPublicFiling } from "../sec/public-api.ts";
import { normalizeTrackedTicker } from "../sec/config.ts";
import { cleanSecAccession } from "../sec/sec.ts";
import { jobAnalysisVersionFor } from "../workflow-core.ts";
import { authenticateAdmin, createAdminSession, matchesAdminKey } from "./auth.ts";

type AdminEnv = SecCronEnv & { REPORT_ADMIN_RATE_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> } };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
const reviewKey = (ticker: string, accession: string, version: string) => `admin:review:${ticker}:${accession}:${version}`;
// Match report identity through its publication snapshot, with a fallback for older reports.
const REPORT_IDENTITY = `(json_extract(r.payload, '$.publication.filing.accessionNumber') = f.accession_number OR
  (json_extract(r.payload, '$.publication.filing.accessionNumber') IS NULL AND r.period_id IN
    (SELECT period_id FROM sec_filing_periods WHERE filing_id = f.filing_id)))`;
const REPORTS_CTE = `WITH entries AS (
  SELECT f.*, COALESCE(json_extract(g.payload, '$.earningsDate'), f.filing_date) AS sort_date,
    (SELECT r.report_version FROM sec_published_reports r WHERE r.ticker = f.ticker AND ${REPORT_IDENTITY}
      ORDER BY r.generated_at DESC, r.rowid DESC LIMIT 1) AS version,
    (SELECT j.job_id FROM sec_analysis_jobs j WHERE j.ticker = f.ticker AND j.accession_number = f.accession_number
      ORDER BY CASE WHEN j.status IN ('queued','running') AND j.updated_at >= ? THEN 0 ELSE 1 END, j.updated_at DESC LIMIT 1) AS job_id
  FROM sec_filings f LEFT JOIN sec_cache g ON g.cache_key = 'sec:earnings:' || f.ticker || ':' || f.accession_number
  WHERE (g.cache_key IS NULL OR json_extract(g.payload, '$.canonicalAccession') = f.accession_number)
    AND f.form IN ('10-K','10-K/A','10-Q','10-Q/A','20-F','20-F/A','8-K','8-K/A','6-K','6-K/A')
), hydrated AS (
  SELECT f.ticker, f.accession_number AS accessionNumber, f.form, f.report_date AS reportDate,
    f.filing_date AS filingDate, f.sort_date AS sortDate, f.version AS reportVersion,
    COALESCE(json_extract(r.payload, '$.publication.filing.companyName'),
      json_extract(c.payload, '$.company.name'), f.ticker) AS companyName,
    r.generated_at AS generatedAt, COALESCE(j.updated_at, r.generated_at, f.filing_date) AS updatedAt,
    j.current_stage AS stage, j.error_code AS errorCode, v.fetched_at AS reviewedAt,
    CASE WHEN j.status IN ('queued','running') AND j.updated_at >= ? THEN 'processing'
      WHEN j.status = 'failed' OR (j.status IN ('queued','running') AND j.updated_at < ?) OR r.verification_status = 'failed' THEN 'failed'
      WHEN v.cache_key IS NOT NULL THEN 'reviewed'
      WHEN r.report_version IS NOT NULL OR s.payload IS NOT NULL THEN 'unreviewed' ELSE 'pending' END AS status
  FROM entries f
  LEFT JOIN sec_published_reports r ON r.ticker = f.ticker AND r.report_version = f.version AND ${REPORT_IDENTITY}
  LEFT JOIN sec_analysis_jobs j ON j.job_id = f.job_id
  LEFT JOIN sec_filing_summaries s ON s.ticker = f.ticker AND s.accession_number = f.accession_number
  LEFT JOIN sec_cache c ON c.cache_key = 'sec:filings:' || f.ticker
  LEFT JOIN sec_cache v ON v.cache_key = 'admin:review:' || f.ticker || ':' || f.accession_number || ':' || COALESCE(f.version, json_extract(s.payload, '$.generatedAt'))
)`;

export async function listAdminReports(env: AdminEnv, url: URL, now = Date.now()): Promise<ReportAdminPage> {
  const search = (url.searchParams.get("search") ?? "").trim().slice(0, 100);
  const status = url.searchParams.get("status") ?? "";
  if (status && !["unreviewed", "reviewed", "processing", "failed", "pending"].includes(status)) throw new Error("INVALID_QUERY");
  let cursor: { date: string; ticker: string; accession: string } | null = null;
  const raw = url.searchParams.get("cursor");
  if (raw) {
    try { cursor = JSON.parse(atob(raw)); } catch { throw new Error("INVALID_QUERY"); }
    if (!cursor || typeof cursor.date !== "string" || typeof cursor.ticker !== "string" || typeof cursor.accession !== "string" || raw.length > 512) throw new Error("INVALID_QUERY");
  }
  const lease = new Date(now - SEC_ANALYSIS_JOB_LEASE_MS).toISOString();
  const clauses: string[] = []; const args: string[] = [lease, lease, lease];
  if (search) { clauses.push("(instr(lower(ticker), lower(?)) > 0 OR instr(lower(companyName), lower(?)) > 0)"); args.push(search, search); }
  if (status) { clauses.push("status = ?"); args.push(status); }
  if (cursor) { clauses.push("(sortDate, ticker, accessionNumber) < (?, ?, ?)"); args.push(cursor.date, cursor.ticker, cursor.accession); }
  const rows = await env.DB!.prepare(`${REPORTS_CTE} SELECT * FROM hydrated ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY sortDate DESC, ticker DESC, accessionNumber DESC LIMIT 41`).bind(...args).all<ReportAdminItem & { sortDate: string }>();
  const allowed = trackedTickersFor(env);
  const reports = rows.results.slice(0, 40).map(row => ({ ...row, canRegenerate: allowed.includes(row.ticker),
    errorCode: safeError(row.errorCode) }));
  const last = reports.at(-1);
  return { reports, nextCursor: rows.results.length > 40 && last ? btoa(JSON.stringify({ date: last.sortDate, ticker: last.ticker, accession: last.accessionNumber })) : null };
}

export async function getAdminReport(env: AdminEnv, ticker: string, accession: string, version?: string): Promise<ReportAdminDetail | null> {
  const repository = new D1SecRepository(env.DB!);
  const detail = await getPublicFiling(repository, ticker, accession);
  if (!detail) return null;
  // Always query the selected filing's canonical identity, including older versions.
  const canonical = detail.filing.earningsGroup?.canonicalAccession ?? accession;
  const rows = await env.DB!.prepare(`SELECT r.report_version AS reportVersion, r.generated_at AS generatedAt,
    r.verification_status AS verificationStatus, v.fetched_at AS reviewedAt
    FROM sec_published_reports r JOIN sec_filings f ON f.ticker = r.ticker AND f.accession_number = ?
    LEFT JOIN sec_cache v ON v.cache_key = 'admin:review:' || r.ticker || ':' || f.accession_number || ':' || r.report_version
    WHERE r.ticker = ? AND ${REPORT_IDENTITY} ORDER BY r.generated_at DESC, r.rowid DESC LIMIT 100`)
    .bind(canonical, ticker).all<{ reportVersion: string; generatedAt: string; verificationStatus: string; reviewedAt: string | null }>();
  const selected = version ? rows.results.find(row => row.reportVersion === version) : rows.results[0];
  if (version && !selected && rows.results.length) return null;
  if (selected) {
    // Fetch one body, rather than loading 100 potentially large research reports into memory.
    const saved = await env.DB!.prepare(`SELECT r.payload FROM sec_published_reports r
      JOIN sec_filings f ON f.ticker = r.ticker AND f.accession_number = ?
      WHERE r.ticker = ? AND r.report_version = ? AND ${REPORT_IDENTITY} LIMIT 1`)
      .bind(canonical, ticker, selected.reportVersion).first<{ payload: string }>();
    if (!saved) return null;
    const report = JSON.parse(saved.payload) as PublishedSecReport;
    detail.filing.analysis = report;
    detail.filing.reportVersion = report.reportVersion;
    detail.filing.summary = report.publication?.summary ?? detail.filing.summary;
  }
  const versions = rows.results.map(row => ({ reportVersion: row.reportVersion, generatedAt: row.generatedAt, verificationStatus: row.verificationStatus, reviewedAt: row.reviewedAt }));
  if (version && !rows.results.length && !detail.filing.summary) return null;
  if (!rows.results.length && detail.filing.summary) {
    const summaries = await env.DB!.prepare(`SELECT s.payload, s.fetched_at AS generatedAt, v.fetched_at AS reviewedAt
      FROM sec_cache s LEFT JOIN sec_cache v ON v.cache_key = 'admin:review:' || ? || ':' || ? || ':' || s.fetched_at
      WHERE s.cache_key LIKE ? ORDER BY s.fetched_at DESC LIMIT 100`)
      .bind(ticker, canonical, `admin:summary:${ticker}:${canonical}:%`).all<{ payload: string; generatedAt: string; reviewedAt: string | null }>();
    const current = detail.filing.summary;
    if (version && version !== current.generatedAt) {
      const saved = summaries.results.find(row => row.generatedAt === version);
      if (!saved) return null;
      detail.filing.summary = JSON.parse(saved.payload) as SecFilingSummary;
    }
    versions.push(...summaries.results.map(row => ({ reportVersion: row.generatedAt, generatedAt: row.generatedAt, verificationStatus: "summary", reviewedAt: row.reviewedAt })));
    if (!versions.some(row => row.reportVersion === current.generatedAt)) {
      const checked = await repository.getCache(reviewKey(ticker, canonical, current.generatedAt));
      versions.unshift({ reportVersion: current.generatedAt, generatedAt: current.generatedAt, verificationStatus: "summary", reviewedAt: checked?.fetchedAt ?? null });
    }
  }
  const identity = detail.filing.reportVersion ?? detail.filing.summary?.generatedAt;
  const reviewed = identity ? await repository.getCache(reviewKey(ticker, canonical, identity)) : null;
  const jobs = await env.DB!.prepare(`SELECT job_id AS jobId, status, current_stage AS currentStage, attempt,
    requested_by AS requestedBy, updated_at AS updatedAt, completed_at AS completedAt, error_code AS errorCode
    FROM sec_analysis_jobs WHERE ticker = ? AND accession_number = ? ORDER BY updated_at DESC LIMIT 30`)
    .bind(ticker, canonical).all<ReportAdminJob>();
  return { filing: detail.filing, reviewedAt: reviewed?.fetchedAt ?? null, canRegenerate: trackedTickersFor(env).includes(ticker),
    versions, jobs: jobs.results.map(job => ({ ...job, errorCode: safeError(job.errorCode) })) };
}
function safeError(code: string | null): string | null { return code && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : code ? "ANALYSIS_FAILED" : null; }

export async function handleReportAdminRequest(request: Request, env: AdminEnv, now = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/admin/session") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (!env.REPORT_ADMIN_PASSWORD) return json({ error: "管理员登录尚未配置。" }, 503);
    if (env.REPORT_ADMIN_RATE_LIMIT && !(await env.REPORT_ADMIN_RATE_LIMIT.limit({ key: request.headers.get("cf-connecting-ip") ?? "admin-login" })).success) return json({ error: "尝试过于频繁，请稍后重试。" }, 429);
    if (!await matchesAdminKey(request.headers.get("x-report-admin-password") ?? "", env.REPORT_ADMIN_PASSWORD)) return json({ error: "管理密码不正确。" }, 401);
    return json({ token: await createAdminSession(env.REPORT_ADMIN_PASSWORD, now) });
  }
  if (!await authenticateAdmin(request, env.REPORT_ADMIN_PASSWORD, now)) return json({ error: "请登录财报管理后台。" }, 401);
  if (!env.DB) return json({ error: "财报数据服务暂时不可用。" }, 503);
  if (url.pathname === "/admin/reports" && request.method === "GET") {
    try { return json(await listAdminReports(env, url, now)); }
    catch (error) { return json({ error: String(error).includes("INVALID_QUERY") ? "筛选条件无效。" : "报告列表暂时不可用。" }, String(error).includes("INVALID_QUERY") ? 400 : 503); }
  }
  const match = /^\/admin\/reports\/([^/]+)\/([^/]+)(?:\/(review|regenerate))?$/.exec(url.pathname);
  if (!match) return json({ error: "Not found" }, 404);
  let ticker: string | null, accession: string;
  try { ticker = normalizeTrackedTicker(decodeURIComponent(match[1]!)); accession = cleanSecAccession(decodeURIComponent(match[2]!)); }
  catch { return json({ error: "报告标识无效。" }, 400); }
  if (!ticker || !accession) return json({ error: "报告标识无效。" }, 400);
  const action = match[3];
  if (request.method !== (action ? "POST" : "GET")) return json({ error: "Method not allowed" }, 405);
  try {
    if (!action) {
      const detail = await getAdminReport(env, ticker, accession, url.searchParams.get("version") ?? undefined);
      return detail ? json(detail) : json({ error: "报告不存在。" }, 404);
    }
    const repository = new D1SecRepository(env.DB);
    const filing = await repository.getPublicFiling(ticker, accession);
    if (!filing) return json({ error: "报告不存在。" }, 404);
    const canonical = filing.earningsGroup?.canonicalAccession ?? filing.accessionNumber;
    if (action === "review") {
      if (Number(request.headers.get("content-length") ?? 0) > 4096) return json({ error: "Request too large" }, 413);
      const body = await request.json().catch(() => null) as { version?: string } | null;
      if (typeof body?.version !== "string" || !body.version || body.version.length > 256) return json({ error: "请选择要检查的版本。" }, 400);
      const detail = await getAdminReport(env, ticker, canonical, body.version);
      const identity = detail?.filing.reportVersion ?? detail?.filing.summary?.generatedAt;
      if (identity !== body.version) return json({ error: "该报告版本不存在，请刷新后重试。" }, 409);
      await repository.setCache(reviewKey(ticker, canonical, identity), { version: identity, reviewedAt: new Date(now).toISOString() }, new Date(now).toISOString());
      return json({ status: "reviewed", reviewedAt: new Date(now).toISOString() });
    }
    if (!trackedTickersFor(env).includes(ticker)) return json({ error: "该公司未启用 AI 财报分析。" }, 403);
    if (!env.SEC_ANALYSIS_WORKFLOW) return json({ error: "生成服务尚未配置。" }, 503);
    const requestId = request.headers.get("idempotency-key") ?? "";
    if (!/^[a-f0-9-]{36}$/.test(requestId)) return json({ error: "操作标识无效。" }, 400);
    const workflowId = `admin-${ticker}-${canonical}-${requestId}`;
    const jobId = `${ticker}:${canonical}:${jobAnalysisVersionFor(filing.form)}:${workflowId}`;
    const existing = await env.DB.prepare("SELECT status FROM sec_analysis_jobs WHERE job_id = ?").bind(jobId).first<{ status: string }>();
    if (existing && existing.status !== "failed") return json({ status: existing.status, jobId: workflowId }, 202);
    const active = await env.DB.prepare(`SELECT job_id FROM sec_analysis_jobs WHERE ticker = ? AND accession_number = ?
      AND status IN ('running','queued') AND updated_at >= ? LIMIT 1`).bind(ticker, canonical, new Date(now - SEC_ANALYSIS_JOB_LEASE_MS).toISOString()).first();
    if (active) return json({ error: "这份财报已有生成任务，请等待完成。" }, 409);
    // Atomic short lease also closes the gap between checking jobs and creating one.
    const lock = await env.DB.prepare(`INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
      WHERE sec_cache.fetched_at < ?`).bind(`admin:generate-lock:${ticker}:${canonical}`, JSON.stringify({ workflowId }), new Date(now).toISOString(), new Date(now - 60_000).toISOString()).run();
    if (!lock.meta.changes) return json({ error: "这份报告正在提交生成任务，请稍后刷新。" }, 409);
    const job = { jobId, ticker, accessionNumber: canonical, analysisVersion: jobAnalysisVersionFor(filing.form),
      status: "queued" as const, currentStage: "queued", attempt: 1, requestedBy: "manual" as const, workflowInstanceId: workflowId, updatedAt: new Date(now).toISOString() };
    await repository.upsertAnalysisJob(job);
    try {
      await env.SEC_ANALYSIS_WORKFLOW.create({ id: workflowId, params: { ticker, requestedBy: "manual", accessionNumber: canonical, regenerateReport: true } });
    } catch {
      // A timeout after successful create is ambiguous. Inspect the same instance, never launch another.
      let created = false;
      try { if (env.SEC_ANALYSIS_WORKFLOW.get) { await (await env.SEC_ANALYSIS_WORKFLOW.get(workflowId)).status(); created = true; } } catch { /* creation was not confirmed */ }
      if (!created) { await repository.upsertAnalysisJob({ ...job, status: "failed", errorCode: "workflow_dispatch_failed", completedAt: new Date(now).toISOString() }); return json({ error: "生成任务未能提交，请稍后重试。" }, 503); }
    }
    return json({ status: "queued", jobId: workflowId, ticker, accessionNumber: canonical }, 202);
  } catch {
    return json({ error: "财报管理服务暂时不可用，请稍后重试。" }, 503);
  }
}
