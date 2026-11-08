import { modelFor, reasoningFor } from "../ai-config.ts";
import type { CheckupNotes, FindingMaterial } from "../../../../shared/analysis-contract/findings.ts";
import { STATEMENT_ANALYSIS_VERSION } from "../../../../shared/analysis-contract/statement-analysis.ts";
import { assessStatements } from "../../../../shared/analysis-runtime/statement-analysis.ts";
import { AiRunStore } from "../ai-runs/store.ts";
import { sha256 } from "../sha256.ts";
import { assertFeatureTicker, requireDb } from "../core.ts";
import { libraryToc } from "../filing-library/tool.ts";
import { findingsInput } from "../findings/workflow.ts";
import type { AnalysisEnv } from "../operations.ts";
import { outboxStatement } from "../pipeline/outbox.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { PiLoaded } from "../pi/host.ts";
import { sessionRunner, type SessionRunner } from "../pi/runs.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import { noteRecipe, runNote, type NoteOutcome, type NoteSpec, type NoteState } from "./agent.ts";
import { checkupCacheKey, emptyCheckupKey, type CheckupRecord } from "./read.ts";

export { checkupCacheKey, emptyCheckupKey, readCheckupRecord } from "./read.ts";

/**
 * Checkup notes: for every metric the report's checkup flags, a written
 * analysis read against the current and the earlier filings. Runs when the flags, the filings in the library or the
 * prompt change; publishes one record per company that the findings read route serves with the findings.
 */
export const CHECKUP_NOTES_VERSION = "checkup.notes.v4";
export type CheckupWorkflowParams = { ticker: string; fingerprint: string };
/** Metrics a run writes about, the most pressing first. */
const MAX_NOTES = 8;
const DEFAULT_DAILY_TURNS = 240;


async function readInput(env: AnalysisEnv, ticker: string) {
  const base = await findingsInput(env, ticker);
  if (!base) return null;
  const db = requireDb(env);
  const assessment = assessStatements(base.data, base.ledger.periodEnd);
  // One note per flagged metric, its rules together; the most pressing metrics first.
  const metrics = [...new Map(assessment.flags.map(f => [f.metricId, f])).keys()].slice(0, MAX_NOTES);
  if (!metrics.length) return null;
  // A foreign issuer reports its quarters in 6-K exhibits; without them its notes could read only the annual report.
  const documents = await libraryToc(db, ticker, { forms: ["10-K", "10-Q", "20-F", "40-F", "6-K"], limit: 5 });
  const fingerprint = await sha256(JSON.stringify({
    version: CHECKUP_NOTES_VERSION, checkup: STATEMENT_ANALYSIS_VERSION, ticker, periodEnd: assessment.periodEnd,
    flags: assessment.flags.filter(f => metrics.includes(f.metricId)).map(f => [f.ruleId, f.metricId, Number(f.value.toPrecision(3)), f.since]),
    documents: documents.map(d => d.documentId).sort(),
  }));
  return { data: base.data, assessment, metrics, documents, fingerprint };
}

export async function checkupFingerprint(env: AnalysisEnv, ticker: string): Promise<string | null> {
  return (await readInput(env, ticker))?.fingerprint ?? null;
}

async function reserveTurn(env: AnalysisEnv): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const cap = Number(env.CHECKUP_DAILY_TURNS) || DEFAULT_DAILY_TURNS;
  const row = await requireDb(env).prepare("INSERT INTO feature_budget (day,feature,units) VALUES (?,?,1) ON CONFLICT(day,feature) DO UPDATE SET units=units+1 WHERE units<? RETURNING units")
    .bind(day, "checkup-turns", cap).first<{ units: number }>().catch(() => null);
  return !!row;
}

/** One metric's note session, rebuilt from its spec; each model call is reserved against the day's allowance. */
export async function checkupLoader(spec: NoteSpec, env: AnalysisEnv): Promise<PiLoaded<NoteState>> {
  return { recipe: noteRecipe(spec, requireDb(env)), input: spec, model: modelFor(env, "analyst"), effort: reasoningFor(env, "analyst"),
    ledger: { kind: "checkup", ticker: spec.ticker, ...(spec.runId ? { runId: spec.runId } : {}) }, reserve: () => reserveTurn(env) };
}

/** Material ids unique across the record: a note's m<n> takes the metric's id as its prefix. */
export function checkupContent(outcomes: NoteOutcome[]): { notes: CheckupNotes["notes"]; materials: FindingMaterial[] } {
  const notes: CheckupNotes["notes"] = [], materials: FindingMaterial[] = [];
  for (const o of outcomes) if (o.note) {
    const id = (m: string) => `c:${o.metricId}:${m}`.slice(0, 40);
    notes.push({ ...o.note, paragraphs: o.note.paragraphs.map(p => ({ ...p, sourceIds: p.sourceIds.map(id) })), quotes: o.note.quotes.map(q => ({ ...q, materialId: id(q.materialId) })) });
    for (const m of o.materials) materials.push({ ...m, id: id(m.id) });
  }
  return { notes, materials };
}

export async function executeCheckupWorkflow(params: CheckupWorkflowParams, step: WorkflowStepLike, env: AnalysisEnv, deps: { run?: SessionRunner; runId?: string } = {}) {
  assertFeatureTicker(env, "findings", params.ticker);
  const modelVersion = modelFor(env, "analyst");
  const now = await step.do("checkup-time", async () => new Date().toISOString());
  const input = await step.do("checkup-input", () => readInput(env, params.ticker));
  if (!input || input.fingerprint !== params.fingerprint) return { status: "superseded" as const };
  const db = requireDb(env);
  const run = deps.run ?? sessionRunner(env, step);
  const metrics = input.assessment.dimensions.flatMap(d => d.metrics);
  const settled = await Promise.allSettled(input.metrics.map(async metricId => {
    const metric = metrics.find(m => m.id === metricId)!;
    return runNote({ ticker: params.ticker, metric, flags: input.assessment.flags.filter(f => f.metricId === metricId), data: input.data, db, run,
      operationId: `${deps.runId ?? params.fingerprint.slice(0, 16)}:checkup-${metricId}`, stage: (name, cb) => step.do(`checkup-${name}`, cb), ...(deps.runId ? { runId: deps.runId } : {}) });
  }));
  // Every metric's run threw: the provider failed (balance, outage), not the content. The run errors and the task retries it,
  // instead of recording an empty checkup the same input would never run again.
  if (settled.length && settled.every(s => s.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;
  // No metric got a usable model reply: the same, with the session's failure recorded as invalid turns.
  if (settled.length && settled.every(s => s.status === "fulfilled" && !s.value.note && s.value.turns.length > 0 && s.value.turns.every(t => t.action === "invalid" && !t.thought))) {
    throw new Error("checkup: no metric got a model answer (provider outage)");
  }
  const outcomes = settled.map((s, i): NoteOutcome => s.status === "fulfilled" ? s.value : { metricId: input.metrics[i]!, note: null, materials: [], turns: [], issues: [`failed: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`] });
  const { notes, materials } = checkupContent(outcomes);
  const trace = outcomes.map(o => ({ metricId: o.metricId, issues: o.issues, turns: o.turns }));
  const record: CheckupRecord = { ticker: params.ticker, periodEnd: input.assessment.periodEnd, generatedAt: now, model: modelVersion, fingerprint: params.fingerprint, notes, materials, trace };
  if (!notes.length) {
    await step.do("checkup-empty", async () => {
      await new AiRunStore(db).saveVersion("checkup", params.ticker, record, now);
      await new D1SecRepository(db).setCache(emptyCheckupKey(params.ticker), { fingerprint: params.fingerprint }, now);
    });
    return { status: "empty" as const, metrics: outcomes.map(o => ({ metricId: o.metricId, turns: o.turns.length, issues: o.issues })) };
  }
  await step.do("checkup-publish", async () => {
    await db.batch([
      db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at").bind(checkupCacheKey(params.ticker), JSON.stringify(record), now),
      outboxStatement(db, { type: "checkup.published", ticker: params.ticker }, now),
      db.prepare("DELETE FROM sec_cache WHERE cache_key = ?").bind(emptyCheckupKey(params.ticker)),
    ]);
    await new AiRunStore(db).saveVersion("checkup", params.ticker, record, now);
  });
  return { status: "ready" as const, notes: notes.length, metrics: outcomes.map(o => ({ metricId: o.metricId, written: !!o.note, turns: o.turns.length, issues: o.issues.length })) };
}
