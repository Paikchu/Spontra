import { isResearchEligible } from "./scope.ts";
import type { ResearchMonitorState } from "../../../../shared/analysis-contract/research.ts";
import type { SecPipelineEnv } from "../operations.ts";
import { parseSecSubmissions, type SecCompany } from "../sec/sec.ts";
import { fetchMarketObservation, priceSignal, readProviderJson, type MarketObservation } from "./market.ts";
import { ResearchRepository, researchId } from "./repository.ts";
import { researchSearch } from "./runtime.ts";

export type ResearchUniverse = { tickers: string[]; asOf: string; receivedAt: string };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

async function companies(repo: ResearchRepository, env: SecPipelineEnv, now: string): Promise<Record<string, SecCompany>> {
  const cached = await repo.state<{ at: string; companies: Record<string, SecCompany> }>("sec-directory");
  if (cached && Date.parse(now) - Date.parse(cached.at) < 86400_000) return cached.companies;
  const raw = record(await readProviderJson("https://www.sec.gov/files/company_tickers_exchange.json", fetch, { "user-agent": env.SEC_USER_AGENT }));
  if (!Array.isArray(raw.fields) || !Array.isArray(raw.data)) throw new Error("sec_directory_invalid");
  const fields = raw.fields as string[];
  const entries: Record<string, SecCompany> = {};
  for (const row of raw.data) {
    if (!Array.isArray(row)) continue;
    const ticker = String(row[fields.indexOf("ticker")]).toUpperCase(), cikNumber = Number(row[fields.indexOf("cik")]);
    if (!Number.isFinite(cikNumber) || cikNumber <= 0) continue;
    entries[ticker] = { ticker, cikNumber, cik: String(cikNumber).padStart(10, "0"), name: String(row[fields.indexOf("name")]) };
  }
  await repo.setState("sec-directory", { at: now, companies: entries }, now); return entries;
}

export async function runResearchMonitor(env: SecPipelineEnv, clock = new Date()) {
  if (!env.DB || !env.RESEARCH_WORKFLOW) return { status: "not_configured" };
  const owner = crypto.randomUUID();
  const claimed = await env.DB.prepare(`INSERT INTO research_state (key,payload,updated_at) VALUES ('scan-lease',?,?)
    ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at
    WHERE research_state.updated_at < ? RETURNING payload`)
    .bind(owner, clock.toISOString(), new Date(clock.getTime() - 10 * 60_000).toISOString()).first();
  if (!claimed) return { status: "scan_already_running" };
  try { return await scan(env, clock); }
  finally { await env.DB.prepare("DELETE FROM research_state WHERE key='scan-lease' AND payload=?").bind(owner).run(); }
}

async function scan(env: SecPipelineEnv, clock: Date) {
  if (!env.DB || !env.RESEARCH_WORKFLOW) throw new Error("research_not_configured");
  const repo = new ResearchRepository(env.DB), now = clock.toISOString();
  const universe = await repo.state<ResearchUniverse>("universe");
  if (!universe) return { status: "awaiting_holdings" };
  universe.tickers = universe.tickers.filter(isResearchEligible);
  const issues: ResearchMonitorState["issues"] = [];
  const issue = (ticker: string, source: string, message: string) => issues.push({ ticker, source, message, observedAt: now });
  const previousStatus = await repo.state<ResearchMonitorState>("monitor");
  let directory: Record<string, SecCompany> | null = null;
  try { directory = await companies(repo, env, now); } catch { issue("*", "SEC", "SEC 公司目录获取失败，本轮无法检查新披露"); }
  // Round-robin bounded batches avoid one large universe exceeding a cron invocation's budget.
  const cursor = await repo.state<number>("scan-cursor") ?? 0;
  const batch = universe.tickers.slice(cursor, cursor + 6);
  await repo.setState("scan-cursor", cursor + 6 >= universe.tickers.length ? 0 : cursor + 6, now);
  for (const ticker of batch) {
    const baselineId = await researchId(["baseline", ticker]);
    await repo.enqueue({ id: baselineId, ticker, kind: "baseline", observedAt: now, sourceAt: null, payload: { reason: "首次持仓研究，建立可持续验证的业务问题" } });
    try {
      const quote = await fetchMarketObservation(ticker, now);
      const prior = await repo.state<MarketObservation>(`quote:${ticker}`);
      const signal = priceSignal(quote, prior);
      await repo.setState(`quote:${ticker}`, quote, now);
      if (quote.stale && quote.session === "regular") issue(ticker, "market", "行情时间已超过15分钟，已暂停异动判断");
      if (signal) await repo.enqueue({ id: await researchId([ticker, "price", signal.bucket]), ticker, kind: "price", observedAt: now, sourceAt: quote.sourceAt, payload: { ...quote, reason: signal.reason } });
    } catch { issue(ticker, "market", "行情请求失败，未使用旧报价生成异动"); }
    const secAt = await repo.state<string>(`sec-at:${ticker}`);
    if (directory && (!secAt || clock.getTime() - Date.parse(secAt) >= 5 * 60_000)) {
      const company = directory[ticker];
      if (!company) issue(ticker, "SEC", "未找到对应SEC申报主体");
      else try {
        const raw = await readProviderJson(`https://data.sec.gov/submissions/CIK${company.cik}.json`, fetch, { "user-agent": env.SEC_USER_AGENT });
        const filings = parseSecSubmissions(raw, company, 20);
        const recent = record(record(record(raw).filings).recent);
        const known = await repo.state<string[]>(`sec:${ticker}`);
        // On first observation only recent filings are research triggers; old history establishes a baseline.
        for (const filing of filings) if ((!known || !known.includes(filing.accessionNumber)) && Date.parse(filing.filingDate) >= clock.getTime() - 3 * 86400_000) {
          const index = Array.isArray(recent.accessionNumber) ? recent.accessionNumber.indexOf(filing.accessionNumber) : -1;
          const accepted = Array.isArray(recent.acceptanceDateTime) ? recent.acceptanceDateTime[index] : null;
          const sourceAt = typeof accepted === "string" && Number.isFinite(Date.parse(accepted)) ? new Date(accepted).toISOString() : null;
          await repo.enqueue({ id: await researchId([ticker, "filing", filing.accessionNumber]), ticker, kind: "filing", observedAt: now,
            sourceAt, payload: { accessionNumber: filing.accessionNumber, form: filing.form, filingDate: filing.filingDate, sourceUrl: filing.documentUrl } });
        }
        await repo.setState(`sec:${ticker}`, filings.map(filing => filing.accessionNumber), now);
        await repo.setState(`sec-at:${ticker}`, now, now);
      } catch { issue(ticker, "SEC", "新披露检查失败，将在下一轮重试"); }
    }
    const newsAt = await repo.state<string>(`news-at:${ticker}`);
    if (!newsAt || clock.getTime() - Date.parse(newsAt) >= 30 * 60_000) {
      try {
        const hits = await researchSearch(env).search({ query: `${ticker} company business news`, topic: "news", maxResults: 5,
          startDate: new Date(clock.getTime() - 2 * 86400_000).toISOString().slice(0, 10) }, { scope: "spontra:single-user-research", maxAgeMs: 30 * 60_000 });
        const urls = hits.data.results.map(hit => hit.url).sort();
        const previous = await repo.state<string[]>(`news:${ticker}`);
        if (previous && urls.some(url => !previous.includes(url))) await repo.enqueue({ id: await researchId([ticker, "news", urls]), ticker, kind: "news", observedAt: now, sourceAt: null, payload: { candidates: hits.data.results } });
        await repo.setState(`news:${ticker}`, urls, now); await repo.setState(`news-at:${ticker}`, now, now);
      } catch { issue(ticker, "news", "新闻检索失败，本轮新闻覆盖不完整"); }
    }
  }
  for (const followup of await repo.due(now)) {
    if (!isResearchEligible(followup.ticker)) continue;
    await repo.enqueue({ id: await researchId(["followup", followup.id]), ticker: followup.ticker, kind: "followup", observedAt: now, sourceAt: null,
      payload: { question: followup.question, query: followup.query } });
    await repo.followupQueued(followup.id);
  }
  for (const candidate of await repo.recoverable(now)) {
    if (!isResearchEligible(candidate.ticker)) continue;
    if (candidate.status === "budget_exhausted") {
      if (candidate.updated_at.slice(0, 10) < now.slice(0, 10)) await repo.retry(candidate, now);
      continue;
    }
    if (candidate.attempts >= 2) { issue(candidate.ticker, "research", "调查连续失败，需要检查后台运行状态"); continue; }
    if (candidate.status === "failed") { await repo.retry(candidate, now); continue; }
    const status = await env.RESEARCH_WORKFLOW.get(candidate.workflow_id).then(instance => instance.status()).catch(() => null);
    if (status && ["errored", "terminated", "complete"].includes(status.status)) await repo.retry(candidate, now);
  }
  for (const pending of await repo.pending(now)) {
    if (!isResearchEligible(pending.ticker)) continue;
    const owner = crypto.randomUUID();
    if (!await repo.claim(pending.id, owner, now, new Date(clock.getTime() + 120_000).toISOString())) continue;
    try {
      // A lost create response is reconciled against the stable workflow ID before retrying.
      try { await env.RESEARCH_WORKFLOW.create({ id: pending.workflow_id, params: { caseId: pending.id } }); }
      catch (error) { const existing = await env.RESEARCH_WORKFLOW.get(pending.workflow_id).then(instance => instance.status()).catch(() => null); if (!existing) throw error; }
      await repo.dispatched(pending.id, owner, now);
    } catch { await repo.dispatchFailed(pending.id, owner, now); issue(pending.ticker, "research", "调查任务启动失败，已保留待重试"); }
  }
  const preserved = previousStatus?.issues.filter(item => item.ticker !== "*" && isResearchEligible(item.ticker) && !batch.includes(item.ticker)) ?? [];
  const state: ResearchMonitorState = { enabled: true, tickers: universe.tickers, holdingsAsOf: universe.asOf, lastScanAt: now, issues: [...preserved, ...issues].slice(-100) };
  await repo.setState("monitor", state, now);
  return { status: "scanned", scanned: batch.length, issues: issues.length };
}
