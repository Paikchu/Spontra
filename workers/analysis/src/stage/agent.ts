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
import { sha256 } from "./identity.ts";
import { STAGE_BUDGET, stageRecipeFor, stageTools, type StageView } from "./recipe.ts";
import { readStageSwitch, stageOpenFor } from "./settings.ts";

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
  | { id: string; at: string; role: "assistant"; kind: "notice"; code: NoticeCode };
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
    if (!stageOpenFor(await readStageSwitch(env), owner.ticker)) { this.notice("stage-off"); return; }
    const says = await reserve(db, "stage-says", who).catch(() => ({ ok: false as const, which: "global" as const }));
    if (!says.ok) { this.notice(says.which === "global" ? "global-cap-reached" : "quota-reached"); return; }
    const controller = new AbortController();
    this.running = controller;
    this.sql`INSERT INTO turns (id, at, status) VALUES (${turnId}, ${new Date().toISOString()}, 'running')`;
    this.emit({ type: "stage:turn", turn: { id: turnId, phase: "thinking", status: null } });
    let calls = 0, status = "failed", capHit: "reader" | "address" | "global" | null = null;
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
        record: entry => { this.sql`INSERT INTO log (at, turn, entry) VALUES (${new Date().toISOString()}, ${turnId}, ${JSON.stringify(entry)})`; },
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
      const result = outcome.output;
      if (result.kind === "scene") {
        const committed = this.commit(result.rows, { periodEnd: result.periodEnd, ...(result.findingId ? { findingId: result.findingId } : {}) }, data.basis, "finish", before);
        if (committed) this.addTranscript({ id: uid(), at: new Date().toISOString(), role: "assistant", kind: "stage", revision: this.state.revision });
        status = "done";
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
      console.error(JSON.stringify({ event: "stage-turn", outcome: "error", conversation: this.name, error: error instanceof Error ? error.message : String(error) }));
      this.notice("turn-failed");
    } finally {
      this.running = null;
      this.sql`UPDATE turns SET status = ${status}, calls = ${calls} WHERE id = ${turnId}`;
      this.emit({ type: "stage:draft", rows: null });
      this.emit({ type: "stage:turn", turn: null });
      // A turn that spent nothing on the model gives its say back.
      if (calls === 0) await refund(db, "stage-says", who, 1).catch(() => {});
      await db.prepare("UPDATE stage_conversations SET last_at = ?, turns = turns + 1 WHERE id = ?").bind(new Date().toISOString(), this.name).run().catch(() => {});
    }
  }

  private phaseOf(tool: string): TurnPhase { return tool === "reply" ? "answering" : tool === "compile" || tool === "finish" ? "staging" : "thinking"; }

  /** The reader deleted the conversation, or it expired: everything the object holds goes, and the registry marks it. */
  async purge(): Promise<void> {
    this.running?.abort();
    await this.env.DB?.prepare("UPDATE stage_conversations SET status = 'deleted' WHERE id = ?").bind(this.name).run().catch(() => {});
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
