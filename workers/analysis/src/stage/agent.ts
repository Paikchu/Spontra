import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import type Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_SCENE_ROWS, type NoticeCode, type SceneDocument, type SceneRow } from "../../../../shared/analysis-contract/scene.ts";
import type { Locale } from "../../../../shared/analysis-runtime/locale.ts";
import { sequential, runAgentLoop, type LoopHost } from "../agent-loop.ts";
import { modelFor, reasoningFor } from "../ai-config.ts";
import { companyPolicyEnvironment } from "../financial-data/company-policy.ts";
import { SecModelOutputError } from "../model-stream.ts";
import { callWorkerToolModel, type AnalysisEnv } from "../operations.ts";
import type { AgentMessage, AgentReply, ToolCall } from "../tool-loop.ts";
import type { ToolOutcome } from "../tools/registry.ts";
import { refund, reserve, type Spender } from "./budget.ts";
import { loadStageData } from "./data.ts";
import { sha256 } from "../sha256.ts";
import { STAGE_BUDGET, stageRecipeFor, stageTools, type StageView } from "./recipe.ts";

/**
 * One reader's conversation with the stage (docs/stage-agent-design.md §5.3), an Agents SDK Agent and so a Durable
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
const FOLD_AFTER_RESULTS = 80;
const MAX_TEXT = 600;

const emptyScene = (ticker: string): SceneDocument => ({ schemaVersion: "scene.v1", scope: { periodEnd: "" }, basis: {}, rows: DEFAULT_SCENE_ROWS.map(r => ({ ...r })) });
const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

export class StageAgent extends Agent<StageEnv, StageState> {
  initialState: StageState = { scene: emptyScene(""), revision: 0, applied: 0, contentLanguage: "en" };
  private running: AbortController | null = null;
  private view: StageView | null = null;

  async onStart(props?: StageProps): Promise<void> {
    this.sql`CREATE TABLE IF NOT EXISTS owner (user_id TEXT NOT NULL, ticker TEXT NOT NULL, locale TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS transcript (seq INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS scenes (revision INTEGER PRIMARY KEY, at TEXT NOT NULL, by TEXT NOT NULL, scene TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, turn TEXT NOT NULL, entry TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, at TEXT NOT NULL, status TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0)`;
    this.sql`CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, question TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open')`;
    if (props && !this.owner()) this.sql`INSERT INTO owner (user_id, ticker, locale) VALUES (${props.userId}, ${props.ticker}, ${props.locale})`;
    // A turn the object was evicted in the middle of is marked, not run again: its model calls are already paid.
    for (const t of this.sql<{ id: string }>`SELECT id FROM turns WHERE status = 'running'`) {
      this.sql`UPDATE turns SET status = 'interrupted' WHERE id = ${t.id}`;
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
    this.sql`INSERT INTO transcript (entry) VALUES (${JSON.stringify(entry)})`;
    this.emit({ type: "stage:transcript", entries: [entry] });
  }
  private notice(code: NoticeCode) { this.addTranscript({ id: uid(), at: new Date().toISOString(), role: "assistant", kind: "notice", code }); }

  /** The only way the scene changes: a new revision on top of the one the change was made against. */
  private commit(rows: SceneRow[], scope: SceneDocument["scope"], basis: SceneDocument["basis"], by: string, expectedRevision: number): boolean {
    if (this.state.revision !== expectedRevision) return false;
    const revision = expectedRevision + 1;
    const scene: SceneDocument = { schemaVersion: "scene.v1", scope, basis, rows };
    this.sql`INSERT INTO scenes (revision, at, by, scene) VALUES (${revision}, ${new Date().toISOString()}, ${by}, ${JSON.stringify(scene)})`;
    this.setState({ ...this.state, scene, revision });
    return true;
  }

  private loadMessages(): AgentMessage[] {
    return this.sql<{ role: string; content: string }>`SELECT role, content FROM messages ORDER BY seq`.map(r => ({ role: r.role as AgentMessage["role"], content: JSON.parse(r.content) as AgentMessage["content"] }));
  }
  private saveMessages(messages: AgentMessage[], from: number) {
    messages.slice(from).forEach((m, i) => { this.sql`INSERT INTO messages (seq, role, content) VALUES (${from + i}, ${m.role}, ${JSON.stringify(m.content)})`; });
  }

  private async turn(text: string, address: string | null): Promise<void> {
    const owner = this.owner();
    if (!owner) return;
    if (this.running) return;
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
    this.sql`INSERT INTO turns (id, at, status) VALUES (${turnId}, ${new Date().toISOString()}, 'running')`;
    this.emit({ type: "stage:turn", turn: { id: turnId, phase: "thinking", status: null } });
    let calls = 0, status = "failed", capHit: "reader" | "address" | "global" | null = null, firstError: string | null = null, reason: string | null = null;
    const startedAt = new Date().toISOString();
    try {
      const data = await loadStageData(env, owner.ticker);
      if (!data) { this.notice("turn-failed"); return; }
      const before = this.state.revision;
      const input = { data, locale, scene: this.state.scene.rows, view: this.view };
      const recipe = stageRecipeFor(input);
      const state = recipe.open(input);
      state.onDraft = rows => this.emit({ type: "stage:draft", rows });
      let messages = this.loadMessages();
      // A long exchange is folded at a turn's start into one summary, so the cache breaks once rather than every turn.
      if (messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === "tool_result") : []).length > FOLD_AFTER_RESULTS) {
        const recent = this.sql<{ entry: string }>`SELECT entry FROM transcript ORDER BY seq DESC LIMIT 6`.map(r => r.entry).reverse();
        this.sql`DELETE FROM messages`;
        messages = [{ role: "user", content: JSON.stringify({ summary: "Earlier turns of this conversation, folded.", stage: this.state.scene.rows, recent }) }, { role: "assistant", content: [{ type: "text", text: "Noted." }] }];
        this.sql`INSERT INTO log (at, turn, entry) VALUES (${new Date().toISOString()}, ${turnId}, ${JSON.stringify({ action: "fold" })})`;
      }
      const start = messages.length;
      messages.push({ role: "user", content: JSON.stringify({ request: text, view: this.view, stage: this.state.scene.rows.map(r => ({ title: r.title, cells: r.cells.map(c => c.map(b => b.kind)) })), budget: { turns: STAGE_BUDGET.turns } }) });
      const tools = stageTools(input);
      const act = async (stage: string, system: string, schemas: unknown[], msgs: AgentMessage[]): Promise<AgentReply> => {
        try {
          return await callWorkerToolModel(env, fetch, `stage-${stage}`, { system, tools: schemas as Anthropic.Beta.BetaTool[], messages: msgs as Anthropic.Beta.BetaMessageParam[] }, modelFor(env, "stage"), 60_000,
            { reasoning: reasoningFor(env, "stage"), ticker: owner.ticker, kind: "stage", runId: turnId, userHash, conversationId: this.name });
        } catch (error) {
          return { error: `${error instanceof SecModelOutputError ? error.code : "request"}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) };
        }
      };
      const host: LoopHost<typeof state> = {
        reserve: async () => {
          const r = await reserve(db, "stage-calls", who).catch(() => ({ ok: false as const, which: "global" as const }));
          if (!r.ok) { capHit = r.which; return false; }
          calls++;
          return true;
        },
        record: entry => {
          if (entry.action === "invalid" && !firstError) firstError = entry.observation.slice(0, 500);
          this.sql`INSERT INTO log (at, turn, entry) VALUES (${new Date().toISOString()}, ${turnId}, ${JSON.stringify(entry)})`;
        },
        execute: async (_turn, list, run) => {
          const safe = new Set(tools.filter(t => t.concurrencySafe).map(t => t.name));
          const status = (call: ToolCall) => this.emit({ type: "stage:turn", turn: { id: turnId, phase: this.phaseOf(call.name), status: { tool: call.name, ...(argOf(call) ? { arg: argOf(call) } : {}) } } });
          const runOne = (call: ToolCall): Promise<ToolOutcome> => { status(call); return run(call); };
          return list.every(c => safe.has(c.name)) ? Promise.all(list.map(runOne)) : sequential(list, runOne);
        },
        onToolStart: name => this.emit({ type: "stage:turn", turn: { id: turnId, phase: this.phaseOf(name), status: null } }),
        signal: controller.signal,
        now: () => Date.now(),
      };
      const outcome = await runAgentLoop({ ...recipe, tools: () => tools }, input, state, messages, act, host);
      this.saveMessages(messages, start);
      // A report the turn proposed stops the loop before it runs; the reader decides.
      const result: typeof outcome.output = outcome.asked ? { kind: "report", question: outcome.asked } : outcome.output;
      reason = `${outcome.reason}:${result.kind}:${outcome.turns}`;
      if (result.kind === "scene") {
        // A report that finished during the turn keeps its place: its block joins the turn's scene.
        const kept = this.state.revision === before ? [] : this.state.scene.rows.filter(r => r.cells.flat().some(b => b.kind === "report" || b.kind === "progress"));
        const committed = this.commit([...kept, ...result.rows].slice(0, 8), { periodEnd: result.periodEnd, ...(result.findingId ? { findingId: result.findingId } : {}) }, data.basis, "finish", this.state.revision);
        if (committed) this.addTranscript({ id: uid(), at: new Date().toISOString(), role: "assistant", kind: "stage", revision: this.state.revision });
        status = "done";
      } else if (result.kind === "report") {
        const questionId = uid();
        this.sql`INSERT INTO questions (id, question) VALUES (${questionId}, ${result.question})`;
        this.addTranscript({ id: uid(), at: new Date().toISOString(), role: "assistant", kind: "question", questionId, question: result.question });
        status = "asked";
      } else if (result.kind === "answer") {
        this.addTranscript({ id: uid(), at: new Date().toISOString(), role: "assistant", kind: "answer", paragraphs: result.paragraphs, contentLanguage: locale });
        status = "done";
      } else if (capHit) {
        this.notice(capHit === "global" ? "global-cap-reached" : "quota-reached");
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
      this.running = null;
      this.sql`UPDATE turns SET status = ${status}, calls = ${calls} WHERE id = ${turnId}`;
      this.emit({ type: "stage:draft", rows: null });
      this.emit({ type: "stage:turn", turn: null });
      // A turn that spent nothing on the model gives its say back.
      if (calls === 0) await refund(db, "stage-says", who, 1).catch(() => {});
      await db.prepare("UPDATE stage_conversations SET last_at = ?, turns = turns + 1 WHERE id = ?").bind(new Date().toISOString(), this.name).run().catch(() => {});
      // The turn's record for the operator: how it ended and the first model failure, never the reader's words.
      await db.prepare("INSERT OR IGNORE INTO user_runs (user_id, id, kind, ticker, conversation_id, business_key, status, started_at, finished_at, result, error) VALUES (?, ?, 'stage-turn', ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(owner.user_id, turnId, owner.ticker, this.name, turnId, status, startedAt, new Date().toISOString(), JSON.stringify({ calls, reason }), firstError).run().catch(() => {});
    }
  }

  /** The reader confirmed or declined a proposed report; a confirmed one starts its Workflow under a key that repeats for the same question the same day. */
  private async settleQuestion(questionId: string, yes: boolean, address: string | null): Promise<void> {
    const owner = this.owner();
    const row = this.sql<{ question: string; status: string }>`SELECT question, status FROM questions WHERE id = ${questionId}`[0];
    if (!owner || !row || row.status !== "open") return;
    this.sql`UPDATE questions SET status = ${yes ? "yes" : "no"} WHERE id = ${questionId}`;
    const entries = this.sql<{ seq: number; entry: string }>`SELECT seq, entry FROM transcript ORDER BY seq DESC LIMIT 40`;
    for (const e of entries) {
      const entry = JSON.parse(e.entry) as TranscriptEntry;
      if (entry.role === "assistant" && entry.kind === "question" && entry.questionId === questionId) {
        const settled = { ...entry, settled: yes ? "yes" as const : "no" as const };
        this.sql`UPDATE transcript SET entry = ${JSON.stringify(settled)} WHERE seq = ${e.seq}`;
        this.emit({ type: "stage:transcript", entries: [settled] });
      }
    }
    if (!yes) return;
    const env = this.env as StageEnv & { REPORT_WORKFLOW?: Workflow };
    const db = env.DB!;
    if (!env.REPORT_WORKFLOW) { this.notice("report-failed"); return; }
    const day = new Date().toISOString().slice(0, 10);
    const runId = (await sha256(`report-v1\n${owner.user_id}\n${owner.ticker}\n${day}\n${row.question.trim().toLowerCase()}`)).slice(0, 32);
    const existing = await db.prepare("SELECT status FROM user_runs WHERE user_id = ? AND id = ?").bind(owner.user_id, runId).first<{ status: string }>();
    if (!existing) {
      const spent = await reserve(db, "stage-reports", { reader: owner.user_id, address });
      if (!spent.ok) { this.notice(spent.which === "global" ? "global-cap-reached" : "quota-reached"); return; }
      await db.prepare("INSERT INTO user_runs (user_id, id, kind, ticker, conversation_id, business_key, status, started_at) VALUES (?, ?, 'report', ?, ?, ?, 'queued', ?)").bind(owner.user_id, runId, owner.ticker, this.name, runId, new Date().toISOString()).run();
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
