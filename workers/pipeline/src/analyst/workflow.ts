import { reasoningFor } from "../ai-config.ts";
import type { DossierPublication, DossierResponse } from "../../../../shared/analysis-contract/dossier.ts";
import type { FindingsPublication } from "../../../../shared/analysis-contract/findings.ts";
import { readDossierPublication } from "../../../../shared/analysis-runtime/dossier.ts";
import { readFindingsPublication, refLabel, resolveRef, spanLabel, verifyFindings, type FindingData, type VerifiedFinding } from "../../../../shared/analysis-runtime/findings.ts";
import { formatDelta, formatResolved } from "../../../../shared/analysis-runtime/lens/format.ts";
import { readEventsResponse } from "../events/read.ts";
import { peersOf } from "../../../../shared/analysis-runtime/lens/table.ts";
import { AiRunStore } from "../ai-runs/store.ts";
import { sha256 } from "../company-analysis/api.ts";
import { assertTrackedTicker, requireDb } from "../core.ts";
import { readLinks } from "../filing-library/links.ts";
import { libraryToc } from "../filing-library/tool.ts";
import { findingsInput } from "../findings/workflow.ts";
import { readStoredFindings } from "../findings/read.ts";
import { lensCatalogue } from "../lens/agent.ts";
import { SecModelOutputError } from "../model-stream.ts";
import { callWorkerSecModel, type SecPipelineEnv } from "../operations.ts";
import { readPeersResponse } from "../peers/read.ts";
import { outboxStatement } from "../pipeline/outbox.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import { runAnalyst, salvageDecision, type AnalystModel, type AnalystOutcome, type AnalystRunInput } from "./agent.ts";
import { planFinding } from "./plan.ts";

/** Changing the analyst's prompt, lines, harness or grammar re-researches every company once. */
export const ANALYST_VERSION = "analyst.react.v4";
export const dossierCacheKey = (ticker: string) => `dossier:v1:${ticker}`;
export type AnalystWorkflowParams = { ticker: string; fingerprint: string };
/** `sleep` waits durably (Workflow step.sleep); without it a run whose every model call failed ends empty at once. */
export type AnalystDeps = { model?: AnalystModel; fetcher?: typeof fetch; sleep?: (name: string, ms: number) => Promise<void> };
/** A model provider outage: no researched finding got an answer. The run waits and tries again, longer each time. */
const OUTAGE_WAITS_MS = [30 * 60_000, 60 * 60_000, 2 * 60 * 60_000];
/** Model turns per UTC day across all companies; a cap, not a target. */
const DEFAULT_DAILY_TURNS = 300;
/** A composing turn reasons at length and then writes a long document; the first runs lost documents mid-chart to a shorter budget. */
const MODEL_BUDGET_MS = 10 * 60_000;

export type AnalystTrace = { version: string; generatedAt: string; findings: AnalystOutcome[] };

type Prepared = NonNullable<Awaited<ReturnType<typeof findingsInput>>>;
type Input = { findings: FindingsPublication; data: Prepared["data"]; ledger: Prepared["ledger"]; context: string | null; documents: Awaited<ReturnType<typeof libraryToc>>; fingerprint: string } | null;

/** What a run would research now: the served findings, the prepared data, and the newest periodic filings in the library. */
async function readInput(env: SecPipelineEnv, ticker: string): Promise<Input> {
  const db = requireDb(env);
  const findings = await readStoredFindings(db, ticker);
  const base = findings?.fingerprint ? await findingsInput(env, ticker) : null;
  if (!findings?.fingerprint || !base) return null;
  const documents = await libraryToc(db, ticker, { forms: ["10-K", "10-Q", "20-F"], limit: 3 });
  const fingerprint = await sha256(JSON.stringify({ version: ANALYST_VERSION, ticker, findings: findings.fingerprint, documents: documents.map(d => d.documentId).sort() }));
  return { findings, data: base.data, ledger: base.ledger, context: base.context, documents, fingerprint };
}

export async function analystFingerprint(env: SecPipelineEnv, ticker: string): Promise<string | null> {
  return (await readInput(env, ticker))?.fingerprint ?? null;
}

/** What the previous publication said about this finding's figures, and how each has moved since; context for the model, never a source. */
function background(f: VerifiedFinding, previous: FindingsPublication | null, data: FindingData, narrative: string | null): NonNullable<AnalystRunInput["background"]> {
  const refs = [...new Map(f.evidence.map(e => [JSON.stringify(e.ref), e])).values()];
  const sinceLast = previous ? refs.flatMap(e => {
    const then = resolveRef(data, e.ref, previous.periodEnd, e.span), now = resolveRef(data, e.ref, f.periodEnd, e.span);
    if (!then || !now) return [];
    const change = then.unit === "USD" && then.value > 0 && now.value > 0 ? formatDelta((now.value - then.value) / then.value * 100, "USD", e.ref) : null;
    return [{ label: refLabel(data, e.ref), then: `${formatResolved(then, e.ref)} (${spanLabel(then)})`, now: `${formatResolved(now, e.ref)} (${spanLabel(now)})`, change }];
  }) : [];
  const mine = new Set(refs.map(e => JSON.stringify(e.ref)));
  const prior = previous?.findings.map(p => ({ p, shared: p.evidence.filter(e => mine.has(JSON.stringify(e.ref))).length })).filter(x => x.shared > 0).sort((a, b) => b.shared - a.shared)[0]?.p ?? null;
  return { narrative: narrative?.slice(0, 4000) ?? null, sinceLast, priorCall: prior && previous ? { periodEnd: previous.periodEnd, title: prior.title, judgment: prior.judgment.text } : null };
}

/** Atomic daily counter on the feature_budget table; false once the cap is reached. */
async function reserveTurn(env: SecPipelineEnv, now: string): Promise<boolean> {
  const cap = Number(env.ANALYST_DAILY_TURNS) || DEFAULT_DAILY_TURNS;
  const row = await requireDb(env).prepare("INSERT INTO feature_budget (day,feature,units) VALUES (?,?,1) ON CONFLICT(day,feature) DO UPDATE SET units=units+1 WHERE units<? RETURNING units")
    .bind(now.slice(0, 10), "analyst-turns", cap).first<{ units: number }>().catch(() => null);
  return !!row;
}

/**
 * Whether a run met a model provider outage rather than a content problem: no researched finding got an answer. A
 * finding is unanswered when it failed, or when every one of its turns came back without a word (an empty stream reads
 * as an invalid turn with no thought). Decided from the settled outcomes, so a replayed instance decides the same way.
 */
export function providerOutage(researched: PromiseSettledResult<AnalystOutcome>[]): boolean {
  const unanswered = (r: PromiseSettledResult<AnalystOutcome>) => r.status === "rejected"
    || (!r.value.document && r.value.turns.length > 0 && r.value.turns.every(t => t.action === "invalid" && !t.thought));
  return researched.length > 0 && researched.every(unanswered);
}

export async function executeAnalystWorkflow(params: AnalystWorkflowParams, step: WorkflowStepLike, env: SecPipelineEnv, deps: AnalystDeps = {}) {
  assertTrackedTicker(env, params.ticker);
  const fetcher = deps.fetcher ?? fetch;
  const modelVersion = env.SEC_REASONING_MODEL || env.SEC_ANALYSIS_MODEL || "deepseek-flash";
  const now = await step.do("analyst-time", async () => new Date().toISOString());
  const input = await step.do("analyst-input", () => readInput(env, params.ticker));
  if (!input || input.fingerprint !== params.fingerprint) return { status: "superseded" as const };
  const db = requireDb(env);
  const peers = await readPeersResponse(db).then(r => r.peers).catch(() => null);
  const events = await readEventsResponse(db, params.ticker).then(r => r.events).catch(() => null);
  const data = { ...input.data, peers, events };
  // The publication before this one, for what it said about the same figures and how they moved since.
  const store = new AiRunStore(db);
  const previous = await store.versions("findings", params.ticker).then(async v => { for (const item of v) { const stored = await store.version("findings", params.ticker, item.id).catch(() => null); const p = stored ? readFindingsPublication(stored.publication, params.ticker) : null; if (p && p.generatedAt !== input.findings.generatedAt && p.periodEnd < input.findings.periodEnd) return p; } return null; }).catch(() => null);
  const { verified } = verifyFindings(input.findings, data);
  const categories = [...new Set((await readLinks(db, { ticker: params.ticker }).catch(() => [])).filter(l => (l.status === "verified" || l.status === "confirmed") && l.industryCategory).map(l => l.industryCategory!))];
  const catalogue = lensCatalogue(input.ledger, data, input.findings.periodEnd);
  const model: AnalystModel = deps.model ?? (async (stage, system, payload) => {
    try { return await callWorkerSecModel(env, fetcher, stage, system, payload, modelVersion, MODEL_BUDGET_MS, true, { reasoning: reasoningFor(env, "analyst"), ticker: params.ticker, kind: "analyst" }); }
    catch (error) { if (error instanceof SecModelOutputError) return salvageDecision(error.partialContent); throw error; }
  });
  const peerTickers = peersOf(data, params.ticker);
  const outcomes: AnalystOutcome[] = [];
  // Light findings keep their own document; the others are researched at once, each with its own step names.
  // A run in which no researched finding got an answer met a provider outage, not a content problem: it waits and runs
  // again (step names carry the attempt), so an outage does not leave the findings without a dossier until they change.
  let settled: PromiseSettledResult<AnalystOutcome>[] = [];
  for (let attempt = 0; ; attempt++) {
    const prefix = attempt ? `r${attempt}-` : "";
    settled = await Promise.allSettled(verified.map(async f => {
      const plan = planFinding(f, data, peerTickers);
      if (plan.tier === "light") return { id: f.id, tier: plan.tier, lines: [], document: null, materials: [], turns: [], warnings: ["light tier: not researched"], review: [] } satisfies AnalystOutcome;
      return runAnalyst({ env, ticker: params.ticker, finding: f, plan, data, catalogue, categories, documents: input.documents, record: input.findings.record ?? [], model, stage: (name, cb) => step.do(`analyst-${prefix}${name}`, cb), reserveTurn: () => reserveTurn(env, now), now, background: background(f, previous, data, input.context) });
    }));
    const researched = settled.filter((_, k) => planFinding(verified[k]!, data, peerTickers).tier !== "light");
    const outage = providerOutage(researched);
    if (!outage || !deps.sleep || attempt >= OUTAGE_WAITS_MS.length) break;
    await deps.sleep(`analyst-model-wait-${attempt + 1}`, OUTAGE_WAITS_MS[attempt]!);
  }
  settled.forEach((s, i) => outcomes.push(s.status === "fulfilled" ? s.value : { id: verified[i]!.id, tier: "standard", lines: [], document: null, materials: [], turns: [], warnings: [`failed: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`], review: [] }));
  const documents: DossierPublication["documents"] = {};
  const materials = new Map<string, DossierPublication["materials"][number]>();
  for (const o of outcomes) if (o.document) {
    // Material ids are per finding; the dossier prefixes them so two findings' quotes never collide.
    const prefix = `${o.id}:`;
    documents[o.id] = { rows: o.document.rows.map(r => ({ ...r, cells: r.cells.map(c => c.map(b => b.kind === "quote" ? { ...b, materialId: prefix + b.materialId } : b)) })) };
    for (const m of o.materials) materials.set(prefix + m.id, { ...m, id: prefix + m.id });
  }
  const trace: AnalystTrace = { version: ANALYST_VERSION, generatedAt: now, findings: outcomes };
  if (!Object.keys(documents).length) {
    await step.do("analyst-trace", async () => { await new AiRunStore(db).saveVersion("analyst", params.ticker, { schemaVersion: "dossier.v1", ticker: params.ticker, findingsFingerprint: input.findings.fingerprint, fingerprint: params.fingerprint, generatedAt: now, model: modelVersion, documents: {}, materials: [], analystTrace: trace }, now); });
    return { status: "empty" as const, findings: outcomes.map(o => ({ id: o.id, tier: o.tier, turns: o.turns.length, warnings: o.warnings })) };
  }
  const dossier: DossierPublication = { schemaVersion: "dossier.v1", ticker: params.ticker, findingsFingerprint: input.findings.fingerprint!, fingerprint: params.fingerprint, generatedAt: now, model: modelVersion, documents, materials: [...materials.values()] };
  if (!readDossierPublication(dossier, params.ticker)) throw new Error("The dossier failed its own contract.");
  await step.do("analyst-publish", async () => {
    const record = { ...dossier, analystTrace: trace };
    await db.batch([
      db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at").bind(dossierCacheKey(params.ticker), JSON.stringify(record), now),
      outboxStatement(db, { type: "dossier.published", ticker: params.ticker }, now),
    ]);
    await new AiRunStore(db).saveVersion("analyst", params.ticker, record, now);
  });
  return { status: "ready" as const, documents: Object.keys(documents).length, findings: outcomes.map(o => ({ id: o.id, tier: o.tier, lines: o.lines, turns: o.turns.length, composed: !!o.document, warnings: o.warnings.length, review: o.review.length })) };
}

/** The stored dossier, through the contract; the operator's trace is left out. */
export async function readDossierResponse(db: D1Database, rawTicker: string): Promise<DossierResponse> {
  const ticker = rawTicker.trim().toUpperCase();
  const stored = await new D1SecRepository(db).getCache<unknown>(dossierCacheKey(ticker));
  const dossier = stored ? readDossierPublication(stored.payload, ticker) : null;
  return { schemaVersion: "dossier-response.v1", status: dossier ? "ready" : "preparing", dossier };
}
