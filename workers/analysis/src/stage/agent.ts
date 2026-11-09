import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import { withRuns } from "../durable-runs/binding.ts";
import { DEFAULT_SCENE_ROWS, type NoticeCode, type SceneDocument, type SceneRow } from "../../../../shared/analysis-contract/scene.ts";
import type { Locale } from "../../../../shared/analysis-runtime/locale.ts";
import { PiHost, type PiLoaded } from "../pi/host.ts";
import { piModelIds } from "../pi/model.ts";
import { modelFor, reasoningFor } from "../ai-config.ts";
import { companyPolicyEnvironment } from "../financial-data/company-policy.ts";
import type { AnalysisEnv } from "../operations.ts";
import type { ToolCall } from "../tool-loop.ts";
import { refund, reserve, type Spender } from "./budget.ts";
import { loadStageData } from "./data.ts";
import { sha256 } from "../sha256.ts";
import { STAGE_BUDGET, stageRecipeFor, type StageOutcome, type StageTurn, type StageView } from "./recipe.ts";

/**
 * One reader's conversation with the stage, an Agents SDK Agent and so a Durable
 * Object of its own. Its synced state is only the scene on the stage; the turn in progress, its draft and the
 * transcript go out as messages, so a status change never rebuilds the page. The full exchange the model sees is kept
 * in the object's own SQLite and only grows, so each turn reuses the prompt cache.
 */
export type StageState = { scene: SceneDocument; revision: number; applied: number; contentLanguage: Locale };
/** The Agents SDK types its environment as the generated `Env`; the stage reads the analysis environment on top of it. */
export type StageEnv = Env & AnalysisEnv;
export type StageProps = { userId: string; ticker: string; locale: Locale };

export type TranscriptEntry =
  | { id: string; at: string; role: "user"; text: string }
  | { id: string; at: string; role: "assistant"; kind: "answer"; paragraphs: Array<{ text: string; sourceIds: string[] }>; contentLanguage: Locale }
  | { id: string; at: string; role: "assistant"; kind: "stage"; revision: number }
  | { id: string; at: string; role: "assistant"; kind: "notice"; code: NoticeCode }
  /** A report the turn proposes; the reader confirms or declines it. */
  | { id: string; at: string; role: "assistant"; kind: "question"; questionId: string; question: string; settled?: "yes" | "no" };
export type TurnPhase = "thinking" | "answering" | "staging";
/** What the page receives besides the synced state. */
export type StageEvent =
  | { type: "stage:turn"; turn: { id: string; phase: TurnPhase; status: { tool: string; arg?: string } | null } | null }
  | { type: "stage:draft"; rows: SceneRow[] | null }
  | { type: "stage:transcript"; entries: TranscriptEntry[]; replace?: boolean };
/** What the page sends. */
export type StageCommand =
  | { type: "say"; text: string }
  | { type: "applied"; revision: number }
  | { type: "observe"; view: StageView }
  | { type: "cancel" }
  | { type: "answer"; questionId: string; value: "yes" | "no" }
  | { type: "delete" };

type Owner = { user_id: string; ticker: string; locale: string };
const TRANSCRIPT_SENT = 40;
/** Tool results the exchange keeps before it is folded into a summary at the next turn's start. */
/** Every turn of a conversation runs on its root Pi session. */
const STAGE_SESSION = "1";
/** What a turn's session is rebuilt from after an eviction; the stage's data is read again. */
type StageSpec = { turnId: string; address: string | null; userHash: string };
/** What a turn needs to land its result, kept with the turn so a turn Pi resumed after an eviction can land it too. */
type TurnContext = { before: number; address: string | null; startedAt: string; basis: SceneDocument["basis"] };
const MAX_TEXT = 600;

const emptyScene = (): SceneDocument => ({ schemaVersion: "scene.v1", scope: { periodEnd: "" }, basis: {}, rows: DEFAULT_SCENE_ROWS.map(r => ({ ...r })) });
const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

export class StageAgent extends Agent<StageEnv, StageState> {
  initialState: StageState = { scene: emptyScene(), revision: 0, applied: 0, contentLanguage: "en" };
  private running: AbortController | null = null;
  private view: StageView | null = null;
  private readonly completions = new Map<string, Promise<void>>();
  /** Which allowance ran out in a turn, for its notice. */
  private readonly capHits = new Map<string, "reader" | "address" | "global">();
  /** The conversation's model exchange: one Pi session, kept, checkpointed and compacted by Pi. */
  private readonly pi = new PiHost({ sql: this.ctx.storage.sql, env: this.env }, { stage: spec => this.loadStage(spec as StageSpec) }, {
    models: () => piModelIds(this.env as StageEnv),
    onSettled: operationId => { void this.completeTurn(operationId); },
    scheduleTraceFlush: () => this.schedule(new Date(Date.now() + 1000), "flushPiTraces"),
  });

  /** Scheduled after a turn ends: an invocation of its own, whose trace is live, writes the turns' spans. */
  flushPiTraces() { this.pi.flushTraces(); }
  private readonly piInstalled = this.lifecycle.use(this.pi.harness);

  async onStart(props?: StageProps): Promise<void> {
    void this.sql`CREATE TABLE IF NOT EXISTS owner (user_id TEXT NOT NULL, ticker TEXT NOT NULL, locale TEXT NOT NULL)`;
    // The exchange lived here before Pi kept it; an older object's table is dropped.
    void this.sql`DROP TABLE IF EXISTS messages`;
    void this.sql`CREATE TABLE IF NOT EXISTS transcript (seq INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)`;
    void this.sql`CREATE TABLE IF NOT EXISTS scenes (revision INTEGER PRIMARY KEY, at TEXT NOT NULL, by TEXT NOT NULL, scene TEXT NOT NULL)`;
    void this.sql`CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, turn TEXT NOT NULL, entry TEXT NOT NULL)`;
    void this.sql`CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, at TEXT NOT NULL, status TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0)`;
    void this.sql`CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, question TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open')`;
    if (props && !this.owner()) void this.sql`INSERT INTO owner (user_id, ticker, locale) VALUES (${props.userId}, ${props.ticker}, ${props.locale})`;
    try { void this.sql`ALTER TABLE turns ADD COLUMN context TEXT`; } catch { /* Present already. */ }
    // A turn the object was evicted in the middle of goes on: Pi resumes its session, and the turn settles when it ends.
    // One that never reached Pi (no context) is marked interrupted.
    for (const t of this.sql<{ id: string; context: string | null }>`SELECT id, context FROM turns WHERE status = 'running'`) {
      if (t.context) { this.resume(t.id); continue; }
      void this.sql`UPDATE turns SET status = 'interrupted' WHERE id = ${t.id}`;
      this.addTranscript({ id: uid(), at: new Date().toISOString(), role: "assistant", kind: "notice", code: "turn-interrupted" });
    }
  }

  private owner(): Owner | null { return this.sql<Owner>`SELECT user_id, ticker, locale FROM owner LIMIT 1`[0] ?? null; }

  /** A connection carries its reader and hashed address from the gateway; only the owner may connect. */
  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const owner = this.owner();
    const reader = ctx.request.headers.get("x-spontra-reader");
    if (!owner || reader !== owner.user_id) { connection.close(4403, "forbidden"); return; }
    connection.setState({ address: ctx.request.headers.get("x-spontra-address") });
    const entries = this.sql<{ entry: string }>`SELECT entry FROM transcript ORDER BY seq DESC LIMIT ${TRANSCRIPT_SENT}`.map(r => JSON.parse(r.entry) as TranscriptEntry).reverse();
    this.sendTo(connection, { type: "stage:transcript", entries, replace: true });
    if (this.running) this.sendTo(connection, { type: "stage:turn", turn: { id: "current", phase: "thinking", status: null } });
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== "string") return;
    let command: StageCommand;
    try { command = JSON.parse(message) as StageCommand; } catch { return; }
    const address = (connection.state as { address?: string | null } | null)?.address ?? null;
    switch (command.type) {
      case "say": if (typeof command.text === "string" && command.text.trim()) await this.keepAliveWhile(() => this.turn(command.text.trim().slice(0, MAX_TEXT), address)); return;
      case "applied": if (Number.isInteger(command.revision) && command.revision > this.state.applied && command.revision <= this.state.revision) this.setState({ ...this.state, applied: command.revision }); return;
      case "observe": this.view = command.view; return;
      case "cancel": this.running?.abort(); return;
      case "answer": if (typeof command.questionId === "string") await this.settleQuestion(command.questionId, command.value === "yes", address); return;
      case "delete": await this.purge(); return;
    }
  }

  private sendTo(connection: Connection, event: StageEvent) { connection.send(JSON.stringify(event)); }
  private emit(event: StageEvent) { this.broadcast(JSON.stringify(event)); }
  private addTranscript(entry: TranscriptEntry) {
    void this.sql`INSERT INTO transcript (entry) VALUES (${JSON.stringify(entry)})`;
    this.emit({ type: "stage:transcript", entries: [entry] });
  }
  private notice(code: NoticeCode) { this.addTranscript({ id: uid(), at: new Date().toISOString(), role: "assistant", kind: "notice", code }); }

  /** The only way the scene changes: a new revision on top of the one the change was made against. */
  private commit(rows: SceneRow[], scope: SceneDocument["scope"], basis: SceneDocument["basis"], by: string, expectedRevision: number): boolean {
    if (this.state.revision !== expectedRevision) return false;
    const revision = expectedRevision + 1;
    const scene: SceneDocument = { schemaVersion: "scene.v1", scope, basis, rows };
    void this.sql`INSERT INTO scenes (revision, at, by, scene) VALUES (${revision}, ${new Date().toISOString()}, ${by}, ${JSON.stringify(scene)})`;
    this.setState({ ...this.state, scene, revision });
    return true;
  }

  private async turn(text: string, address: string | null): Promise<void> {
    const owner = this.owner();
    if (!owner) return;
    if (this.running) return;
    // A turn Pi resumed after an eviction still holds the conversation's session; a new one waits for it to settle.
    if (this.completions.size) return;
    const env = await companyPolicyEnvironment(this.env as StageEnv);
    const locale: Locale = owner.locale === "zh-CN" ? "zh-CN" : "en";
    const turnId = uid();
    const userHash = await sha256(owner.user_id);
    const who: Spender = { reader: owner.user_id, address };
    const db = env.DB!;
    this.addTranscript({ id: uid(), at: new Date().toISOString(), role: "user", text });
    const says = await reserve(db, "stage-says", who).catch(() => ({ ok: false as const, which: "global" as const }));
    if (!says.ok) { this.notice(says.which === "global" ? "global-cap-reached" : "quota-reached"); return; }
    const controller = new AbortController();
    this.running = controller;
    const startedAt = new Date().toISOString();
    void this.sql`INSERT INTO turns (id, at, status) VALUES (${turnId}, ${startedAt}, 'running')`;
    this.emit({ type: "stage:turn", turn: { id: turnId, phase: "thinking", status: null } });
    try {
      const data = await loadStageData(env, owner.ticker);
      if (!data) throw new Error("stage data unavailable");
      const context: TurnContext = { before: this.state.revision, address, startedAt, basis: data.basis };
      void this.sql`UPDATE turns SET context = ${JSON.stringify(context)} WHERE id = ${turnId}`;
      // The conversation is one Pi session; each turn is one run on it, and Pi compacts it when it grows too long.
      const opening = JSON.stringify({ request: text, view: this.view, stage: this.state.scene.rows.map(r => ({ title: r.title, cells: r.cells.map(c => c.map(b => b.kind)) })), budget: { turns: STAGE_BUDGET.turns } });
      const spec: StageSpec = { turnId, address, userHash };
      const started = await this.pi.start("stage", spec, opening, { operationId: turnId, session: STAGE_SESSION });
      if (started.refused && !this.capHits.has(turnId)) this.capHits.set(turnId, "reader");
      else controller.signal.addEventListener("abort", () => void this.pi.abort(turnId));
      await this.completeTurn(turnId, started.refused ? "capped" : undefined);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      console.error(JSON.stringify({ event: "stage-turn", outcome: "error", conversation: this.name, error: message }));
      if (this.sql<{ status: string }>`SELECT status FROM turns WHERE id = ${turnId}`[0]?.status === "running") {
        void this.sql`UPDATE turns SET status = 'failed' WHERE id = ${turnId}`;
        this.notice("turn-failed");
        await this.closeTurn(turnId, { status: "failed", calls: 0, reason: null, firstError: message, startedAt, who });
      }
    } finally {
      if (this.running === controller) this.running = null;
    }
  }

  /** A turn Pi resumed after an eviction: it holds the stage as a running turn does, and the reader can cancel it. */
  private resume(turnId: string) {
    const controller = new AbortController();
    this.running = controller;
    controller.signal.addEventListener("abort", () => void this.pi.abort(turnId));
    void this.completeTurn(turnId).finally(() => { if (this.running === controller) this.running = null; });
  }

  /** One turn's session settled: its result goes on the stage. Runs once per turn, also for a turn Pi resumed after an eviction. */
  private completeTurn(turnId: string, refused?: "capped"): Promise<void> {
    const pending = this.completions.get(turnId);
    if (pending) return pending;
    const work = this.settleTurn(turnId, refused).finally(() => this.completions.delete(turnId));
    this.completions.set(turnId, work);
    return work;
  }

  private async settleTurn(turnId: string, refused?: "capped"): Promise<void> {
    const row = this.sql<{ status: string; context: string | null }>`SELECT status, context FROM turns WHERE id = ${turnId}`[0];
    const owner = this.owner();
    if (!row || row.status !== "running" || !owner || !row.context) return;
    const context = JSON.parse(row.context) as TurnContext;
    const locale: Locale = owner.locale === "zh-CN" ? "zh-CN" : "en";
    const who: Spender = { reader: owner.user_id, address: context.address };
    let status = "failed", reason: string | null = null, calls = 0, firstError: string | null = null;
    try {
      if (refused) { this.notice(this.capHits.get(turnId) === "global" ? "global-cap-reached" : "quota-reached"); status = "capped"; return; }
      const outcome = await this.pi.finish<StageOutcome>(turnId);
      calls = outcome.turns;
      firstError = outcome.trail.find(e => e.action === "invalid")?.observation.slice(0, 500) ?? null;
      // A report the turn proposed stops the run before it runs; the reader decides.
      const result: StageOutcome = outcome.asked ? { kind: "report", question: outcome.asked } : outcome.output;
      reason = `${outcome.reason}:${result.kind}:${outcome.turns}`;
      if (result.kind === "scene") {
        // A report that finished during the turn keeps its place: its block joins the turn's scene.
        const kept = this.state.revision === context.before ? [] : this.state.scene.rows.filter(r => r.cells.flat().some(b => b.kind === "report" || b.kind === "progress"));
        const committed = this.commit([...kept, ...result.rows].slice(0, 8), { periodEnd: result.periodEnd, ...(result.findingId ? { findingId: result.findingId } : {}) }, context.basis, "finish", this.state.revision);
        if (committed) this.addTranscript({ id: uid(), at: new Date().toISOString(), role: "assistant", kind: "stage", revision: this.state.revision });
        status = "done";
      } else if (result.kind === "report") {
        const questionId = uid();
        void this.sql`INSERT INTO questions (id, question) VALUES (${questionId}, ${result.question})`;
        this.addTranscript({ id: uid(), at: new Date().toISOString(), role: "assistant", kind: "question", questionId, question: result.question });
        status = "asked";
      } else if (result.kind === "answer") {
        this.addTranscript({ id: uid(), at: new Date().toISOString(), role: "assistant", kind: "answer", paragraphs: result.paragraphs, contentLanguage: locale });
        status = "done";
      } else if (outcome.capped) {
        const which = this.capHits.get(turnId);
        this.notice(which === "global" ? "global-cap-reached" : "quota-reached");
        status = "capped";
      } else {
        this.notice(outcome.reason === "cancelled" ? "turn-interrupted" : "turn-failed");
        status = outcome.reason;
      }
    } catch (error) {
      firstError ??= (error instanceof Error ? error.message : String(error)).slice(0, 500);
      console.error(JSON.stringify({ event: "stage-turn", outcome: "error", conversation: this.name, error: firstError }));
      this.notice("turn-failed");
    } finally {
      this.capHits.delete(turnId);
      await this.closeTurn(turnId, { status, calls, reason, firstError, startedAt: context.startedAt, who });
    }
  }

  private async closeTurn(turnId: string, end: { status: string; calls: number; reason: string | null; firstError: string | null; startedAt: string; who: Spender }): Promise<void> {
    const owner = this.owner();
    const db = this.env.DB;
    void this.sql`UPDATE turns SET status = ${end.status}, calls = ${end.calls} WHERE id = ${turnId}`;
    this.emit({ type: "stage:draft", rows: null });
    this.emit({ type: "stage:turn", turn: null });
    if (!db || !owner) return;
    // A turn that spent nothing on the model gives its say back.
    if (end.calls === 0) await refund(db, "stage-says", end.who, 1).catch(() => {});
    await db.prepare("UPDATE stage_conversations SET last_at = ?, turns = turns + 1 WHERE id = ?").bind(new Date().toISOString(), this.name).run().catch(() => {});
    // The turn's record for the operator: how it ended and the first model failure, never the reader's words.
    await db.prepare("INSERT OR IGNORE INTO user_runs (user_id, id, kind, ticker, conversation_id, business_key, status, started_at, finished_at, result, error) VALUES (?, ?, 'stage-turn', ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(owner.user_id, turnId, owner.ticker, this.name, turnId, end.status, end.startedAt, new Date().toISOString(), JSON.stringify({ calls: end.calls, reason: end.reason }), end.firstError).run().catch(() => {});
  }

  /** What a stage turn's Pi session is rebuilt from: the stage's data and tools, its allowance, its trail and its events. */
  private async loadStage(spec: StageSpec): Promise<PiLoaded<StageTurn>> {
    const owner = this.owner();
    if (!owner) throw new Error("stage: no owner");
    const env = await companyPolicyEnvironment(this.env as StageEnv);
    const data = await loadStageData(env, owner.ticker);
    if (!data) throw new Error("stage data unavailable");
    const locale: Locale = owner.locale === "zh-CN" ? "zh-CN" : "en";
    const input = { data, locale, scene: this.state.scene.rows, view: this.view };
    const who: Spender = { reader: owner.user_id, address: spec.address };
    return {
      recipe: stageRecipeFor(input), input,
      hydrate: state => { state.onDraft = rows => this.emit({ type: "stage:draft", rows }); },
      model: modelFor(env, "stage"), effort: reasoningFor(env, "stage"),
      ledger: { kind: "stage", ticker: owner.ticker, runId: spec.turnId, userHash: spec.userHash, conversationId: this.name },
      reserve: async (_state, now) => {
        const r = await reserve(env.DB!, "stage-calls", who, 1, now).catch(() => ({ ok: false as const, which: "global" as const }));
        if (!r.ok) this.capHits.set(spec.turnId, r.which);
        return r.ok;
      },
      refund: (_state, reservedAt) => refund(env.DB!, "stage-calls", who, 1, reservedAt),
      record: entry => { void this.sql`INSERT INTO log (at, turn, entry) VALUES (${new Date().toISOString()}, ${spec.turnId}, ${JSON.stringify(entry)})`; },
      onToolStart: (name, args) => {
        const call = { type: "tool_use", id: "", name, input: args } as ToolCall;
        this.emit({ type: "stage:turn", turn: { id: spec.turnId, phase: this.phaseOf(name), status: { tool: name, ...(argOf(call) ? { arg: argOf(call) } : {}) } } });
      },
    };
  }

  /** The reader confirmed or declined a proposed report; a confirmed one starts its Workflow under a key that repeats for the same question the same day. */
  private async settleQuestion(questionId: string, yes: boolean, address: string | null): Promise<void> {
    const owner = this.owner();
    const row = this.sql<{ question: string; status: string }>`SELECT question, status FROM questions WHERE id = ${questionId}`[0];
    if (!owner || !row || row.status !== "open") return;
    void this.sql`UPDATE questions SET status = ${yes ? "yes" : "no"} WHERE id = ${questionId}`;
    const entries = this.sql<{ seq: number; entry: string }>`SELECT seq, entry FROM transcript ORDER BY seq DESC LIMIT 40`;
    for (const e of entries) {
      const entry = JSON.parse(e.entry) as TranscriptEntry;
      if (entry.role === "assistant" && entry.kind === "question" && entry.questionId === questionId) {
        const settled = { ...entry, settled: yes ? "yes" as const : "no" as const };
        void this.sql`UPDATE transcript SET entry = ${JSON.stringify(settled)} WHERE seq = ${e.seq}`;
        this.emit({ type: "stage:transcript", entries: [settled] });
      }
    }
    if (!yes) return;
    const env = withRuns(this.env as StageEnv & { REPORT_WORKFLOW?: { create(options: { id: string; params: unknown }): Promise<unknown> } });
    const db = env.DB!;
    if (!env.REPORT_WORKFLOW) { this.notice("report-failed"); return; }
    const day = new Date().toISOString().slice(0, 10);
    const businessKey = (await sha256(`report-v1\n${owner.user_id}\n${owner.ticker}\n${day}\n${row.question.trim().toLowerCase()}`)).slice(0, 32);
    const existing = await db.prepare("SELECT id, status FROM user_runs WHERE user_id = ? AND business_key = ?").bind(owner.user_id, businessKey).first<{ id: string; status: string }>();
    const runId = existing?.status === "failed" ? crypto.randomUUID().replace(/-/g, "") : existing?.id ?? businessKey;
    if (!existing || existing.status === "failed") {
      const spent = await reserve(db, "stage-reports", { reader: owner.user_id, address });
      if (!spent.ok) { this.notice(spent.which === "global" ? "global-cap-reached" : "quota-reached"); return; }
      const claimed = await db.prepare("INSERT INTO user_runs (user_id, id, kind, ticker, conversation_id, business_key, status, started_at) VALUES (?, ?, 'report', ?, ?, ?, 'queued', ?) ON CONFLICT(user_id, business_key) DO UPDATE SET id = excluded.id, conversation_id = excluded.conversation_id, status = 'queued', started_at = excluded.started_at, finished_at = NULL, result = NULL, error = NULL WHERE user_runs.status = 'failed' RETURNING id")
        .bind(owner.user_id, runId, owner.ticker, this.name, businessKey, new Date().toISOString()).first<{ id: string }>();
      if (!claimed) {
        await refund(db, "stage-reports", { reader: owner.user_id, address }, 1);
        this.notice("report-failed");
        return;
      }
      try { await env.REPORT_WORKFLOW.create({ id: runId, params: { userId: owner.user_id, address, conversationId: this.name, ticker: owner.ticker, question: row.question, locale: owner.locale === "zh-CN" ? "zh-CN" : "en" } }); }
      catch (error) {
        await refund(db, "stage-reports", { reader: owner.user_id, address }, 1);
        await db.prepare("UPDATE user_runs SET status = 'failed', error = ? WHERE user_id = ? AND id = ?").bind(String(error).slice(0, 300), owner.user_id, runId).run();
        this.notice("report-failed");
        return;
      }
    } else if (existing.status === "done") {
      this.placeReport(runId, runId);
      return;
    } else if (existing.status !== "queued" && existing.status !== "running") {
      this.notice("report-failed");
      return;
    }
    this.notice("report-started");
    // The report the reader started takes the whole stage: its progress now, the report itself when it lands.
    this.commit([{ cells: [[{ id: `p${runId.slice(0, 8)}`, kind: "progress" as const, runId, phase: "queued" as const }]] }], this.state.scene.scope, this.state.scene.basis, "report", this.state.revision);
  }

  /** The report's Workflow began writing. */
  async reportPhase(runId: string, phase: "running"): Promise<void> {
    const rows = this.state.scene.rows.map(r => ({ ...r, cells: r.cells.map(c => c.map(b => b.kind === "progress" && b.runId === runId ? { ...b, phase } : b)) }));
    this.commit(rows, this.state.scene.scope, this.state.scene.basis, "report", this.state.revision);
  }

  /** The report's Workflow finished: the progress block becomes the report, or a notice when none came out. */
  async reportDone(outcome: { runId: string; reportId: string | null; reason: string }): Promise<void> {
    if (outcome.reportId) this.placeReport(outcome.runId, outcome.reportId);
    else {
      const rows = this.state.scene.rows.map(r => ({ ...r, cells: r.cells.map(c => c.map(b => b.kind === "progress" && b.runId === outcome.runId ? { id: b.id, kind: "notice" as const, code: "report-failed" as const } : b)) }));
      this.commit(rows, this.state.scene.scope, this.state.scene.basis, "report", this.state.revision);
      this.notice("report-failed");
    }
  }

  private placeReport(runId: string, reportId: string) {
    let placed = false;
    const rows = this.state.scene.rows.map(r => ({ ...r, cells: r.cells.map(c => c.map(b => { if (b.kind === "progress" && b.runId === runId) { placed = true; return { id: b.id, kind: "report" as const, reportId }; } return b; })) }));
    const next = placed ? rows : [{ cells: [[{ id: `r${reportId.slice(0, 8)}`, kind: "report" as const, reportId }]] }];
    this.commit(next, this.state.scene.scope, this.state.scene.basis, "report", this.state.revision);
    this.notice("report-ready");
  }

  /** For the operator (admin only): the transcript, every turn's trail, and the scene revisions, without the reader's id. */
  async inspect(): Promise<{ ticker: string | null; transcript: unknown[]; turns: unknown[]; log: unknown[]; scenes: unknown[] }> {
    return {
      ticker: this.owner()?.ticker ?? null,
      transcript: this.sql<{ entry: string }>`SELECT entry FROM transcript ORDER BY seq DESC LIMIT 100`.map(r => JSON.parse(r.entry)).reverse(),
      turns: this.sql`SELECT id, at, status, calls FROM turns ORDER BY at DESC LIMIT 50`,
      log: this.sql<{ at: string; turn: string; entry: string }>`SELECT at, turn, entry FROM log ORDER BY seq DESC LIMIT 200`.map(r => ({ at: r.at, turn: r.turn, ...JSON.parse(r.entry) })).reverse(),
      scenes: this.sql<{ revision: number; at: string; by: string; scene: string }>`SELECT revision, at, by, scene FROM scenes ORDER BY revision DESC LIMIT 20`.map(r => ({ revision: r.revision, at: r.at, by: r.by, scene: JSON.parse(r.scene) })),
    };
  }

  private phaseOf(tool: string): TurnPhase { return tool === "reply" ? "answering" : tool === "compile" || tool === "finish" ? "staging" : "thinking"; }

  /** The reader deleted the conversation, or it expired: everything the object holds goes, and the registry marks it. */
  async purge(): Promise<void> {
    this.running?.abort();
    await this.env.DB?.prepare("UPDATE stage_conversations SET status = 'deleted' WHERE id = ?").bind(this.name).run().catch(() => {});
    await this.env.DB?.prepare("DELETE FROM user_reports WHERE conversation_id = ?").bind(this.name).run().catch(() => {});
    for (const c of this.getConnections()) c.close(4410, "deleted");
    await this.destroy();
  }
}

/** A short argument for the status line: the reference or scene a call is about, never the reader's words. */
function argOf(call: ToolCall): string | undefined {
  const input = call.input as Record<string, unknown> | null;
  if (call.name === "read_series" && Array.isArray(input?.refs)) return String(input!.refs.length);
  return undefined;
}
