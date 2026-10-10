import type { ExplainerSource } from "../../../../shared/analysis-contract/business-explainer.ts";
import type { OperatingMetric, OperatingMetricsPublication } from "../../../../shared/analysis-contract/operating-metrics.ts";
import { AiRunStore, quietly } from "../ai-runs/store.ts";
import { findSecurity } from "../catalog/security-directory.ts";
import { assertTrackedTicker, requireDb, trackedTickersFor } from "../core.ts";
import { earningsEvents } from "../guidance/workflow.ts";
import { callWorkerSecModel, type SecPipelineEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { streamSecSubmissionParts, type SecFilingFeed } from "../sec/sec.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import { extractOperatingMetrics, OPERATING_EXTRACTOR_VERSION, OPERATING_MAX_OUTPUT_TOKENS, publishOperatingMetrics, type OperatingModelCall } from "./extract.ts";
import { operatingMetricsCacheKey } from "./read.ts";

/**
 * Operating metrics are read from the documents that state them: the annual and quarterly reports
 * (the business section counts data centers and power) and the earnings exhibits (the quarter's
 * capacity and delivery highlights). One Workflow extracts one filing; the sweep starts at most one
 * per tick for the newest filing not yet read, and every run republishes the company's set.
 */
export type OperatingMetricsParams = { ticker: string; accession: string; form: string; filingDate: string; manual?: boolean };
export const OPERATING_METRICS_FORMS = new Set(["10-K", "10-Q", "20-F", "8-K", "6-K"]);
const MAX_PARTS = 4;

/** Every filing's extraction for a ticker lives in one record, so publishing needs no key listing. */
type MaterialRecord = { version: string; form: string; filingDate: string; source: ExplainerSource; metrics: OperatingMetric[]; rejected: number; failed?: string | null };
type Materials = Record<string, MaterialRecord>;
export const operatingMaterialsKey = (ticker: string) => `operating-metrics:materials:v1:${ticker}`;

async function readMaterials(repository: D1SecRepository, ticker: string): Promise<Materials> {
  return (await repository.getCache<Materials>(operatingMaterialsKey(ticker)))?.payload ?? {};
}

/** Filings worth reading, newest first: periodic reports and the earnings 8-Ks the guidance sweep already recognises. */
export function candidateFilings(feed: SecFilingFeed | null, now = Date.now()): Array<{ accession: string; form: string; filingDate: string }> {
  if (!feed) return [];
  const earnings = new Set(earningsEvents(feed, now).map(e => e.accession));
  return feed.filings
    .filter(f => /^(10-K|10-Q|20-F)/.test(f.form) || earnings.has(f.accessionNumber))
    .map(f => ({ accession: f.accessionNumber, form: f.form.replace(/\/A$/, ""), filingDate: f.filingDate }))
    .sort((a, b) => b.filingDate.localeCompare(a.filingDate))
    .slice(0, 12);
}

export async function runOperatingMetricsSweep(env: SecPipelineEnv, now = Date.now()): Promise<{ checked: number; started: string[]; failed: string[] }> {
  const result = { checked: 0, started: [] as string[], failed: [] as string[] };
  if (!env.OPERATING_METRICS_WORKFLOW || !env.DB || env.OPERATING_METRICS_ENABLED !== "true") return result;
  const repository = new D1SecRepository(env.DB);
  for (const ticker of trackedTickersFor(env)) {
    result.checked++;
    try {
      const feed = (await repository.getCache<SecFilingFeed>(`sec:filings:${ticker}`))?.payload ?? null;
      const materials = await readMaterials(repository, ticker);
      const next = candidateFilings(feed, now).find(f => materials[f.accession]?.version !== OPERATING_EXTRACTOR_VERSION && !materials[f.accession]?.failed);
      if (!next) continue;
      const id = `operating-${ticker.replace(/[^A-Za-z0-9]/g, "-")}-${next.accession}-${OPERATING_EXTRACTOR_VERSION.replace(/[^A-Za-z0-9]/g, "")}`;
      await env.OPERATING_METRICS_WORKFLOW.create({ id, params: { ticker, accession: next.accession, form: next.form, filingDate: next.filingDate } });
      await quietly(() => new AiRunStore(env.DB!).start({ kind: "metrics", ticker, runId: id, trigger: "schedule", accession: next.accession }, new Date(now).toISOString()));
      result.started.push(ticker);
      return result;
    } catch (error) {
      if (!/already exists|duplicate/i.test(String(error))) result.failed.push(ticker);
    }
  }
  return result;
}

export async function executeOperatingMetricsWorkflow(params: OperatingMetricsParams, step: WorkflowStepLike, env: SecPipelineEnv, fetcher: typeof fetch = fetch) {
  assertTrackedTicker(env, params.ticker);
  const modelVersion = env.SEC_ANALYSIS_MODEL || "deepseek-flash";
  const companyName = findSecurity(params.ticker)?.name ?? params.ticker;
  const now = await step.do("operating-time", async () => new Date().toISOString());
  const filing = await step.do("operating-filing", async () => {
    const feed = (await new D1SecRepository(requireDb(env)).getCache<SecFilingFeed>(`sec:filings:${params.ticker}`))?.payload ?? null;
    const row = feed?.filings.find(f => f.accessionNumber === params.accession);
    if (!row) throw new Error("Filing is not in the cached SEC feed");
    return { cikNumber: row.cikNumber, documentUrl: row.documentUrl, form: row.form };
  });
  // The main document of a periodic report, or the Exhibit 99 documents of an earnings 8-K; binary parts are skipped.
  const parts = await step.do("operating-parts", async () => {
    const all = await streamSecSubmissionParts(filing.cikNumber, params.accession, fetcher, env.SEC_USER_AGENT);
    const wanted = /^(10-K|10-Q|20-F)/.test(filing.form) ? all.filter(p => p.type.replace(/\/A$/, "") === filing.form.replace(/\/A$/, "")) : all.filter(p => /^EX-99/i.test(p.type));
    return wanted.filter(p => p.text && p.text.length >= 400).slice(0, MAX_PARTS).map(p => ({ type: p.type, filename: p.filename, text: p.text }));
  });
  const model: OperatingModelCall = (stage, system, payload) => callWorkerSecModel(env, fetcher, stage, system, payload, modelVersion, 5 * 60_000, true, { maxTokens: OPERATING_MAX_OUTPUT_TOKENS });
  const folder = `https://www.sec.gov/Archives/edgar/data/${filing.cikNumber}/${params.accession.replaceAll("-", "")}/`;
  const source: ExplainerSource = { id: `f-${params.accession}`, title: `${companyName} ${filing.form} ${params.filingDate}`, url: filing.documentUrl || folder, kind: "sec", publishedAt: params.filingDate };
  const metrics: OperatingMetric[] = [];
  let rejected = 0, failed: string | null = null;
  for (const [index, part] of parts.entries()) {
    try {
      const result = await step.do(`operating-extract-${index}`, () => extractOperatingMetrics({ ticker: params.ticker, companyName, source, documentKind: part.type, text: part.text }, model));
      metrics.push(...result.metrics);
      rejected += result.rejected;
    } catch (error) {
      // One unreadable part must not stop the filing; it is recorded so the sweep does not retry it every tick.
      failed = String(error instanceof Error ? error.message : error).slice(0, 300);
    }
  }
  const published = await step.do("operating-publish", async () => {
    const repository = new D1SecRepository(requireDb(env));
    const materials = await readMaterials(repository, params.ticker);
    materials[params.accession] = { version: OPERATING_EXTRACTOR_VERSION, form: filing.form, filingDate: params.filingDate, source, metrics, rejected, failed: metrics.length ? null : failed };
    await repository.setCache(operatingMaterialsKey(params.ticker), materials, now);
    const publication = publishOperatingMetrics(params.ticker, Object.values(materials).map(m => ({ source: m.source, metrics: m.metrics })), modelVersion, now);
    if (publication) {
      await repository.setCache(operatingMetricsCacheKey(params.ticker), publication, now);
      await new AiRunStore(requireDb(env)).saveVersion("metrics", params.ticker, publication, now);
    }
    return publication;
  });
  return { status: metrics.length ? "ready" : failed ? "failed" : "empty", parts: parts.length, metrics: metrics.length, rejected, published: published?.metrics.length ?? 0 };
}

/** The set a planner would read now, for fingerprints. */
export async function storedOperatingMetrics(env: SecPipelineEnv, ticker: string): Promise<OperatingMetricsPublication | null> {
  return (await new D1SecRepository(requireDb(env)).getCache<OperatingMetricsPublication>(operatingMetricsCacheKey(ticker)))?.payload ?? null;
}
