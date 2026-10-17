import { aiIsEnabled } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import { reasoningFor } from "../ai-config.ts";
import { readArchivedDocument } from "../financial-data/disclosure-audit.ts";
import { readReportedFacts } from "../financial-data/parser.ts";
import { degraded, judgementStatement, judgeStructure, presentationProfile, type JudgeModel } from "../financial-data/presentation.ts";
import { readFilingDocuments, throttledSecReader } from "../financial-data/provider.ts";
import { readCompletePublicationForTicker } from "../financial-data/publication.ts";
import { SecModelOutputError } from "../model-stream.ts";
import { callWorkerSecModel, type SecPipelineEnv } from "../operations.ts";
import { knownCik } from "./identity.ts";
import { flushOutbox, outboxStatement } from "./outbox.ts";
import type { TaskImplementation, TaskOutcome } from "./tasks.ts";

/** Changing the judge's prompt or checks judges every degraded issuer once more. */
export const PRESENTATION_VERSION = "presentation.v1";
/** Model calls per UTC day across all issuers; a cap, not a target. */
const DEFAULT_DAILY_CALLS = 60;
const MODEL_BUDGET_MS = 3 * 60_000;

async function reserveCall(env: SecPipelineEnv, now: Date): Promise<boolean> {
  const cap = Number(env.PRESENTATION_DAILY_CALLS) || DEFAULT_DAILY_CALLS;
  const row = await env.DB!.prepare("INSERT INTO feature_budget (day,feature,units) VALUES (?,?,1) ON CONFLICT(day,feature) DO UPDATE SET units=units+1 WHERE units<? RETURNING units")
    .bind(now.toISOString().slice(0, 10), "presentation-calls", cap).first<{ units: number }>().catch(() => null);
  return !!row;
}

/**
 * Judges the income statement of an issuer whose newest published quarter shows the lines after operating income as one
 * derived total (presentation.ts). An accepted structure is kept and the issuer is collected again through an admin
 * maintenance task, so the corrected publication follows without anyone acting; the maintenance task never asks for a
 * judgement itself, which keeps the event graph free of loops. A filing judged once is not judged again under the same
 * judge version. A company new to the pipeline (`company.added`) is checked once its first publication is out: its
 * first collection runs through a maintenance task, which does not ask. A provider outage is not a judgement: the run
 * comes back in an hour and records nothing.
 */
export const PRESENTATION_TASKS = {
  presentation: {
    version: PRESENTATION_VERSION,
    async run(env, ticker, { now }): Promise<TaskOutcome> {
      const db = env.DB!;
      if (!aiIsEnabled(env)) return { status: "done", detail: { skipped: "AI disabled" } };
      const publication = await readCompletePublicationForTicker(db, ticker).catch(() => null);
      if (!publication?.flow) {
        // Nothing published yet: while a collection or maintenance task is still preparing the first one, look again later.
        const preparing = await db.prepare(`SELECT 1 FROM financial_collection_jobs WHERE ticker = ? AND status IN ('queued','retry','running')
          UNION ALL SELECT 1 FROM financial_maintenance_tasks WHERE ticker = ? AND status IN ('queued','running') LIMIT 1`).bind(ticker, ticker).first();
        return preparing ? { status: "later", afterMs: 30 * 60_000, detail: { waiting: "first publication" } } : { status: "done", detail: { skipped: "nothing published" } };
      }
      const newest = [...publication.flow.quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
      if (!degraded(newest)) return { status: "done", detail: { skipped: "the newest quarter balances" } };
      const line = newest!.figures.net?.lineage?.[0];
      const cik = await knownCik(db, ticker);
      if (!line || !cik) return { status: "done", detail: { skipped: "no source filing" } };
      const profile = await presentationProfile(db, cik);
      if (profile?.accession === line.accession && profile.judge_version === PRESENTATION_VERSION) return { status: "done", detail: { skipped: "this filing was judged", status: profile.status } };
      const archive = { DB: db, SEC_FILINGS: env.SEC_FILINGS };
      const reader = throttledSecReader(env.SEC_USER_AGENT, fetch, 1000);
      reader.archived = url => readArchivedDocument(archive, ticker, url);
      const [document] = await readFilingDocuments(line.url, reader, line.accession);
      const source = newest!.sources.find(s => s.id === line.accession);
      const { facts } = readReportedFacts(document.html, { url: line.url, accession: line.accession, filedAt: source?.publishedAt ?? newest!.reportedAt ?? "", cik, industry: "standard" });
      const modelVersion = env.SEC_REASONING_MODEL || env.SEC_ANALYSIS_MODEL || "deepseek-flash";
      const model: JudgeModel = async (stage, system, payload) => {
        try { return await callWorkerSecModel(env, fetch, stage, system, payload, modelVersion, MODEL_BUDGET_MS, true, { reasoning: reasoningFor(env, "presentation"), ticker, kind: "presentation" }); }
        catch (error) { if (error instanceof SecModelOutputError) return {}; throw error; }
      };
      let judgement: Awaited<ReturnType<typeof judgeStructure>>;
      try { judgement = await judgeStructure(facts, { ticker, form: "10-Q/10-K", accession: line.accession, reportDate: newest!.periodEnd }, model, 4, () => reserveCall(env, now)); }
      catch (error) { return { status: "later", afterMs: 60 * 60_000, detail: { waiting: "model unavailable", error: error instanceof Error ? error.message.slice(0, 200) : String(error) } }; }
      if (judgement.issues.includes("daily model budget spent") && !judgement.structure) {
        const tomorrow = new Date(now); tomorrow.setUTCHours(24, 5, 0, 0);
        return { status: "later", afterMs: tomorrow.getTime() - now.getTime(), detail: { waiting: "daily model budget" } };
      }
      // The judgement, the re-collection it asks for and that request's event commit together.
      const requestId = `presentation-${cik}-${line.accession}`, stamp = now.toISOString();
      await db.batch([
        judgementStatement(db, { cik, ticker, accession: line.accession }, judgement, now, PRESENTATION_VERSION),
        ...(judgement.structure ? [
          db.prepare(`INSERT INTO financial_maintenance_tasks (task_id,request_id,ticker,action,status,total_steps,next_attempt_at,created_at,updated_at)
            VALUES (?,?,?,'extract','queued',4,?,?,?) ON CONFLICT DO NOTHING`).bind(requestId, requestId, ticker, stamp, stamp, stamp),
          outboxStatement(db, { type: "maintenance.requested", ticker, cik }, stamp),
        ] : []),
      ]);
      if (judgement.structure) await flushOutbox(env).catch(() => undefined);
      return { status: "done", detail: { verified: !!judgement.structure, attempts: judgement.attempts, issues: judgement.issues.slice(0, 5) } };
    },
  },
} satisfies Record<string, TaskImplementation>;
