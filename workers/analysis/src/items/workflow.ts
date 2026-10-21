import type Anthropic from "@anthropic-ai/sdk";
import type { CompanyEvent, EventsPublication } from "../../../../shared/analysis-contract/events.ts";
import type { PublicFilingDigestPage } from "../../../../shared/analysis-contract/filings.ts";
import type { FindingPassage } from "../../../../shared/analysis-contract/findings.ts";
import type { ItemKind } from "../../../../shared/analysis-contract/item-analysis.ts";
import { readEventsPublication } from "../../../../shared/analysis-runtime/events.ts";
import { runAgentLoop, sequential, type LoopHost, type TurnRecord } from "../agent-loop.ts";
import { modelFor, reasoningFor } from "../ai-config.ts";
import { requireDb } from "../core.ts";
import { eventsCacheKey } from "../events/read.ts";
import { libraryToc } from "../filing-library/tool.ts";
import { listLibraryDocuments } from "../filing-library/store.ts";
import { SecModelOutputError } from "../model-stream.ts";
import { callWorkerToolModel, type AnalysisEnv } from "../operations.ts";
import { knownCik } from "../pipeline/identity.ts";
import { outboxStatement } from "../pipeline/outbox.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { FilingBlock } from "../sec/analysis.ts";
import { prepareSecFiling, selectEventBlocks } from "../sec/pipeline.ts";
import { getPublicFilingPage } from "../sec/public-api.ts";
import { loadStageData } from "../stage/data.ts";
import type { AgentMessage, AgentReply } from "../tool-loop.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import { itemOpening, itemPeriodEnd, itemRecipe, itemSubjects, type ItemInput, type ItemSubject } from "./recipe.ts";
import { itemAnalysisKey, itemsIndexKey, type ItemsIndex, type StoredItem } from "./read.ts";

/** Changing the item recipe's prompt, tools or materials writes every row's analysis again (through the fingerprint). */
export const ITEMS_VERSION = "items.v1";
/** Rows analysed at once; each is its own loop of durable steps. */
const CONCURRENCY = 3;

export type ItemsParams = { ticker: string; fingerprint: string };
const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, "0")).join("");
/** The filings a report row groups: the report and the current reports merged into it. */
const accessionsOf = (s: ItemSubject) => s.report ? [s.id, ...s.report.sources.map(x => x.accessionNumber)] : [s.id];

/**
 * The rows that can be analysed now, and what a run would write from: a report waits until the library holds its text,
 * so the library's arrival (`library.prepared`) is what starts its analysis; a current report or a Form 4 is read
 * from its own words and can go at once. Null when no row is due.
 */
export async function itemsPlan(env: AnalysisEnv, ticker: string, now: Date): Promise<{ subjects: ItemSubject[]; fingerprint: string } | null> {
  const db = requireDb(env);
  const repository = new D1SecRepository(db);
  const [page, stored, ready] = await Promise.all([
    getPublicFilingPage(repository, ticker, null, "50").catch(() => null) as Promise<PublicFilingDigestPage | null>,
    repository.getCache<unknown>(eventsCacheKey(ticker)),
    db.prepare("SELECT DISTINCT accession_number a FROM sec_documents WHERE ticker = ? AND status = 'ready'").bind(ticker).all<{ a: string }>().then(r => new Set(r.results.map(x => x.a))),
  ]);
  const events = stored ? readEventsPublication(stored.payload, ticker) : null;
  const subjects = itemSubjects(page, events, now).filter(s => s.kind !== "report" || accessionsOf(s).some(a => ready.has(a)));
  if (!subjects.length) return null;
  return { subjects, fingerprint: await sha256(JSON.stringify({ version: ITEMS_VERSION, items: subjects.map(s => s.id) })) };
}

/** The fingerprint a run would write now, compared with the published index by the task. */
export const itemsFingerprint = async (env: AnalysisEnv, ticker: string) => (await itemsPlan(env, ticker, new Date()))?.fingerprint ?? null;

/** A current report's blocks as passages: the same blocks its summary was written from, exhibits first. */
function blockPassages(ticker: string, event: CompanyEvent, blocks: FilingBlock[]): FindingPassage[] {
  return selectEventBlocks(blocks, 10).map(b => {
    const type = b.exhibitType?.toUpperCase();
    const exhibit = type ? event.exhibits.find(x => x.type === type) : undefined;
    return { passageId: `${event.id}:${b.blockId}`, documentId: event.id, title: `${ticker} ${event.form} ${event.filedAt}`, form: b.exhibitType ?? event.form, filedAt: event.filedAt,
      url: exhibit?.url ?? event.documentUrl, path: [b.headingPath || b.heading || (b.exhibitType ?? event.form)], text: b.body.slice(0, 3000), table: null };
  });
}

/**
 * What a row's analysis starts from: the library's documents of the filing and whether it holds the one before, and the
 * filing's own words when the library does not hold them — a current report's text as the SEC report step prepared it
 * (read again from EDGAR when it is gone), a Form 4's footnotes.
 */
async function prepareItem(env: AnalysisEnv, ticker: string, subject: ItemSubject): Promise<Pick<ItemInput, "documents" | "earlierAvailable" | "seed">> {
  const db = requireDb(env);
  const accessions = accessionsOf(subject);
  const [documents, rows] = await Promise.all([
    libraryToc(db, ticker, { accessions, limit: 6 }).catch(() => []),
    listLibraryDocuments(db, { ticker, accessions, limit: 6 }).catch(() => []),
  ]);
  const earlierAvailable = rows.some(d => d.status === "ready" && d.previousDocumentId);
  const event = subject.event;
  if (subject.kind === "insider" && event?.insider) {
    const notes = event.insider.footnotes;
    const seed: FindingPassage[] = notes.length ? [{ passageId: `${event.id}:footnotes`, documentId: event.id, title: `${ticker} Form ${event.form} ${event.filedAt}`, form: event.form, filedAt: event.filedAt, url: event.documentUrl, path: ["Footnotes"], text: notes.map((n, i) => `(${i + 1}) ${n}`).join("\n").slice(0, 4000), table: null }] : [];
    return { documents: [], earlierAvailable: false, seed };
  }
  if (subject.kind !== "current" || !event || documents.length) return { documents, earlierAvailable, seed: [] };
  const prepared = await env.SEC_FILINGS.get(`filings/${ticker}/${event.id}/text.json`).then(async o => o ? JSON.parse(await o.text()) as { blocks: FilingBlock[] } : null).catch(() => null);
  let blocks = prepared?.blocks ?? null;
  if (!blocks?.length) {
    const cik = await knownCik(db, ticker);
    if (cik) {
      const archive = event.documentUrl.slice(0, event.documentUrl.lastIndexOf("/"));
      blocks = await prepareSecFiling({ ticker, cik, cikNumber: Number(cik), companyName: ticker, form: event.form, filingDate: event.filedAt, reportDate: event.eventDate, accessionNumber: event.id,
        primaryDocument: event.documentUrl.slice(event.documentUrl.lastIndexOf("/") + 1), description: event.description, items: event.items.join(","), documentUrl: event.documentUrl, indexUrl: `${archive}/${event.id}-index.htm` },
      { userAgent: env.SEC_USER_AGENT }).then(p => p.blocks).catch(() => null);
    }
  }
  return { documents, earlierAvailable, seed: blocks?.length ? blockPassages(ticker, event, blocks) : [] };
}

type ItemOutcome = { id: string; kind: ItemKind; written: boolean; reason: string; turns: number };

/**
 * One company's run: every due row without an analysis at this version gets one, written by the item recipe on the
 * shared loop with every model turn and outside read a durable step; each analysis is stored as soon as it is written,
 * and the index and its event commit last, so the map's revision moves once per run.
 */
export async function executeItemsWorkflow(params: ItemsParams, step: WorkflowStepLike, env: AnalysisEnv, runId: string): Promise<Record<string, unknown>> {
  const { ticker } = params;
  const db = requireDb(env);
  const now = await step.do("items-time", async () => new Date().toISOString());
  const plan = await step.do("items-plan", () => itemsPlan(env, ticker, new Date(now)));
  if (!plan) return { status: "empty" };
  const written = await step.do("items-written", async () => {
    const keys = plan.subjects.map(s => itemAnalysisKey(ticker, s.id));
    const rows = (await db.prepare("SELECT cache_key k, json_extract(payload, '$.version') v FROM sec_cache WHERE cache_key IN (SELECT value FROM json_each(?))").bind(JSON.stringify(keys)).all<{ k: string; v: string | null }>()).results;
    return rows.filter(r => r.v === ITEMS_VERSION).map(r => r.k);
  });
  const pending = plan.subjects.filter(s => !written.includes(itemAnalysisKey(ticker, s.id)));
  const data = pending.length ? await loadStageData(env, ticker) : null;
  const outcomes: ItemOutcome[] = [];
  if (data) {
    // Form 4 figures are cited through `{ event }` refs, which the verifier resolves from the events publication.
    const events = await new D1SecRepository(db).getCache<unknown>(eventsCacheKey(ticker)).then(s => s ? readEventsPublication(s.payload, ticker) : null) as EventsPublication | null;
    const facts = { ...data, data: { ...data.data, events } };
    const act = (stage: string, system: string, tools: unknown[], messages: AgentMessage[]): Promise<AgentReply> => step.do(`${stage}-act`, async () => {
      try {
        return await callWorkerToolModel(env, fetch, stage, { system, tools: tools as Anthropic.Beta.BetaTool[], messages: messages as Anthropic.Beta.BetaMessageParam[] }, modelFor(env, "items"), 4 * 60_000,
          { reasoning: reasoningFor(env, "items"), ticker, kind: "items", runId });
      } catch (error) {
        if (error instanceof SecModelOutputError) return { error: `${error.code}: ${error.message}`.slice(0, 300) };
        throw error;
      }
    });
    const writeItem = async (subject: ItemSubject): Promise<ItemOutcome> => {
      const prepared = await step.do(`item-${subject.id}-prepare`, () => prepareItem(env, ticker, subject));
      const input: ItemInput = { env, data: facts, subject, periodEnd: itemPeriodEnd(subject, facts), now, ...prepared };
      const recipe = itemRecipe(input);
      const state = recipe.open(input);
      const messages: AgentMessage[] = [{ role: "user", content: itemOpening(input, state) }];
      const turns: TurnRecord[] = [];
      const host: LoopHost<typeof state> = {
        reserve: async () => true, record: turn => { turns.push(turn); }, execute: (_t, calls, run) => sequential(calls, run),
        stage: (name, work) => step.do(name, work), signal: new AbortController().signal, now: () => Date.parse(now),
      };
      const outcome = await runAgentLoop(recipe, input, state, messages, act, host);
      const composed = outcome.output;
      if (composed) await step.do(`item-${subject.id}-save`, async () => {
        const record: StoredItem = { schemaVersion: "item-analysis.v1", ticker, itemId: subject.id, itemKind: subject.kind, periodEnd: input.periodEnd, generatedAt: now, version: ITEMS_VERSION, ...composed, trace: turns };
        await new D1SecRepository(db).setCache(itemAnalysisKey(ticker, subject.id), record, now);
        return true;
      });
      return { id: subject.id, kind: subject.kind, written: !!composed, reason: `${outcome.reason}:${outcome.turns}`, turns: turns.length };
    };
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const batch = pending.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(writeItem));
      settled.forEach((r, j) => outcomes.push(r.status === "fulfilled" ? r.value : { id: batch[j]!.id, kind: batch[j]!.kind, written: false, reason: `failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`.slice(0, 300), turns: 0 }));
    }
  }
  // The index takes this run's fingerprint whatever each row came to, so the same rows are not run again until they change;
  // a row whose loop wrote nothing keeps the filing digest on the page.
  await step.do("items-publish", async () => {
    const index: ItemsIndex = { version: ITEMS_VERSION, fingerprint: params.fingerprint, generatedAt: now, items: plan.subjects.map(s => ({ id: s.id, kind: s.kind, written: written.includes(itemAnalysisKey(ticker, s.id)) || !!outcomes.find(o => o.id === s.id)?.written })) };
    await db.batch([
      db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
        .bind(itemsIndexKey(ticker), JSON.stringify(index), now),
      outboxStatement(db, { type: "items.published", ticker }, now),
    ]);
    return true;
  });
  return { status: "ready", due: plan.subjects.length, written: outcomes.filter(o => o.written).length, failed: outcomes.filter(o => !o.written).map(o => `${o.id}:${o.reason}`), kept: written.length };
}

