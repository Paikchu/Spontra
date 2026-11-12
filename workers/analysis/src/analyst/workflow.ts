import { modelFor, reasoningFor } from "../ai-config.ts";
import type { DossierPublication } from "../../../../shared/analysis-contract/dossier.ts";
import type { FindingsPublication } from "../../../../shared/analysis-contract/findings.ts";
import { readDossierPublication } from "../../../../shared/analysis-runtime/dossier.ts";
import { findingLeadsOf, readFindingsPublication, refLabel, resolveRef, spanLabel, verifyFindingLeads, type FindingData, type VerifiedFindingLead } from "../../../../shared/analysis-runtime/findings.ts";
import { formatDelta, formatResolved } from "../../../../shared/analysis-runtime/lens/format.ts";
import { readEventsResponse } from "../events/read.ts";
import { peersOf } from "../../../../shared/analysis-runtime/lens/table.ts";
import { comparablePeers } from "../../../../shared/analysis-runtime/peers.ts";
import { AiRunStore } from "../ai-runs/store.ts";
import { sha256 } from "../sha256.ts";
import { assertFeatureTicker, requireDb } from "../core.ts";
import { readLinks } from "../filing-library/links.ts";
import { libraryToc } from "../filing-library/tool.ts";
import { findingsInput } from "../findings/workflow.ts";
import { readStoredFindings } from "../findings/read.ts";
import { seriesCatalogue } from "../findings/catalogue.ts";
import type { AnalysisEnv } from "../operations.ts";
import type { PiLoaded } from "../pi/host.ts";
import { sessionRunner, type SessionRunner } from "../pi/runs.ts";
import { readPeersResponse } from "../peers/read.ts";
import { publicationOutboxStatements } from "../publication/publish.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import { analystRecipe, hydrateAnalyst, runAnalyst, type AnalystOutcome, type AnalystRunInput, type AnalystSpec, type AnalystState } from "./agent.ts";
import { loadStageData } from "../stage/data.ts";
import { planFinding } from "./plan.ts";

/** Changing the analyst's prompt, lines, harness or grammar re-researches every company once. */
export const ANALYST_VERSION = "analyst.artifact.v2";
export const dossierCacheKey = (ticker: string) => `dossier:v1:${ticker}`;
/** The input of the last run that composed nothing; the same input is not researched again until it changes. */
export const emptyDossierKey = (ticker: string) => `dossier:empty:v1:${ticker}`;
export type AnalystWorkflowParams = { ticker: string; fingerprint: string };
/** `sleep` waits durably (Workflow step.sleep); without it a run whose every model call failed errors at once. */
export type AnalystDeps = { run?: SessionRunner; sleep?: (name: string, ms: number) => Promise<void>; runId?: string };
/** A model provider outage: no researched finding got an answer. The run waits and tries again, longer each time. */
const OUTAGE_WAITS_MS = [30 * 60_000, 60 * 60_000, 2 * 60 * 60_000];
/** Model turns per UTC day across all companies; a cap, not a target. */
const DEFAULT_DAILY_TURNS = 300;

export type AnalystTrace = { version: string; generatedAt: string; findings: AnalystOutcome[] };

type Prepared = NonNullable<Awaited<ReturnType<typeof findingsInput>>>;
type Input = { findings: FindingsPublication; data: Prepared["data"]; ledger: Prepared["ledger"]; context: string | null; documents: Awaited<ReturnType<typeof libraryToc>>; fingerprint: string } | null;

/** What a run would research now: the served findings, the prepared data, and the newest periodic filings in the library. */
async function readInput(env: AnalysisEnv, ticker: string): Promise<Input> {
  const db = requireDb(env);
  const findings = await readStoredFindings(db, ticker);
  const base = findings?.fingerprint ? await findingsInput(env, ticker) : null;
  if (!findings?.fingerprint || !base) return null;
  const documents = await libraryToc(db, ticker, { forms: ["10-K", "10-Q", "20-F"], limit: 3 });
  const fingerprint = await sha256(JSON.stringify({ version: ANALYST_VERSION, ticker, findings: findings.fingerprint, documents: documents.map(d => d.documentId).sort() }));
  return { findings, data: base.data, ledger: base.ledger, context: base.context, documents, fingerprint };
}

export async function analystFingerprint(env: AnalysisEnv, ticker: string): Promise<string | null> {
  return (await readInput(env, ticker))?.fingerprint ?? null;
}

/** A partial dossier is visible, but the scheduler must continue until every lead has its own artifact. */
export async function completedAnalystFingerprint(env: AnalysisEnv, ticker: string): Promise<string | null> {
  const repository = new D1SecRepository(requireDb(env));
  const empty = await repository.getCache<{ fingerprint?: string }>(emptyDossierKey(ticker));
  if (empty?.payload.fingerprint) return empty.payload.fingerprint;
  const findings = await readStoredFindings(requireDb(env), ticker);
  const cached = await repository.getCache<unknown>(dossierCacheKey(ticker));
  const dossier = cached ? readDossierPublication(cached.payload, ticker) : null;
  if (!findings?.fingerprint || dossier?.findingsFingerprint !== findings.fingerprint) return null;
  const leads = findingLeadsOf(findings);
  return leads.length && leads.every(lead => dossier.artifacts?.[lead.id]) ? dossier.fingerprint : null;
}

/** A refused Pi session has no authored artifact; wait for tomorrow's budget rather than marking it empty. */
const budgetRetryDelay = (outcomes: AnalystOutcome[], now: string): number | null => {
  if (!outcomes.some(outcome => !outcome.artifact && outcome.turns.some(turn => turn.action === "budget"))) return null;
  const time = new Date(now);
  return Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate() + 1) - time.getTime() + 1000;
};

/** What the previous publication said about this finding's figures, and how each has moved since; context for the model, never a source. */
function background(f: VerifiedFindingLead, previous: FindingsPublication | null, data: FindingData, narrative: string | null): NonNullable<AnalystRunInput["background"]> {
  const refs = [...new Map(f.evidence.map(e => [JSON.stringify(e.ref), e])).values()];
  const sinceLast = previous ? refs.flatMap(e => {
    const then = resolveRef(data, e.ref, previous.periodEnd, e.span), now = resolveRef(data, e.ref, f.periodEnd, e.span);
    if (!then || !now) return [];
    const change = then.unit === "USD" && then.value > 0 && now.value > 0 ? formatDelta((now.value - then.value) / then.value * 100, "USD", e.ref) : null;
    return [{ label: refLabel(data, e.ref), then: `${formatResolved(then, e.ref)} (${spanLabel(then)})`, now: `${formatResolved(now, e.ref)} (${spanLabel(now)})`, change }];
  }) : [];
  const mine = new Set(refs.map(e => JSON.stringify(e.ref)));
  const prior = (previous ? findingLeadsOf(previous) : []).map(p => ({ p, shared: p.evidence.filter(e => mine.has(JSON.stringify(e.ref))).length })).filter(x => x.shared > 0).sort((a, b) => b.shared - a.shared)[0]?.p ?? null;
  return { narrative: narrative?.slice(0, 4000) ?? null, sinceLast, priorCall: prior && previous ? { periodEnd: previous.periodEnd, title: prior.title, question: prior.question } : null };
}

/**
 * The published dossier artifacts by finding. An artifact carries its own sources, so the record names no materials:
 * those served only the lens documents of dossiers written before artifacts.
 */
function dossierContent(outcomes: AnalystOutcome[]): Pick<DossierPublication, "artifacts" | "materials"> {
  const artifacts: NonNullable<DossierPublication["artifacts"]> = {};
  for (const o of outcomes) if (o.artifact) artifacts[o.id] = { subject: o.artifact.subject, version: o.artifact.version, degraded: o.artifact.degraded.slice(0, 40) };
  return { artifacts, materials: [] };
}

/** Atomic daily counter on the feature_budget table; false once the cap is reached. */
async function reserveTurn(env: AnalysisEnv, now: string): Promise<boolean> {
  const cap = Number(env.ANALYST_DAILY_TURNS) || DEFAULT_DAILY_TURNS;
  const row = await requireDb(env).prepare("INSERT INTO feature_budget (day,feature,units) VALUES (?,?,1) ON CONFLICT(day,feature) DO UPDATE SET units=units+1 WHERE units<? RETURNING units")
    .bind(now.slice(0, 10), "analyst-turns", cap).first<{ units: number }>();
  return !!row;
}

/** One finding's session, rebuilt from its spec; each model call is reserved against the day's allowance. */
export async function analystLoader(spec: AnalystSpec, env: AnalysisEnv): Promise<PiLoaded<AnalystState>> {
  const stage = await loadStageData(env, spec.ticker, { findings: false }).catch(() => null);
  return { recipe: analystRecipe(spec, env, stage), input: spec, hydrate: hydrateAnalyst(spec), model: modelFor(env, "analyst"), effort: reasoningFor(env, "analyst"),
    ledger: { kind: "analyst", ticker: spec.ticker, ...(spec.runId ? { runId: spec.runId } : {}) }, reserve: (_state, now) => reserveTurn(env, new Date(now).toISOString()),
    refund: async (_state, reservedAt) => {
      await requireDb(env).prepare("UPDATE feature_budget SET units=max(0,units-1) WHERE day=? AND feature='analyst-turns'")
        .bind(new Date(reservedAt).toISOString().slice(0, 10)).run();
    } };
}

/**
 * Whether a run met a model provider outage rather than a content problem: no researched finding got an answer. A
 * finding is unanswered when it failed, or when none of its turns got a usable reply (each reads as an invalid turn
 * with nothing said). Decided from the settled outcomes, so a replayed instance decides the same way.
 */
function providerOutage(researched: PromiseSettledResult<AnalystOutcome>[]): boolean {
  const unanswered = (r: PromiseSettledResult<AnalystOutcome>) => r.status === "rejected"
    || (!r.value.artifact && r.value.turns.length > 0 && r.value.turns.every(t => t.action === "invalid" && !t.thought));
  return researched.length > 0 && researched.every(unanswered);
}

export async function executeAnalystWorkflow(params: AnalystWorkflowParams, step: WorkflowStepLike, env: AnalysisEnv, deps: AnalystDeps = {}) {
  assertFeatureTicker(env, "findings", params.ticker);
  const modelVersion = modelFor(env, "analyst");
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
  const { verified } = verifyFindingLeads(input.findings, data);
  const categories = [...new Set((await readLinks(db, { ticker: params.ticker }).catch(() => [])).filter(l => (l.status === "verified" || l.status === "confirmed") && l.industryCategory).map(l => l.industryCategory!))];
  const catalogue = seriesCatalogue(input.ledger, data, input.findings.periodEnd);
  const run = deps.run ?? sessionRunner(env, step);
  // Peers by business tags when the tags have paired the company, else by shared category.
  const comparable = comparablePeers(peers, params.ticker)?.filter(c => c.pair.tier !== "adjacent") ?? null;
  const peerTickers = comparable ? comparable.map(c => c.ticker) : peersOf(data, params.ticker);
  const peerUnits = comparable?.map(c => c.unit.unitKey);
  if (!verified.length) {
    await step.do("analyst-empty", () => new D1SecRepository(db).setCache(emptyDossierKey(params.ticker), { fingerprint: params.fingerprint }, now));
    return { status: "empty" as const, findings: [] };
  }
  const cached = await new D1SecRepository(db).getCache<unknown>(dossierCacheKey(params.ticker));
  const parsed = cached ? readDossierPublication(cached.payload, params.ticker) : null;
  // Automatic retries resume a partial dossier. Starting an already complete input again (the admin's
  // regenerate action) must perform fresh research rather than silently republish its existing artifacts.
  const reusable = parsed?.fingerprint === params.fingerprint && parsed.findingsFingerprint === input.findings.fingerprint
    && verified.some(finding => !parsed.artifacts?.[finding.id]) ? parsed : null;
  const byId = new Map<string, AnalystOutcome>();
  for (const finding of verified) {
    const artifact = reusable?.artifacts?.[finding.id];
    if (artifact) byId.set(finding.id, { id: finding.id, tier: planFinding(finding, data, peerTickers).tier, lines: [], artifact, materials: [], turns: [], warnings: [] });
  }
  let providerRetries = 0;
  // Pi keeps each session's state and delivers its authored blocks; repeat only leads still lacking an artifact.
  for (let attempt = 0; ; attempt++) {
    const pending = verified.filter(finding => !byId.get(finding.id)?.artifact);
    if (!pending.length) break;
    const prefix = attempt ? `r${attempt}-` : "";
    const clock = attempt ? await step.do(`analyst-clock-${attempt}`, async () => new Date().toISOString()) : now;
    const settled = await Promise.allSettled(pending.map(finding => runAnalyst({ env, ticker: params.ticker, finding, plan: planFinding(finding, data, peerTickers), data, catalogue, categories, peerUnits, run, findingsFingerprint: input.findings.fingerprint!, operationId: `${deps.runId ?? params.fingerprint.slice(0, 16)}:analyst-${prefix}${finding.id}`, ...(deps.runId ? { runId: deps.runId } : {}), stage: (name, cb) => step.do(`analyst-${prefix}${name}`, cb), now: clock, background: background(finding, previous, data, input.context) })));
    settled.forEach((result, index) => byId.set(pending[index]!.id, result.status === "fulfilled" ? result.value : { id: pending[index]!.id, tier: planFinding(pending[index]!, data, peerTickers).tier, lines: [], artifact: null, materials: [], turns: [], warnings: [`failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] }));
    const settledClock = await step.do(`analyst-settled-clock-${attempt}`, async () => new Date().toISOString());
    const budgetWait = budgetRetryDelay([...byId.values()], settledClock);
    if (budgetWait !== null && deps.sleep) {
      await deps.sleep(`analyst-budget-wait-${attempt + 1}`, budgetWait);
      continue;
    }
    if (providerOutage(settled) && deps.sleep && providerRetries < OUTAGE_WAITS_MS.length) {
      await deps.sleep(`analyst-model-wait-${attempt + 1}`, OUTAGE_WAITS_MS[providerRetries++]!);
      continue;
    }
    break;
  }
  const outcomes = verified.map(finding => byId.get(finding.id)!);
  const { artifacts, materials } = dossierContent(outcomes);
  const trace: AnalystTrace = { version: ANALYST_VERSION, generatedAt: now, findings: outcomes };
  if (!Object.keys(artifacts ?? {}).length) {
    await step.do("analyst-trace", async () => {
      await new AiRunStore(db).saveVersion("analyst", params.ticker, { schemaVersion: "dossier.v1", ticker: params.ticker, findingsFingerprint: input.findings.fingerprint, fingerprint: params.fingerprint, generatedAt: now, model: modelVersion, documents: {}, artifacts: {}, materials: [], analystTrace: trace }, now);
    });
    throw new Error(`analyst: none of ${verified.length} leads produced an authored artifact; retry this input`);
  }
  // The documents are the artifacts now; the dossier record names them for the operator and binds them to the publication.
  const dossier: DossierPublication = { schemaVersion: "dossier.v1", ticker: params.ticker, findingsFingerprint: input.findings.fingerprint!, fingerprint: params.fingerprint, generatedAt: now, model: modelVersion, documents: {}, artifacts, materials };
  if (!readDossierPublication(dossier, params.ticker)) throw new Error("The dossier failed its own contract.");
  await step.do("analyst-publish", async () => {
    const record = { ...dossier, analystTrace: trace };
    await db.batch([
      db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at").bind(dossierCacheKey(params.ticker), JSON.stringify(record), now),
      ...publicationOutboxStatements(db, { type: "dossier.published", ticker: params.ticker }, now),
      db.prepare("DELETE FROM sec_cache WHERE cache_key = ?").bind(emptyDossierKey(params.ticker)),
    ]);
    await new AiRunStore(db).saveVersion("analyst", params.ticker, record, now);
  });
  if (outcomes.some(outcome => !outcome.artifact)) throw new Error(`analyst: ${outcomes.filter(outcome => !outcome.artifact).length} leads still need research; completed artifacts were retained`);
  return { status: "ready" as const, artifacts: Object.keys(artifacts ?? {}).length, findings: outcomes.map(o => ({ id: o.id, tier: o.tier, lines: o.lines, turns: o.turns.length, composed: !!o.artifact, degraded: o.artifact?.degraded.length ?? 0, warnings: o.warnings.length })) };
}
