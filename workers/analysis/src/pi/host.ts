import { currentPiTracer, emitTurnSpans, PiTurnTraces, type TurnTrace } from "./tracing.ts";
import { within } from "./within.ts";
import { CompactionTask, createRegistry, GenerationTask, Harness, hook, type ConversationId, type ToolRegistration } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { defaultBudgetLine, fitResult, type Recipe, type TurnRecord } from "../recipe.ts";
import { CALLS_PER_TURN } from "../tool-loop.ts";
import { runTool, toolSchema, type AnyTool, type ToolOutcome } from "../tools/registry.ts";
import { NATIVE_SEARCH_INSTRUCTION } from "../web-search/native.ts";
import { DeepSeekWebProvider } from "../web-search/deepseek.ts";
import { SEC_DOMAIN } from "../../../../shared/analysis-runtime/sec-sources.ts";
import { aiUsageFromMetrics, recordAiUsage } from "../ai-runs/usage.ts";
import { PI_PROVIDER, piModels, shapePayload } from "./model.ts";
import { packState, unpackState } from "./state.ts";

/**
 * The Pi session host: every agent run (a stage turn, an analysis) is a Pi session on `PiHarness` inside the Agent that
 * owns it. Pi keeps the exchange, its checkpoints and its compaction; this host supplies the recipe: the system prompt,
 * the tools through the existing pipeline (`runTool`: schema, policy, timeout, observation), the budgets, the cost
 * ledger, and the recipe state, stored after every call so a session continues after an eviction.
 *
 * Pi ends a run on a tool round only when every call of the round asks to terminate, so the limits that end a run
 * (turns, wall time, the allowance) are decided before the round's request goes out, and every call of that last round
 * terminates; a settled recipe terminates every call after the one that settled it.
 */

/** What a host Agent rebuilds from a session's stored spec, on start and again after an eviction. */
export type PiLoaded<S = any> = {
  recipe: Recipe<any, any, S>;
  input: unknown;
  /** Re-attaches what the stored state cannot carry (callbacks). */
  hydrate?(state: S): void;
  model: string;
  effort: string;
  ledger: { kind: string; ticker?: string; runId?: string; userHash?: string; conversationId?: string };
  /** Reserves one model call against the allowances; false ends the run after the current round. It may mark the state. */
  reserve?(state: S, now: number): Promise<boolean>;
  /** Returns the unused call reserved at this time, including its original budget day. */
  refund?(state: S, reservedAt: number): Promise<void>;
  record?(entry: TurnRecord): void;
  onToolStart?(name: string, args: unknown): void;
};
export type PiLoader = (spec: any) => Promise<PiLoaded>;
type Env = { DB?: D1Database; DEEPSEEK_API_KEY?: string; PI_MODEL_BASE_URL?: string };
/** The owning Agent's SQLite and env. */
type HostAgent = { sql: SqlStorage; env: unknown };

export type PiOutcome<O = unknown> = {
  output: O;
  reason: "finished" | "budget" | "failed" | "interrupted" | "cancelled";
  turns: number;
  asked: string | null;
  /** The allowance, not the turn budget, ended the run. */
  capped: boolean;
  trail: TurnRecord[];
  /** Uncached input plus output the session spent. */
  spent: number;
  /** The recipe state the run ended with. */
  state: unknown;
};

type Binding = {
  conversation: string; session: string; operationId: string; kind: string; spec: unknown;
  loaded: PiLoaded; tools: AnyTool<unknown>[]; system: string; state: unknown;
  startedAt: number; turns: number; quiet: number; said: string;
  lastRound: boolean; capped: boolean; finished: boolean; asked: string | null;
  /** The calls of the round in progress, from the reply that made them; when the request went out. */
  round: RoundCall[]; requestAt: number; spent: number; reservedAt: number | null;
};
type RoundCall = { id: string; name: string; args: unknown };
type Row = { conversation: string; session: string; operation_id: string; kind: string; spec: string; state: string; started_at: number;
  turns: number; quiet: number; last_round: number; capped: number; finished: number; asked: string | null; round: string | null; spent: number | null;
  startup: string | null; reserved_at: number | null };
type Startup = { phase: "prepared" | "model-set"; opening: string };

const text = (value: string) => [{ type: "text" as const, text: value }];
const parseArgs = (args: unknown): unknown => {
  // DeepSeek may send a call's arguments as one JSON string.
  if (typeof args !== "string") return args;
  try { return JSON.parse(args); } catch { return args; }
};
const WEB_SEARCH = "web_search";
/** How long a check waits for an ended run to resolve before it looks again on a later wake. */
const POLL_WAIT_MS = 20_000;
const PI_TURN_LIMIT = 400;

export class PiHost {
  readonly registry = createRegistry();
  readonly harness: PiHarness;
  private readonly bindings = new Map<string, Binding>();
  private restored = false;
  private tables = false;
  private readonly starting = new Map<string, Promise<void>>();
  /** Sessions whose afterRun hook is running in this instance; recovery leaves them to it. */
  private readonly ending = new Set<string>();
  private recoveryPending = false;

  private readonly traces = new PiTurnTraces((turn) => this.recordTurn(turn));
  private traceFlushPending = false;

  constructor(private readonly agent: HostAgent, private readonly loaders: Record<string, PiLoader>,
    private readonly options: { models: () => string[]; isStopped?: () => boolean; onSettled?: (operationId: string) => void; /** Ask for `flushTraces` to run in an invocation of its own. */ scheduleTraceFlush?: () => Promise<unknown>;
      /** Ask for `recoverEnded` to run in an invocation of its own. */ scheduleRecovery?: () => Promise<unknown> }) {
    this.harness = new PiHarness({
      harness: async ({ storage, context, onWake }) => {
        await this.restore();
        return Harness.open(storage, {
          models: piModels(this.env, options.models()), registry: this.registry,
          // Pi idle while a session is still open means its run ended without an answer (a turn limit, a failure), which
          // runs no afterRun hook: the session is settled by recovery instead of waiting for someone to read it.
          onWake: (wake) => { onWake?.(wake); if (!wake.active) this.noticeIdle(); },
          // One call at a time, as the loop ran them; a failed run is withdrawn so its result reads unanswered.
          settings: { toolExecution: "sequential", afterFailedRun: "withdraw" },
        }, context);
      },
      // Every recipe's own budget ends its run first (the last round); pi's limit only backstops a budget that fails, so it
      // sits above the largest budget (a periodic filing's 100 turns). A run pi cuts off at its limit runs no afterRun hook.
      defaults: { model: { provider: PI_PROVIDER, id: options.models()[0]! }, maxTurns: PI_TURN_LIMIT },
    });
  }

  private get env(): Env { return this.agent.env as Env; }

  private db() {
    const sql = this.agent.sql;
    if (!this.tables) {
      sql.exec(`CREATE TABLE IF NOT EXISTS pi_bindings (conversation TEXT PRIMARY KEY, session TEXT NOT NULL, operation_id TEXT NOT NULL,
        kind TEXT NOT NULL, spec TEXT NOT NULL, state TEXT NOT NULL, started_at INTEGER NOT NULL, turns INTEGER NOT NULL DEFAULT 0,
        quiet INTEGER NOT NULL DEFAULT 0, last_round INTEGER NOT NULL DEFAULT 0, capped INTEGER NOT NULL DEFAULT 0,
        finished INTEGER NOT NULL DEFAULT 0, asked TEXT, round TEXT, active INTEGER NOT NULL DEFAULT 1)`);
      sql.exec("CREATE TABLE IF NOT EXISTS pi_trail (conversation TEXT NOT NULL, seq INTEGER NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (conversation, seq))");
      // The outcome of each call of the round in progress, so a call Pi replays after an eviction is not run twice.
      sql.exec("CREATE TABLE IF NOT EXISTS pi_calls (conversation TEXT NOT NULL, call_id TEXT NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY (conversation, call_id))");
      sql.exec("CREATE TABLE IF NOT EXISTS pi_trace_queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, turn TEXT NOT NULL)");
      // Sessions created before the token budget have no such column; adding it twice is the only failure and is harmless.
      try { sql.exec("ALTER TABLE pi_bindings ADD COLUMN spent INTEGER NOT NULL DEFAULT 0"); } catch { /* present */ }
      // NULL means submitted (including bindings created before startup checkpoints existed).
      try { sql.exec("ALTER TABLE pi_bindings ADD COLUMN startup TEXT"); } catch { /* present */ }
      try { sql.exec("ALTER TABLE pi_bindings ADD COLUMN reserved_at INTEGER"); } catch { /* present */ }
      this.tables = true;
    }
    return sql;
  }

  /** Starts one session on the stored spec; the same operation id joins the run already started. */
  async start(kind: string, spec: unknown, opening: string, options: { operationId: string; session?: string }): Promise<{ operationId: string; session: string; refused?: "capped" }> {
    this.assertRunning();
    const existing = this.db().exec<Row>("SELECT * FROM pi_bindings WHERE operation_id = ?", options.operationId).toArray()[0];
    if (existing) {
      await this.ensureStarted(existing.operation_id);
      return { operationId: existing.operation_id, session: existing.session, ...(existing.capped && !existing.session ? { refused: "capped" as const } : {}) };
    }
    const loaded = await this.loaders[kind]!(spec);
    this.assertRunning();
    const state = loaded.recipe.open(loaded.input);
    loaded.hydrate?.(state);
    // The first call is reserved before the session starts; each later one before the round ahead of it. A refused
    // start never reaches Pi: it is recorded as settled on its budget, so the caller reads an ordinary outcome.
    const reservedAt = Date.now();
    if (loaded.reserve && !await loaded.reserve(state, reservedAt)) {
      this.db().exec("INSERT OR REPLACE INTO pi_bindings (conversation, session, operation_id, kind, spec, state, started_at, last_round, capped, active) VALUES (?, '', ?, ?, ?, ?, ?, 1, 1, 0)",
        `refused:${options.operationId}`, options.operationId, kind, JSON.stringify(spec ?? null), packState(state), Date.now());
      return { operationId: options.operationId, session: "", refused: "capped" };
    }
    let bound = false;
    try {
      this.assertRunning();
      const session = options.session ? this.harness.sessions.get(options.session) : await this.harness.sessions.create();
      const conversation = String((await this.harness.conversation(session.id)).id);
      this.assertRunning();
      // One run per session at a time: a second would take over the first one's recipe and state.
      const running = this.db().exec<{ operation_id: string }>("SELECT operation_id FROM pi_bindings WHERE conversation = ? AND active = 1", conversation).toArray()[0];
      if (running) throw new Error(`pi: session ${session.id} is still running ${running.operation_id}`);
      this.db().exec("INSERT OR REPLACE INTO pi_bindings (conversation, session, operation_id, kind, spec, state, started_at, startup, reserved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        conversation, session.id, options.operationId, kind, JSON.stringify(spec ?? null), packState(state), Date.now(), JSON.stringify({ phase: "prepared", opening } satisfies Startup), loaded.reserve ? reservedAt : null);
      this.db().exec("DELETE FROM pi_trail WHERE conversation = ?", conversation);
      this.db().exec("DELETE FROM pi_calls WHERE conversation = ?", conversation);
      this.bind({ conversation, session: session.id, operationId: options.operationId, kind, spec, loaded, state, startedAt: Date.now(),
        turns: 0, quiet: 0, lastRound: false, capped: false, finished: false, asked: null, round: [], requestAt: 0, spent: 0, reservedAt: loaded.reserve ? reservedAt : null });
      bound = true;
      await this.ensureStarted(options.operationId);
      return { operationId: options.operationId, session: session.id };
    } catch (error) {
      if (!bound) await loaded.refund?.(state, reservedAt);
      throw error;
    }
  }

  private async ensureStarted(operationId: string): Promise<void> {
    const pending = this.starting.get(operationId);
    if (pending) return pending;
    const work = this.resumeStart(operationId);
    this.starting.set(operationId, work);
    try { await work; } finally { this.starting.delete(operationId); }
  }

  /** A binding is only a prepared start; Pi must durably accept its input before callers can join it. */
  private async resumeStart(operationId: string): Promise<void> {
    const row = this.db().exec<Row>("SELECT * FROM pi_bindings WHERE operation_id = ?", operationId).toArray()[0];
    if (!row?.startup) return;
    this.assertRunning();
    const startup = JSON.parse(row.startup) as Startup;
    const session = this.harness.sessions.get(row.session);
    if (startup.phase === "prepared") {
      const b = await this.bound(row.conversation);
      if (!b) throw new Error(`pi: session ${row.conversation} cannot be rebuilt`);
      await session.setModel({ provider: PI_PROVIDER, id: b.loaded.model });
      this.assertRunning();
      this.db().exec("UPDATE pi_bindings SET startup = ? WHERE operation_id = ?", JSON.stringify({ phase: "model-set", opening: startup.opening } satisfies Startup), operationId);
    }
    // The operation id is Pi's idempotency key: replay is safe if submit succeeded but its acknowledgement was lost.
    try { await session.submit(startup.opening, { operationId }); }
    // Termination can interleave with submit, including a lost acknowledgement.
    finally { if (this.options.isStopped?.()) await session.abort(); }
    this.db().exec("UPDATE pi_bindings SET startup = NULL WHERE operation_id = ?", operationId);
  }

  private assertRunning() {
    if (this.options.isStopped?.()) throw new Error("pi: task terminated");
  }

  /** Waits for the session's run and settles the recipe. */
  async finish<O>(operationId: string, signal?: AbortSignal): Promise<PiOutcome<O>> {
    await this.ensureStarted(operationId);
    const session = this.sessionOf(operationId);
    if (session === undefined) throw new Error(`pi: no session for operation ${operationId}`);
    // A refused start has no session; it settles on its budget at once.
    if (session === "") return this.settle<O>(operationId, { status: "done" });
    const result = await this.harness.sessions.get(session).wait(operationId, signal);
    return this.settle<O>(operationId, result);
  }

  /** The outcome once the run has ended, else null; for a caller that checks back instead of waiting. */
  async poll<O>(operationId: string): Promise<PiOutcome<O> | null> {
    const session = this.sessionOf(operationId);
    if (session === "") return this.finish<O>(operationId);
    // The check must return, whatever Pi's promises do: on time it means "look again on the next wake".
    return within(POLL_WAIT_MS, async (signal) => {
      await this.ensureStarted(operationId);
      const pending = await this.harness.pending({ session }).catch(() => []);
      if (pending.some((p) => p.operationId === operationId)) return null;
      return this.finish<O>(operationId, signal);
    });
  }

  /** A finished turn waits in storage until an invocation with a live trace writes its spans. */
  private recordTurn(turn: TurnTrace) {
    this.db().exec("INSERT INTO pi_trace_queue (turn) VALUES (?)", JSON.stringify(turn));
    if (this.traceFlushPending || !this.options.scheduleTraceFlush) return;
    this.traceFlushPending = true;
    void this.options.scheduleTraceFlush().catch(() => { this.traceFlushPending = false; });
  }

  /** Writes the spans of the turns recorded so far; called from an invocation of its own, so they reach the trace. */
  flushTraces() {
    this.traceFlushPending = false;
    const rows = this.db().exec<{ seq: number; turn: string }>("SELECT seq, turn FROM pi_trace_queue ORDER BY seq LIMIT 200").toArray();
    for (const row of rows) emitTurnSpans(currentPiTracer(), JSON.parse(row.turn) as TurnTrace);
    if (rows.length) this.db().exec("DELETE FROM pi_trace_queue WHERE seq <= ?", rows.at(-1)!.seq);
  }

  /** What each session of this Agent did, turn by turn, for the admin. */
  sessionsReport(): Array<{ operationId: string; kind: string; turns: number; spent: number; active: boolean; trail: TurnRecord[] }> {
    return this.db().exec<Row & { active: number }>("SELECT * FROM pi_bindings ORDER BY started_at").toArray().map((row) => ({
      operationId: row.operation_id, kind: row.kind, turns: row.turns, spent: row.spent ?? 0, active: !!row.active,
      trail: this.db().exec<{ entry: string }>("SELECT entry FROM pi_trail WHERE conversation = ? ORDER BY seq", row.conversation).toArray().map((r) => JSON.parse(r.entry) as TurnRecord),
    }));
  }

  /**
   * Sessions whose run ended while nobody was there to settle it (the object was replaced mid-run, as on a deploy):
   * a recipe with its own ending (deliver, record) gets it now, so a standalone session never stays open with its
   * work done. A session whose operation pi still holds is left to pi, which resumes it.
   */
  async recoverEnded(): Promise<Array<{ operationId: string; state: string }>> {
    const out: Array<{ operationId: string; state: string }> = [];
    this.recoveryPending = false;
    for (const row of this.db().exec<Row>("SELECT * FROM pi_bindings WHERE active = 1").toArray()) {
      if (row.startup) { out.push({ operationId: row.operation_id, state: "starting" }); continue; }
      if (this.ending.has(row.conversation)) { out.push({ operationId: row.operation_id, state: "ending" }); continue; }
      const pending = await this.harness.pending({ session: row.session }).catch(() => null);
      if (!pending) { out.push({ operationId: row.operation_id, state: "unknown" }); continue; }
      const held = pending.find(p => p.operationId === row.operation_id);
      if (held) { out.push({ operationId: row.operation_id, state: held.status }); continue; }
      const b = await this.bound(row.conversation);
      if (!b?.loaded.recipe.afterRun) { out.push({ operationId: row.operation_id, state: "ended" }); continue; }
      const result = await within(POLL_WAIT_MS, signal => this.harness.sessions.get(row.session).wait(row.operation_id, signal)).catch(() => null);
      console.warn(JSON.stringify({ event: "pi-recovered-ended", kind: row.kind, operationId: row.operation_id, turns: b.turns, result: result ? { status: result.status, reason: result.reason ?? null } : null }));
      await this.guard(async () => { await b.loaded.recipe.afterRun!(b.state); });
      this.persist(b);
      await this.close(b);
      this.options.onSettled?.(b.operationId);
      out.push({ operationId: row.operation_id, state: "recovered" });
    }
    return out;
  }

  /** Pi has nothing running: a session still open here ended unsettled, so recovery is asked for once. */
  private noticeIdle() {
    if (this.recoveryPending || !this.options.scheduleRecovery) return;
    if (!this.db().exec<{ n: number }>("SELECT COUNT(*) n FROM pi_bindings WHERE active = 1 AND startup IS NULL").toArray()[0]?.n) return;
    this.recoveryPending = true;
    void this.options.scheduleRecovery().catch(() => { this.recoveryPending = false; });
  }

  async abort(operationId: string): Promise<void> {
    const session = this.sessionOf(operationId);
    if (session) await this.harness.sessions.get(session).abort(operationId);
  }

  /** Abort every live session, including sessions restored from storage after an eviction. */
  async abortActive(): Promise<void> {
    const rows = this.db().exec<Row>("SELECT * FROM pi_bindings WHERE active = 1").toArray();
    const results = await Promise.allSettled(rows.map(async row => {
      await this.harness.sessions.get(row.session).abort();
      this.db().exec("UPDATE pi_bindings SET active = 0, startup = NULL WHERE conversation = ?", row.conversation);
      this.bindings.delete(row.conversation);
    }));
    this.install();
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "pi: failed to abort active sessions");
  }

  private sessionOf(operationId: string): string | undefined {
    return this.db().exec<{ session: string }>("SELECT session FROM pi_bindings WHERE operation_id = ?", operationId).toArray()[0]?.session;
  }

  private async settle<O>(operationId: string, result: { status: string; reason?: string }): Promise<PiOutcome<O>> {
    const row = this.db().exec<Row>("SELECT * FROM pi_bindings WHERE operation_id = ?", operationId).toArray()[0];
    if (!row) throw new Error(`pi: no session for operation ${operationId}`);
    const b = await this.bound(row.conversation, true);
    if (!b) throw new Error(`pi: session ${row.conversation} cannot be rebuilt`);
    const settled = b.loaded.recipe.settled(b.state);
    const reason: PiOutcome["reason"] = b.asked || settled ? "finished"
      : result.status === "unanswered" ? (result.reason === "interrupted" ? "interrupted" : /abort|withdraw|cancel/.test(result.reason ?? "") ? "cancelled" : "failed")
      : b.lastRound ? "budget" : "failed";
    if (result.status === "unanswered") this.trail(b, { turn: b.turns, thought: "", action: "invalid", input: "", observation: `run ended: ${result.reason ?? "unanswered"}` });
    const trail = this.db().exec<{ entry: string }>("SELECT entry FROM pi_trail WHERE conversation = ? ORDER BY seq", b.conversation).toArray().map((r) => JSON.parse(r.entry) as TurnRecord);
    const output = b.loaded.recipe.settle(b.state, reason) as O;
    await this.close(b);
    return { output, reason, turns: b.turns, asked: b.asked, capped: b.capped, trail, spent: b.spent, state: b.state };
  }

  private async close(b: Binding) {
    if (b.reservedAt !== null) {
      await b.loaded.refund?.(b.state, b.reservedAt);
      b.reservedAt = null;
      this.persist(b);
    }
    this.traces.endTurn(b.conversation);
    this.db().exec("UPDATE pi_bindings SET active = 0 WHERE conversation = ?", b.conversation);
    this.db().exec("DELETE FROM pi_calls WHERE conversation = ?", b.conversation);
    this.bindings.delete(b.conversation);
    this.install();
  }

  /** Rebuilds the sessions still running after a wake, before Pi resumes them. */
  private async restore() {
    if (this.restored) return;
    this.restored = true;
    // A session whose recipe cannot be rebuilt now is skipped, not fatal: the harness still opens for the others, and
    // the session is rebuilt on its next section or call.
    for (const row of this.db().exec<Row>("SELECT * FROM pi_bindings WHERE active = 1").toArray()) {
      try { await this.bound(row.conversation); }
      catch (error) { console.error(JSON.stringify({ event: "pi-restore", conversation: row.conversation, kind: row.kind, error: error instanceof Error ? error.message : String(error) })); }
    }
    this.install();
  }

  private async bound(conversation: string, anyState = false): Promise<Binding | undefined> {
    const held = this.bindings.get(conversation);
    if (held) return held;
    const row = this.db().exec<Row>(`SELECT * FROM pi_bindings WHERE conversation = ?${anyState ? "" : " AND active = 1"}`, conversation).toArray()[0];
    if (!row || !this.loaders[row.kind]) return undefined;
    const spec = JSON.parse(row.spec) as unknown;
    const loaded = await this.loaders[row.kind]!(spec);
    // Another hook or startup may have bound this conversation while its loader awaited D1.
    // Share that live state instead of replacing it with the snapshot read before the await.
    const current = this.bindings.get(conversation);
    if (current) return current;
    const state = unpackState<unknown>(row.state);
    loaded.hydrate?.(state);
    const b = this.bind({ conversation, session: row.session, operationId: row.operation_id, kind: row.kind, spec, loaded, state,
      startedAt: row.started_at, turns: row.turns, quiet: row.quiet, lastRound: !!row.last_round, capped: !!row.capped, finished: !!row.finished, asked: row.asked,
      round: row.round ? JSON.parse(row.round) as RoundCall[] : [], requestAt: 0, spent: row.spent ?? 0, reservedAt: row.reserved_at });
    if (!anyState) this.install();
    return b;
  }

  private bind(fields: Omit<Binding, "tools" | "system" | "said">): Binding {
    const { recipe, input } = fields.loaded;
    const tools = recipe.tools(fields.state).filter((t) => recipe.policy.allow.includes(t.name));
    const native = tools.some((t) => t.nativeSearch);
    const b: Binding = { ...fields, tools, system: recipe.system(input) + (native ? `\n${NATIVE_SEARCH_INSTRUCTION.replace("native web_search", WEB_SEARCH)}` : ""), said: "" };
    this.bindings.set(b.conversation, b);
    this.install();
    return b;
  }

  private persist(b: Binding) {
    this.db().exec("UPDATE pi_bindings SET state = ?, turns = ?, quiet = ?, last_round = ?, capped = ?, finished = ?, asked = ?, round = ?, spent = ?, reserved_at = ? WHERE conversation = ?",
      packState(b.state), b.turns, b.quiet, b.lastRound ? 1 : 0, b.capped ? 1 : 0, b.finished ? 1 : 0, b.asked, JSON.stringify(b.round), b.spent, b.reservedAt, b.conversation);
  }

  private trail(b: Binding, entry: TurnRecord) {
    try { b.loaded.record?.(entry); } catch { /* A trail write never fails a call. */ }
    this.db().exec("INSERT INTO pi_trail (conversation, seq, entry) VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM pi_trail WHERE conversation = ?), ?)",
      b.conversation, b.conversation, JSON.stringify(entry));
  }

  /** The tools, prompt and hooks of every running session; Pi reads the registry at each request. */
  private install() {
    const tools = new Map<string, ToolRegistration>();
    for (const b of this.bindings.values()) for (const t of b.tools) {
      const name = t.nativeSearch ? WEB_SEARCH : t.name;
      if (tools.has(name)) continue;
      const parameters = t.nativeSearch
        ? { type: "object", properties: { query: { type: "string", description: "What to search the web for." } }, required: ["query"], additionalProperties: false }
        : toolSchema(t).input_schema;
      tools.set(name, {
        name, description: t.nativeSearch ? "Search the web (never for SEC filings). Results become source IDs you can read." : t.description,
        parameters, replay: "safe", prepareArguments: parseArgs as never,
        execute: async (args: unknown, api: { conversationId: ConversationId; callId: string }, context: { abortSignal?: AbortSignal }) =>
          this.call(String(api.conversationId), api.callId, name, args, context.abortSignal ?? new AbortController().signal),
      } as unknown as ToolRegistration);
    }
    this.registry.install({
      name: "spontra",
      sections: [{ key: "recipe", tag: false, render: async (input: { conversationId: ConversationId }) => (await this.bound(String(input.conversationId)))?.system }],
      tools: [...tools.values()],
      hooks: [hook(GenerationTask, {
        beforeRequest: async (_request: unknown, api: { conversationId: ConversationId }) => { await this.guard(() => this.beforeRequest(String(api.conversationId))); return undefined; },
        beforeProviderRequest: async (request: { payload: unknown }, api: { conversationId: ConversationId }) => {
          const b = await this.bound(String(api.conversationId));
          this.assertRunning();
          return b ? { payload: shapePayload(request.payload, b.loaded.effort) } : undefined;
        },
        afterResponse: async (message: PiAssistant, api: { conversationId: ConversationId }) => { await this.guard(() => this.afterResponse(String(api.conversationId), message)); },
        onYield: async (answer: PiAssistant, api: { conversationId: ConversationId }) => this.onYield(String(api.conversationId), answer),
        afterRun: async (_run: unknown, api: { conversationId: ConversationId }) => {
          const b = this.bindings.get(String(api.conversationId));
          if (b) {
            // A recipe with its own ending has nobody coming to settle it, so its session closes here.
            // What the ending did to the state (a document the harness delivered) is kept for whoever settles the run.
            if (b.loaded.recipe.afterRun) {
              this.ending.add(b.conversation);
              try { await this.guard(async () => { await b.loaded.recipe.afterRun!(b.state); }); this.persist(b); await this.close(b); }
              finally { this.ending.delete(b.conversation); }
            }
            this.options.onSettled?.(b.operationId);
          }
          return undefined;
        },
      } as never), hook(CompactionTask, {
        beforeCompact: async (compaction: { reason: string; entries: readonly unknown[] }, api: { conversationId: ConversationId }) => {
          await this.guard(async () => {
            const b = await this.bound(String(api.conversationId));
            if (b) this.trail(b, { turn: b.turns, thought: "", action: "compaction", input: compaction.reason, observation: `${compaction.entries.length} entries summarised.` });
          });
          return undefined;
        },
      } as never)],
    } as never);
  }

  private async guard(work: () => Promise<void>) {
    try { await work(); } catch (error) { console.error(JSON.stringify({ event: "pi-host", error: error instanceof Error ? error.message : String(error) })); }
  }

  /** One model request: the turn is counted, and whether the round it brings is the last is decided now. */
  private async beforeRequest(conversation: string) {
    const b = await this.bound(conversation);
    if (!b) return;
    // Provider retries can arrive without a preceding tool round or yield.
    if (b.reservedAt === null && b.loaded.reserve && !await b.loaded.reserve(b.state, Date.now())) {
      b.lastRound = true;
      b.capped = true;
    }
    b.reservedAt = null;
    b.turns++;
    b.loaded.recipe.onTurn?.(b.state, b.turns);
    b.round = [];
    b.requestAt = Date.now();
    this.traces.beginTurn(b, b.loaded.model, b.turns);
    this.db().exec("DELETE FROM pi_calls WHERE conversation = ?", conversation);
    const { budget } = b.loaded.recipe;
    if (b.turns >= budget.turns || Date.now() - b.startedAt > budget.wallMs || (budget.tokens !== undefined && b.spent >= budget.tokens)) b.lastRound = true;
    this.persist(b);
  }

  private async afterResponse(conversation: string, message: PiAssistant) {
    const b = await this.bound(conversation);
    if (!b) return;
    b.said = (message.content ?? []).flatMap((c) => c.type === "text" && typeof c.text === "string" ? [c.text] : []).join(" ").trim();
    b.round = (message.content ?? []).flatMap((c) => c.type === "toolCall" && typeof c.id === "string" && typeof c.name === "string" ? [{ id: c.id, name: c.name, args: parseArgs(c.arguments) }] : []);
    const durationMs = b.requestAt ? Date.now() - b.requestAt : 0;
    const u = message.usage ?? {};
    b.spent += (u.input ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
    this.persist(b);
    const failed = message.stopReason === "error" || message.stopReason === "aborted";
    this.traces.endChat(b.conversation, { inputTokens: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), outputTokens: u.output ?? 0, cacheReadTokens: u.cacheRead ?? 0, cacheCreationTokens: u.cacheWrite ?? 0, ...(message.stopReason ? { finishReason: String(message.stopReason) } : {}), error: failed });
    if (!b.round.length) this.traces.endTurn(b.conversation);
    if (failed) this.trail(b, { turn: b.turns, thought: "", action: "invalid", input: "", observation: String(message.errorMessage ?? message.stopReason).slice(0, 1000) });
    await recordAiUsage(this.env, aiUsageFromMetrics({
      stage: `${b.loaded.ledger.kind}-t${b.turns}`, model: b.loaded.model, mode: "pi-turn", finishReason: message.stopReason,
      usage: { input_tokens: u.input ?? 0, output_tokens: u.output ?? 0, cache_read_input_tokens: u.cacheRead ?? 0, cache_creation_input_tokens: u.cacheWrite ?? 0 },
      ...(failed ? { error: String(message.errorMessage ?? message.stopReason).slice(0, 200) } : {}),
    }, { at: new Date(Date.now() - durationMs).toISOString(), durationMs, provider: "deepseek", ...b.loaded.ledger }));
  }

  /** A reply that called no tool: nudged twice at most, as the loop did, unless the run has nothing left. */
  private async onYield(conversation: string, answer: PiAssistant) {
    const b = await this.bound(conversation);
    if (!b || b.finished || b.lastRound) return undefined;
    this.trail(b, { turn: b.turns, thought: b.said, action: "none", input: "", observation: "The reply called no tool." });
    if (++b.quiet >= 2) { this.persist(b); return undefined; }
    this.persist(b);
    void answer;
    await this.reserveNext(b);
    return b.lastRound ? undefined : { continue: b.loaded.recipe.nudge };
  }

  /**
   * One call of a round. The round's first call runs every call of the round in order, as the loop did, so whether the
   * round settles the recipe is known before any call answers, and every call of a settling round terminates. Each
   * outcome is stored, so a call Pi replays after an eviction is answered without running again.
   */
  private async call(conversation: string, callId: string, name: string, args: unknown, signal: AbortSignal) {
    const b = await this.bound(conversation);
    if (!b) return { output: text("This session has ended."), isError: true, control: { terminate: true } };
    const listed = b.round.some((c) => c.id === callId);
    // A call missing from the round as recorded (a reply recorded before an eviction lost it) runs on its own.
    if (!listed) b.round = [...b.round, { id: callId, name, args }];
    const outcomes = await this.runRound(b, signal, listed ? undefined : { id: callId, args });
    const outcome = outcomes.get(callId) ?? { observation: "Not run.", error: true };
    const terminate = b.finished || b.lastRound;
    const left = b.loaded.recipe.budget.turns - b.turns;
    const budgetLine = terminate ? "" : `\n\n${b.loaded.recipe.budgetLine?.(b.state, left) ?? defaultBudgetLine(left)}`;
    return { output: text(`${fitResult(outcome.observation, b.loaded.recipe.resultChars)}${budgetLine}`), ...(outcome.error ? { isError: true } : {}), ...(terminate ? { control: { terminate: true } } : {}) };
  }

  private async runRound(b: Binding, signal: AbortSignal, own?: { id: string; args: unknown }): Promise<Map<string, ToolOutcome>> {
    const stored = new Map(this.db().exec<{ call_id: string; outcome: string }>("SELECT call_id, outcome FROM pi_calls WHERE conversation = ?", b.conversation)
      .toArray().map((r) => [r.call_id, JSON.parse(r.outcome) as ToolOutcome]));
    for (const [index, call] of b.round.entries()) {
      this.assertRunning();
      signal.throwIfAborted();
      if (stored.has(call.id)) continue;
      const args = own?.id === call.id ? own.args : call.args;
      let outcome: ToolOutcome;
      if (b.finished) outcome = { observation: "Not run: the analysis is already settled." };
      else if (index >= (b.loaded.recipe.callsPerTurn ?? CALLS_PER_TURN)) outcome = { observation: `Not run: at most ${b.loaded.recipe.callsPerTurn ?? CALLS_PER_TURN} calls run per turn; call it again.`, error: true };
      else {
        b.loaded.onToolStart?.(call.name, args);
        outcome = await this.traces.tool(b, call.name, call.id, () => call.name === WEB_SEARCH ? this.search(b, args, signal)
          : runTool(b.tools, b.loaded.recipe.policy, { name: call.name, input: args }, { state: b.state, signal, recipe: b.loaded.recipe.id, stage: (_n, work) => work() }));
      }
      if (outcome.asked) { b.asked = outcome.asked; outcome = { observation: "Waiting for the reader to confirm." }; }
      if (b.asked || b.loaded.recipe.settled(b.state)) b.finished = true;
      b.quiet = 0;
      this.trail(b, { turn: b.turns, thought: index === 0 ? b.said : "", action: call.name.slice(0, 40), input: JSON.stringify(args ?? {}).slice(0, 4000), observation: outcome.observation.slice(0, outcome.error ? 12_000 : 4000), ...(outcome.error ? { failed: true } : {}) });
      this.db().exec("INSERT OR REPLACE INTO pi_calls (conversation, call_id, outcome) VALUES (?, ?, ?)", b.conversation, call.id, JSON.stringify(outcome));
      this.persist(b);
      stored.set(call.id, outcome);
    }
    await this.reserveNext(b);
    this.traces.endTurn(b.conversation);
    return stored;
  }

  /** Reserve only after a round needs another request; a settling round spends no extra allowance. */
  private async reserveNext(b: Binding) {
    if (b.finished || b.lastRound || b.reservedAt !== null || !b.loaded.reserve) return;
    const reservedAt = Date.now();
    if (await b.loaded.reserve(b.state, reservedAt)) b.reservedAt = reservedAt;
    else { b.lastRound = true; b.capped = true; }
    this.persist(b);
  }

  /** The web search the native server tool did, as a client call to DeepSeek's search API, fed to the recipe's search tool. */
  private async search(b: Binding, args: unknown, signal: AbortSignal): Promise<ToolOutcome> {
    const native = b.tools.find((t) => t.nativeSearch)!;
    if (native.nativeSearch!.remaining(b.state) <= 0) return { observation: "No web searches are left; use the sources you have.", error: true };
    const query = typeof (args as { query?: unknown })?.query === "string" ? (args as { query: string }).query : "";
    let batch: { query: string; hits: unknown[]; error: string | null };
    try {
      if (!this.env.DEEPSEEK_API_KEY) throw new Error("search is not configured");
      const ledger = b.loaded.ledger;
      const provider = new DeepSeekWebProvider({
        apiKey: this.env.DEEPSEEK_API_KEY,
        signal,
        record: (call) => recordAiUsage(this.env, aiUsageFromMetrics({ stage: call.stage, model: "search-fetch-api", ...(call.error ? { error: call.error } : {}) },
          { at: new Date(Date.now() - call.durationMs).toISOString(), durationMs: call.durationMs, provider: "deepseek", kind: ledger.kind, searchCalls: call.searchCalls,
            ...(ledger.ticker ? { ticker: ledger.ticker } : {}), ...(ledger.runId ? { runId: ledger.runId } : {}), ...(ledger.userHash ? { userHash: ledger.userHash } : {}), ...(ledger.conversationId ? { conversationId: ledger.conversationId } : {}) })),
      });
      const data = await provider.search({ query, maxResults: 8, excludeDomains: [SEC_DOMAIN, ...native.nativeSearch!.excluded ?? []] });
      batch = { query, hits: data.results.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet, publishedAt: h.publishedAt ?? null, score: h.score ?? null })), error: null };
    } catch (error) {
      batch = { query, hits: [], error: `Web search failed (${error instanceof Error ? error.message.slice(0, 120) : "error"}); use another query or existing sources.` };
    }
    signal.throwIfAborted();
    return runTool(b.tools, b.loaded.recipe.policy, { name: native.name, input: batch }, { state: b.state, signal, recipe: b.loaded.recipe.id, stage: (_n, work) => work() });
  }
}

type PiAssistant = { content?: Array<{ type: string; text?: unknown; id?: unknown; name?: unknown; arguments?: unknown }>; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  stopReason?: string; errorMessage?: string };
