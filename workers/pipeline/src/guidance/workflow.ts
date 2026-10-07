import type { GuidanceCoverage, GuidancePublication, GuidanceResponse, GuidanceSource } from "../../../../shared/analysis-contract/guidance.ts";
import type { SecFiscalPeriod } from "../../../../shared/analysis-contract/report.ts";
import {
  attachRevenueContext, consolidateGuidance, readGuidancePublication, resolvePeriodEnd,
  type FiscalAnchor, type GuidanceEntry, type VerifiedGuidance,
} from "../../../../shared/analysis-runtime/guidance.ts";
import { findSecurity } from "../catalog/security-directory.ts";
import { assertTrackedTicker, requireDb, trackedTickersFor } from "../core.ts";
import { readCompletePublicationForTicker } from "../financial-data/publication.ts";
import { callWorkerSecModel, SecModelHttpError, type SecPipelineEnv } from "../operations.ts";
import { AnalysisRequestError } from "../read-api/contract-support/errors.ts";
import { researchSearch } from "../research/runtime.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { fiscalPeriodKey, readFiscalPeriod } from "../sec/fiscal-period.ts";
import type { SecFilingFeed } from "../sec/sec.ts";
import type { WorkflowStepContextLike, WorkflowStepLike } from "../workflow-core.ts";
import { extractGuidance, GUIDANCE_EXTRACTOR_VERSION, GUIDANCE_MAX_OUTPUT_TOKENS, type GuidanceModelCall } from "./extract.ts";
import { findIrDeck, AlphaVantageTranscriptProvider, readSecExhibits, reportedTranscriptRef, TranscriptAccessError, TranscriptQuotaError, type FoundMaterial, type TranscriptRef } from "./sources.ts";
import { GuidanceStore, type StoredMaterial } from "./store.ts";

export const guidanceCacheKey = (ticker: string) => `guidance:v1:${ticker}`;
const irHostsKey = (ticker: string) => `guidance-ir-hosts:v1:${ticker}`;
export type GuidanceWorkflowParams = { ticker: string; accession: string; eventDate: string };
export type GuidanceStep = WorkflowStepLike & { sleep(name: string, durationMs: number): Promise<void> };

/** Transcripts usually appear hours to a day after the call; four bounded re-checks, then give up. */
export const TRANSCRIPT_WAIT_HOURS = [0, 3, 12, 36, 72];
const EVENT_LOOKBACK_DAYS = 400;
const DEFAULT_DAILY_MODEL_CALLS = 40;
const DAILY_DECK_SEARCHES = 6;
const MODEL_BUDGET_MS = 3 * 60_000;

type TranscriptSource = { fetch(ticker: string, ref: TranscriptRef): Promise<FoundMaterial | null> };
export type GuidanceDeps = {
  fetcher?: typeof fetch;
  model?: GuidanceModelCall;
  transcripts?: TranscriptSource | null;
  deckSearch?: Parameters<typeof findIrDeck>[0] | null;
  secExhibits?: typeof readSecExhibits;
};

class BudgetExhausted extends Error {}

/** Earnings releases are 8-K Item 2.02 filings; the guidance in them is what this feature tracks. */
export function earningsEvents(feed: SecFilingFeed | null, now = Date.now()): Array<{ accession: string; eventDate: string }> {
  const since = new Date(now - EVENT_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  return (feed?.filings ?? []).filter(f => f.form === "8-K" && /(^|,)\s*2\.02\b/.test(f.items) && f.filingDate >= since)
    .map(f => ({ accession: f.accessionNumber, eventDate: f.filingDate }));
}

/**
 * Records new earnings events from the cached SEC feed (no SEC request) and starts at most two
 * Workflows per tick, newest first. The instance id is derived from the event and extractor
 * version, so an event is processed once per version.
 */
export async function runGuidanceSweep(env: SecPipelineEnv, now = Date.now()): Promise<{ enabled: boolean; recorded: number; started: string[]; failed: string[] }> {
  const result = { enabled: false, recorded: 0, started: [] as string[], failed: [] as string[] };
  if (env.GUIDANCE_ENABLED !== "true" || !env.GUIDANCE_WORKFLOW || !env.DB) return result;
  result.enabled = true;
  const store = new GuidanceStore(env.DB, env.SEC_FILINGS);
  const repository = new D1SecRepository(env.DB);
  const tickers = trackedTickersFor(env);
  const stamp = new Date(now).toISOString();
  for (const ticker of tickers) {
    const events = earningsEvents((await repository.getCache<SecFilingFeed>(`sec:filings:${ticker}`))?.payload ?? null, now);
    await store.recordEvents(ticker, events, stamp);
    result.recorded += events.length;
  }
  for (const event of await store.queuedEvents(tickers, 2)) {
    const id = `guidance-${event.ticker.replace(/[^A-Za-z0-9]/g, "-")}-${event.accession}-${GUIDANCE_EXTRACTOR_VERSION.replace(/[^A-Za-z0-9]/g, "")}`;
    try {
      await env.GUIDANCE_WORKFLOW.create({ id, params: { ticker: event.ticker, accession: event.accession, eventDate: event.event_date } });
      result.started.push(id);
    } catch (error) {
      if (!/already exists|duplicate/i.test(String(error))) { result.failed.push(event.accession); continue; }
    }
    await store.updateEvent(event.ticker, event.accession, { status: "started", workflowInstanceId: id }, stamp);
  }
  return result;
}

async function fiscalAnchors(repository: D1SecRepository, feed: SecFilingFeed | null): Promise<FiscalAnchor[]> {
  const anchors: FiscalAnchor[] = [];
  for (const filing of feed?.filings ?? []) {
    if (!/^(10-Q|10-K)(\/A)?$/.test(filing.form)) continue;
    const period = (await repository.getCache<SecFiscalPeriod | null>(fiscalPeriodKey(filing)))?.payload;
    if (period) anchors.push({ fiscalYear: period.fiscalYear, fiscalPeriod: period.fiscalPeriod, periodEnd: period.periodEnd });
    if (anchors.length >= 2) break;
  }
  return anchors;
}

function modelCall(env: SecPipelineEnv, store: GuidanceStore, fetcher: typeof fetch, day: string): GuidanceModelCall {
  const model = env.SEC_ANALYSIS_MODEL || "deepseek-flash";
  const cap = Number(env.GUIDANCE_DAILY_MODEL_CALLS) > 0 ? Number(env.GUIDANCE_DAILY_MODEL_CALLS) : DEFAULT_DAILY_MODEL_CALLS;
  return async (stage, system, payload) => {
    if (!await store.reserve("guidance-model", day, cap)) throw new BudgetExhausted("guidance model budget exhausted");
    let usage: unknown = null;
    try {
      return await callWorkerSecModel(env, fetcher, stage, system, payload, model, MODEL_BUDGET_MS, true,
        { maxTokens: GUIDANCE_MAX_OUTPUT_TOKENS, onMetrics: metrics => { usage = metrics.usage ?? null; } });
    } finally {
      await store.recordUsage(day, "guidance", model, usage).catch(() => undefined);
    }
  };
}

type ExtractOutcome = { status: "cached" | "extracted" | "deferred" | "failed" | "skipped" };

async function extractStored(env: SecPipelineEnv, deps: GuidanceDeps, materialId: string, input: { ticker: string; companyName: string; eventDate: string; reportedQuarter: string | null }, context?: WorkflowStepContextLike): Promise<ExtractOutcome> {
  const store = new GuidanceStore(requireDb(env), env.SEC_FILINGS);
  if (await store.hasExtraction(materialId, GUIDANCE_EXTRACTOR_VERSION)) return { status: "cached" };
  const row = await store.material(materialId);
  if (!row || row.status === "unsupported") return { status: "skipped" };
  const text = await store.materialText(row);
  if (!text) { await store.markMaterialFailed(materialId, "stored text missing"); return { status: "failed" }; }
  const now = new Date().toISOString();
  const model = deps.model ?? modelCall(env, store, deps.fetcher ?? fetch, now.slice(0, 10));
  try {
    const result = await extractGuidance({ ticker: input.ticker, companyName: input.companyName, kind: row.kind, publishedAt: row.published_at, reportedQuarter: input.reportedQuarter, text }, model);
    await store.saveExtraction(row, input.eventDate, GUIDANCE_EXTRACTOR_VERSION, { model: env.SEC_ANALYSIS_MODEL || "deepseek-flash", ...result }, now);
    return { status: "extracted" };
  } catch (error) {
    if (error instanceof BudgetExhausted) return { status: "deferred" };
    // One unreadable document must not stop the event: record it once retries are spent or the provider refused it outright.
    const refused = error instanceof SecModelHttpError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
    if (refused || (context?.attempt ?? 1) >= 3) { await store.markMaterialFailed(materialId, String(error instanceof Error ? error.message : error)); return { status: "failed" }; }
    throw error;
  }
}

/** Rebuilds the public view from every verified item of the company. Reads only stored data. */
export async function publishGuidance(env: SecPipelineEnv, ticker: string, now: string): Promise<{ items: number }> {
  const db = requireDb(env);
  const store = new GuidanceStore(db, env.SEC_FILINGS);
  const repository = new D1SecRepository(db);
  const [rows, materials, events, feed] = await Promise.all([
    store.items(ticker, GUIDANCE_EXTRACTOR_VERSION), store.materials(ticker), store.events(ticker),
    repository.getCache<SecFilingFeed>(`sec:filings:${ticker}`).then(r => r?.payload ?? null),
  ]);
  const anchors = await fiscalAnchors(repository, feed);
  const byId = new Map(materials.map(m => [m.id, m]));
  const sourceId = (id: string) => `m-${id.slice(0, 12)}`;
  const entries: GuidanceEntry[] = rows.flatMap(row => {
    const material = byId.get(row.material_id);
    if (!material) return [];
    const item = JSON.parse(row.payload) as VerifiedGuidance;
    return [{ ...item, eventAccession: row.event_accession, eventDate: row.event_date, materialKind: material.kind, sourceId: sourceId(material.id),
      periodEnd: resolvePeriodEnd(item.fiscalYear, item.fiscalQuarter, item.horizon, anchors) }];
  });
  const history = (await readCompletePublicationForTicker(db, ticker).catch(() => null))?.history?.quarters ?? [];
  const actuals = history.map(q => ({ periodStart: q.periodStart, periodEnd: q.periodEnd, value: Number(q.revenue) * (q.scale || 1) })).filter(q => Number.isFinite(q.value));
  const items = attachRevenueContext(consolidateGuidance(entries), actuals).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)).slice(0, 400);
  const cited = new Set(items.flatMap(i => i.sourceIds));
  const sources: GuidanceSource[] = materials.filter(m => cited.has(sourceId(m.id))).map(m => ({
    id: sourceId(m.id), kind: m.kind, sourceKind: m.source_kind, title: m.title.slice(0, 300), url: m.source_url, publishedAt: m.published_at,
  }));
  const coverage: GuidanceCoverage[] = [...events].sort((a, b) => b.event_date.localeCompare(a.event_date)).slice(0, 40).map(event => {
    const own = materials.filter(m => m.event_accession === event.accession && m.status !== "stored");
    const list: GuidanceCoverage["materials"] = own.map(m => ({ kind: m.kind, status: m.status === "extracted" ? "extracted" : m.status === "unsupported" ? "unsupported" : "failed" }));
    if (!own.some(m => m.kind === "transcript") && ["unavailable", "not_configured"].includes(event.transcript_status)) list.push({ kind: "transcript", status: "unavailable" });
    return { eventDate: event.event_date, accession: event.accession, materials: list.slice(0, 12) };
  });
  const publication: GuidancePublication = { schemaVersion: "guidance.v1", ticker, updatedAt: now, items, sources, coverage };
  if (!readGuidancePublication(publication, ticker)) throw new Error("Guidance publication failed its public contract.");
  await repository.setCache(guidanceCacheKey(ticker), publication, now);
  return { items: items.length };
}

export async function executeGuidanceWorkflow(params: GuidanceWorkflowParams, step: GuidanceStep, env: SecPipelineEnv, deps: GuidanceDeps = {}) {
  assertTrackedTicker(env, params.ticker);
  const fetcher = deps.fetcher ?? fetch;
  const store = () => new GuidanceStore(requireDb(env), env.SEC_FILINGS);
  const time = (name: string) => step.do(`guidance-time-${name}`, async () => new Date().toISOString());

  const context = await step.do("guidance-context", async () => {
    const feed = (await new D1SecRepository(requireDb(env)).getCache<SecFilingFeed>(`sec:filings:${params.ticker}`))?.payload ?? null;
    const filing = feed?.filings.find(f => f.accessionNumber === params.accession);
    if (!filing) throw new Error("Earnings filing is not in the cached SEC feed");
    // Started outside the sweep (a manual run): the event row still has to exist for coverage and status.
    await store().recordEvents(params.ticker, [{ accession: params.accession, eventDate: params.eventDate }], new Date().toISOString());
    const period = await readFiscalPeriod(new D1SecRepository(requireDb(env)), filing);
    const quarter = period?.fiscalPeriod === "FY" ? 4 : Number(period?.fiscalPeriod.slice(1));
    const ref: TranscriptRef | null = period && [1, 2, 3, 4].includes(quarter)
      ? { fiscalYear: period.fiscalYear, quarter: quarter as TranscriptRef["quarter"], date: params.eventDate } : null;
    return { cikNumber: filing.cikNumber, companyName: findSecurity(params.ticker)?.name ?? feed?.company?.name ?? params.ticker, ref };
  });

  const saveAll = async (found: FoundMaterial[]) => {
    const now = new Date().toISOString();
    const saved: StoredMaterial[] = [];
    for (const material of found) saved.push(await store().saveMaterial(params.ticker, params.accession, material, now));
    return saved;
  };
  const { materials: sec, ref } = await step.do("guidance-sec", async () => {
    const found = await (deps.secExhibits ?? readSecExhibits)(
      { cikNumber: context.cikNumber, accessionNumber: params.accession, filingDate: params.eventDate }, fetcher, env.SEC_USER_AGENT);
    return { materials: await saveAll(found), ref: context.ref ?? reportedTranscriptRef(found, params.eventDate) };
  });

  const transcripts = deps.transcripts !== undefined ? deps.transcripts
    : env.ALPHA_VANTAGE_API_KEY ? new AlphaVantageTranscriptProvider(env.ALPHA_VANTAGE_API_KEY, fetcher) : null;
  const dailyLimit = Number(env.GUIDANCE_DAILY_TRANSCRIPT_CALLS) > 0 ? Number(env.GUIDANCE_DAILY_TRANSCRIPT_CALLS) : 25;
  type Probe = { ref: TranscriptRef | null; material: StoredMaterial | null; denied: boolean; quota: boolean };
  const probe = (attempt: number) => step.do(`guidance-transcript-${attempt}`, async (): Promise<Probe> => {
    if (!ref) return { ref, material: null, denied: true, quota: false };
    if (!await store().reserve("guidance-transcript", new Date().toISOString().slice(0, 10), dailyLimit)) {
      return { ref, material: null, denied: false, quota: true };
    }
    try {
      const found = await transcripts!.fetch(params.ticker, ref);
      return { ref, material: found ? (await saveAll([found]))[0] : null, denied: false, quota: false };
    } catch (error) {
      if (error instanceof TranscriptAccessError) return { ref, material: null, denied: true, quota: false };
      if (error instanceof TranscriptQuotaError) return { ref, material: null, denied: false, quota: true };
      throw error;
    }
  });
  let transcript: Probe = transcripts ? await probe(0) : { ref, material: null, denied: false, quota: false };

  const materials = [...sec, ...(transcript.material ? [transcript.material] : [])];
  const deckSearch = deps.deckSearch !== undefined ? deps.deckSearch : env.GUIDANCE_DECK_SEARCH !== "false" && env.TAVILY_API_KEY ? researchSearch(env) : null;
  if (deckSearch && transcript.ref && !sec.some(m => m.kind === "deck")) {
    const deck = await step.do("guidance-deck", async () => {
      const db = requireDb(env);
      if (!await store().reserve("guidance-search", new Date().toISOString().slice(0, 10), DAILY_DECK_SEARCHES)) return null;
      const repository = new D1SecRepository(db);
      const hosts = (await repository.getCache<string[]>(irHostsKey(params.ticker)))?.payload ?? [];
      const found = await findIrDeck(deckSearch, { ticker: params.ticker, companyName: context.companyName, ref: transcript.ref!, hosts });
      if (!found) return null;
      if (!hosts.includes(found.host)) await repository.setCache(irHostsKey(params.ticker), [...hosts, found.host].slice(-3), new Date().toISOString());
      return (await saveAll([found.material]))[0];
    });
    if (deck) materials.push(deck);
  }

  const reportedQuarter = () => transcript.ref ? `Q${transcript.ref.quarter} FY${transcript.ref.fiscalYear}` : null;
  const extract = async (list: StoredMaterial[], label: string) => {
    let pending = list.filter(m => m.status !== "unsupported");
    for (let round = 0; round < 2 && pending.length; round++) {
      const deferred: StoredMaterial[] = [];
      for (const material of pending) {
        const outcome = await step.do(`guidance-extract-${material.id.slice(0, 16)}${round ? `-r${round}` : ""}`, (ctx) => extractStored(env, deps, material.id,
          { ticker: params.ticker, companyName: context.companyName, eventDate: params.eventDate, reportedQuarter: reportedQuarter() }, ctx));
        if (outcome.status === "deferred") deferred.push(material);
      }
      pending = deferred;
      if (pending.length && round === 0) {
        // Today's cap is spent; continue just after midnight UTC instead of failing the event.
        const now = Date.parse(await time(`budget-${label}`));
        await step.sleep(`guidance-budget-wait-${label}`, Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1, 0, 10) - now);
      }
    }
  };
  const publish = (label: string) => step.do(`guidance-publish-${label}`, async () => publishGuidance(env, params.ticker, new Date().toISOString()));

  await extract(materials, "initial");
  await publish("initial");
  await step.do("guidance-event-extracted", async () => store().updateEvent(params.ticker, params.accession, { status: "extracted" }, new Date().toISOString()));

  if (transcripts && !transcript.material && !transcript.denied) {
    const callTime = Date.parse(`${params.eventDate}T21:00:00Z`);
    for (let attempt = 1; attempt < TRANSCRIPT_WAIT_HOURS.length && !transcript.material && !transcript.denied; attempt++) {
      const now = Date.parse(await time(`transcript-${attempt}`));
      // A shared daily quota is different from a missing transcript: wait for the next UTC day.
      const nextDay = new Date(now); nextDay.setUTCHours(24, 10, 0, 0);
      const wait = transcript.quota ? nextDay.getTime() - now : callTime + TRANSCRIPT_WAIT_HOURS[attempt] * 3_600_000 - now;
      if (wait > 0) await step.sleep(`guidance-transcript-wait-${attempt}`, wait);
      transcript = await probe(attempt);
    }
    if (transcript.material) {
      await extract([transcript.material], "transcript");
      await publish("transcript");
    }
  }
  const transcriptStatus = !transcripts ? "not_configured" : transcript.material ? "extracted" : "unavailable";
  await step.do("guidance-event-complete", async () => {
    await store().updateEvent(params.ticker, params.accession, { status: "complete", transcriptStatus }, new Date().toISOString());
    // Coverage reflects the final transcript status.
    if (transcriptStatus !== "extracted") await publishGuidance(env, params.ticker, new Date().toISOString());
  });
  return { status: "complete", materials: materials.length, transcript: transcriptStatus };
}

/** Read-only: never starts extraction. A stored document that fails validation reads as preparing. */
export async function readGuidanceResponse(db: D1Database, rawTicker: string): Promise<GuidanceResponse> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)) throw new AnalysisRequestError("INVALID_TICKER", "Invalid company ticker.");
  const stored = await new D1SecRepository(db).getCache<unknown>(guidanceCacheKey(ticker));
  const guidance = stored ? readGuidancePublication(stored.payload, ticker) : null;
  return { schemaVersion: "guidance-response.v1", status: guidance ? "ready" : "preparing", guidance };
}
