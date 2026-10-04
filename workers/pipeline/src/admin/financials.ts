import type { FinancialMaintenanceCompany, FinancialMaintenanceCompanyDetail, FinancialMaintenanceCompanyList, FinancialMaintenanceMetric, FinancialMaintenancePeriod } from "../../../../shared/analysis-contract/financial-maintenance.ts";
import { FLOW_METRICS, type BusinessFlowQuarter } from "../../../../shared/analysis-contract/business-flow.ts";
import { aiIsEnabled } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import { dataTickersFor, trackedTickersFor } from "../core.ts";
import type { SecPipelineEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { normalizeTrackedTicker } from "../sec/config.ts";
import { cleanSecAccession } from "../sec/sec.ts";
import { readCompletePublicationForTicker } from "../financial-data/publication.ts";
import { getFilingDisclosureAuditPage, listFilingDisclosureAudits } from "../financial-data/disclosure-audit.ts";
import { authenticateAdmin } from "./auth.ts";
import { FinancialMaintenanceStore, taskView } from "./financial-maintenance-store.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const coverage = {
  scope: ["已验证的季度利润表和收入分部", "季度收入历史（含可核对的第四季度差额推导）", "原始 Inline XBRL 事实、期间、单位、维度和出处的审计档案"],
  limitations: ["此处核心指标是有限的展示清单，不代表财报全部内容。", "未披露或尚未提取的数据保持缺失，不补成零。", "附注和非 XBRL 内容保留原文出处；未结构化不表示已提取语义。", "年累计和全年数据不直接标成单季，推导值需保留公式及来源。"],
};
const labels: Record<string, string> = { revenue: "收入", cost: "营业成本", gross: "毛利润", research: "研发费用", sales: "销售费用", administration: "管理费用", operatingExpenses: "营业费用", operating: "营业利润", other: "其他收益/费用", pretax: "税前利润", tax: "所得税", net: "净利润" };

export async function listFinancialCompanies(env: SecPipelineEnv): Promise<FinancialMaintenanceCompanyList> {
  const dataEnabled = dataTickersFor(env), tracked = trackedTickersFor(env);
  const rows = await env.DB!.prepare(`WITH tickers AS (
    SELECT ticker FROM sec_filings UNION SELECT ticker FROM financial_collection_jobs
    UNION SELECT ticker FROM financial_maintenance_tasks UNION SELECT value ticker FROM json_each(?)
  ) SELECT t.ticker,
    COALESCE(json_extract(i.payload,'$.name'),json_extract(f.payload,'$.company.name'),t.ticker) name,
    COALESCE((SELECT cik FROM financial_collection_jobs WHERE ticker=t.ticker ORDER BY generation DESC LIMIT 1),
      json_extract(i.payload,'$.cik'),json_extract(f.payload,'$.company.cik'),(SELECT cik FROM sec_filings WHERE ticker=t.ticker LIMIT 1)) cik,
    (SELECT MAX(report_date) FROM sec_filings WHERE ticker=t.ticker) latestPeriodEnd,
    COALESCE((SELECT MAX(updated_at) FROM financial_collection_jobs WHERE ticker=t.ticker),f.fetched_at) lastUpdatedAt
    FROM tickers t LEFT JOIN sec_cache i ON i.cache_key='admin:financial-issuer:'||t.ticker
    LEFT JOIN sec_cache f ON f.cache_key='sec:filings:'||t.ticker ORDER BY t.ticker LIMIT 1000`)
    .bind(JSON.stringify([...new Set([...dataEnabled,...tracked])])).all<Omit<FinancialMaintenanceCompany,"tracked"|"dataEnabled">>();
  const companies = rows.results.map(row=>({...row,tracked:tracked.includes(row.ticker),dataEnabled:dataEnabled.includes(row.ticker)}));
  return { companies, environment: { aiEnabled: aiIsEnabled(env), dataCollectionEnabled: env.SEC_DATA_COLLECTION_ENABLED === "true", workflowAvailable: Boolean(env.SEC_ANALYSIS_WORKFLOW) } };
}
async function companyIdentity(env: SecPipelineEnv, ticker: string, tracked = trackedTickersFor(env), dataEnabled = dataTickersFor(env)): Promise<FinancialMaintenanceCompany> {
  const row = await env.DB!.prepare(`SELECT cik,updated_at FROM financial_collection_jobs WHERE ticker=? ORDER BY generation DESC LIMIT 1`).bind(ticker).first<{ cik: string; updated_at: string }>();
  const feed = await new D1SecRepository(env.DB!).getCache<{ company?: { name?: string; cik?: string } }>(`sec:filings:${ticker}`);
  const filing = await env.DB!.prepare("SELECT cik,MAX(report_date) periodEnd FROM sec_filings WHERE ticker=?").bind(ticker).first<{ cik: string | null; periodEnd: string | null }>();
  const identity = await new D1SecRepository(env.DB!).getCache<{ name: string; cik: string }>(`admin:financial-issuer:${ticker}`);
  return { ticker, name: identity?.payload.name ?? feed?.payload.company?.name ?? ticker,
    cik: row?.cik ?? identity?.payload.cik ?? feed?.payload.company?.cik ?? filing?.cik ?? null,
    tracked: tracked.includes(ticker), dataEnabled: dataEnabled.includes(ticker), latestPeriodEnd: filing?.periodEnd ?? null, lastUpdatedAt: row?.updated_at ?? feed?.fetchedAt ?? null };
}
function periodFromQuarter(q: BusinessFlowQuarter): FinancialMaintenancePeriod {
  const metrics: FinancialMaintenanceMetric[] = FLOW_METRICS.map(id => {
    const amount = q.figures[id], lineage = amount?.lineage?.[0], source = q.sources.find(s => amount?.sourceIds.includes(s.id));
    return { id, label: labels[id] ?? id, value: amount?.value ?? null, unit: q.currency, scale: q.scale, basis: amount?.basis ?? "reported",
      ...(lineage?.url || source?.url ? { sourceUrl: lineage?.url ?? source?.url, sourceAccession: lineage?.accession } : {}),
      ...(amount?.formula ? { formula: amount.formula } : {}), ...(amount?.value == null ? { missingReason: "未披露或尚未完成提取" } : {}) };
  });
  for (const segment of q.segments) metrics.push({ id: `segment:${segment.id}`, label: segment.name, value: segment.revenue?.value ?? null,
    unit: q.currency, scale: q.scale, basis: segment.revenue?.basis ?? "reported", sourceUrl: segment.revenue?.lineage?.[0]?.url ?? q.sources.find(s=>segment.sourceIds.includes(s.id))?.url,
    sourceAccession: segment.revenue?.lineage?.[0]?.accession, formula: segment.revenue?.formula });
  return { periodEnd: q.periodEnd, ...(q.periodStart ? { periodStart: q.periodStart } : {}), fiscalLabel: q.label,
    status: metrics.some(m => m.value === null) ? "partial" : "complete", metrics, issues: [] };
}
export async function getFinancialCompany(env: SecPipelineEnv, ticker: string): Promise<FinancialMaintenanceCompanyDetail> {
  const company = await companyIdentity(env, ticker), publication = await readCompletePublicationForTicker(env.DB!, ticker);
  const periods = new Map<string, FinancialMaintenancePeriod>((publication.flow?.quarters ?? []).map(q => [q.periodEnd, periodFromQuarter(q)]));
  for (const q of publication.history?.quarters ?? []) {
    if (periods.has(q.periodEnd)) continue;
    periods.set(q.periodEnd, { periodEnd: q.periodEnd, periodStart: q.periodStart, status: "partial", issues: ["该期仅收入历史已提取，其他报表指标需查看原文与审计档案。"],
      metrics: [{ id: "revenue", label: "收入", value: q.revenue, unit: q.currency, scale: q.scale, basis: q.basis, formula: q.formula, sourceUrl: q.source.url, sourceAccession: q.source.accession },
        ...q.segments.map(s => ({ id: `segment:${s.id}`, label: s.name, value: s.value, unit: q.currency, scale: q.scale, basis: q.basis, sourceUrl: q.source.url, sourceAccession: q.source.accession }))] });
  }
  const filings = await env.DB!.prepare("SELECT report_date FROM sec_filings WHERE ticker=? AND form IN ('10-Q','10-K','10-Q/A','10-K/A') GROUP BY report_date ORDER BY report_date DESC LIMIT 40").bind(ticker).all<{ report_date: string }>();
  for (const filing of filings.results) if (filing.report_date && !periods.has(filing.report_date)) periods.set(filing.report_date, {
    periodEnd: filing.report_date, status: "missing", metrics: [], issues: ["已发现原始报告，该期展示数据尚未提取。10-K 年度数值不会直接当作单季。"] });
  const ordered = [...periods.values()].sort((a,b)=>b.periodEnd.localeCompare(a.periodEnd));
  company.latestPeriodEnd = ordered[0]?.periodEnd ?? company.latestPeriodEnd;
  return { company, periods: ordered, coverage, documents: await listFilingDisclosureAudits(env.DB!, ticker), tasks: (await new FinancialMaintenanceStore(env.DB!).list(ticker)).map(taskView) };
}

export async function handleFinancialAdminRequest(request: Request, env: SecPipelineEnv, now = Date.now()): Promise<Response> {
  if (!await authenticateAdmin(request, env.REPORT_ADMIN_PASSWORD, now)) return json({ error: "请登录财报管理后台。" }, 401);
  if (!env.DB) return json({ error: "财报数据服务暂时不可用。" }, 503);
  const path = new URL(request.url).pathname, store = new FinancialMaintenanceStore(env.DB);
  try {
    if (path === "/admin/financials/companies") return request.method === "GET" ? json(await listFinancialCompanies(env)) : json({ error: "Method not allowed" }, 405);
    const taskMatch = /^\/admin\/financials\/tasks\/([^/]+)(?:\/(cancel))?$/.exec(path);
    if (taskMatch) {
      if (!UUID.test(taskMatch[1]!)) return json({ error: "任务标识无效。" }, 400);
      if (request.method !== (taskMatch[2] ? "POST" : "GET")) return json({ error: "Method not allowed" }, 405);
      const row = await store.get(taskMatch[1]!);
      if (!row) return json({ error: "任务不存在。" }, 404);
      if (taskMatch[2] && ["analysis_dispatch","analysis_wait"].includes(row.stage) && ["running","queued"].includes(row.status)) return json({ error: "分析工作流正在提交或已提交，当前只能停止等待，不能取消已提交的分析。", task: taskView(row) }, 409);
      return json({ task: taskView(taskMatch[2] ? (await store.cancel(row.task_id, new Date(now)))! : row) });
    }
    const documentMatch = /^\/admin\/financials\/companies\/([^/]+)\/documents\/([a-f0-9]{64})$/.exec(path);
    if (documentMatch) {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      const ticker = normalizeTrackedTicker(documentMatch[1]!);
      if (!ticker) return json({ error: "公司代码无效。" }, 400);
      const query = new URL(request.url).searchParams;
      try {
        const page = await getFilingDisclosureAuditPage({ DB: env.DB, SEC_FILINGS: env.SEC_FILINGS }, ticker, documentMatch[2]!, {
          offset: query.has("offset") ? Number(query.get("offset")) : 0, limit: query.has("limit") ? Number(query.get("limit")) : 100,
          concept: query.get("concept") ?? undefined, periodEnd: query.get("periodEnd") ?? undefined });
        return page ? json(page) : json({ error: "原始披露档案不存在。" }, 404);
      } catch (error) { if (String(error).includes("INVALID_AUDIT_QUERY")) return json({ error: "筛选条件无效。" }, 400); throw error; }
    }
    const match = /^\/admin\/financials\/companies\/([^/]+)(?:\/(actions))?$/.exec(path);
    if (!match) return json({ error: "Not found" }, 404);
    let ticker: string;
    try { ticker = normalizeTrackedTicker(decodeURIComponent(match[1]!)); } catch { return json({ error: "公司代码无效。" }, 400); }
    if (!ticker) return json({ error: "公司代码无效。" }, 400);
    if (request.method !== (match[2] ? "POST" : "GET")) return json({ error: "Method not allowed" }, 405);
    if (!match[2]) return json(await getFinancialCompany(env, ticker));
    if (Number(request.headers.get("content-length") ?? 0) > 4096) return json({ error: "Request too large" }, 413);
    const text = await request.text(); if (text.length > 4096) return json({ error: "Request too large" }, 413);
    let body: { action?: string; requestId?: string; accessionNumber?: string; retryTaskId?: string };
    try { body = JSON.parse(text); } catch { return json({ error: "操作参数无效。" }, 400); }
    if (!body || !["extract","analyze","retry"].includes(body.action ?? "") || !UUID.test(body.requestId ?? "")) return json({ error: "操作参数或幂等标识无效。" }, 400);
    let action = body.action as "extract" | "analyze" | "retry", accessionNumber = body.accessionNumber;
    if (accessionNumber && cleanSecAccession(accessionNumber) !== accessionNumber) return json({ error: "财报编号无效。" }, 400);
    if (action === "retry") {
      const original = body.retryTaskId && UUID.test(body.retryTaskId) ? await store.get(body.retryTaskId) : null;
      if (!original || original.ticker !== ticker || !taskView(original).canRetry) return json({ error: "请选择已失败、部分完成或已取消的任务重试。" }, 409);
      action = original.action; accessionNumber = original.accession_number ?? undefined;
    }
    const existing = await store.byRequest(body.requestId!);
    if (existing) {
      if (existing.ticker !== ticker || existing.action !== action || existing.accession_number !== (accessionNumber ?? null) || existing.retry_of !== (body.action === "retry" ? body.retryTaskId : null)) return json({ error: "该操作标识已用于不同请求。" }, 409);
      return json({ task: taskView(existing), reused: true }, 202);
    }
    if (action === "analyze" && !aiIsEnabled(env)) return json({ error: "当前环境已禁用 AI 分析。可以先补全确定性财报数据；此操作不会修改分析开关。" }, 409);
    if (action === "analyze" && !env.SEC_ANALYSIS_WORKFLOW) return json({ error: "分析工作流尚未配置。" }, 503);
    const created = await store.create({ requestId: body.requestId!, ticker, action, accessionNumber, ...(body.action === "retry" ? { retryOf: body.retryTaskId } : {}) }, new Date(now));
    if (!created) {
      const same = await store.byRequest(body.requestId!);
      if (same) {
        if (same.ticker !== ticker || same.action !== action || same.accession_number !== (accessionNumber ?? null) || same.retry_of !== (body.action === "retry" ? body.retryTaskId : null)) return json({ error: "该操作标识已用于不同请求。" }, 409);
        return json({ task: taskView(same), reused: true }, 202);
      }
      const active = await store.active(ticker);
      return json({ error: "该公司已有维护任务，请等待完成或取消后重试。", ...(active ? { task: taskView(active) } : {}) }, 409);
    }
    return json({ task: taskView(created), reused: false }, 202);
  } catch { return json({ error: "财报维护服务暂时不可用，请稍后重试。" }, 503); }
}
