import { Agent } from "agents";
import type { AnalysisEnv } from "../operations.ts";
import { withRuns, type RunKind } from "./binding.ts";
import { invoke, type Journal, type RunState, type RunStatus, type StepRecord } from "./engine.ts";
import { RUN_TASKS } from "./tasks.ts";
import { companyPolicyEnvironment } from "../financial-data/company-policy.ts";
import { PiHost, type PiLoader } from "../pi/host.ts";
import { piModelIds } from "../pi/model.ts";
import type { PiRuns } from "../pi/runs.ts";
import { itemsLoader } from "../items/workflow.ts";
import { reportLoader } from "../stage/report-workflow.ts";
import { valuationLoader } from "../valuation/workflow.ts";
import { lensLoader } from "../lens/pi.ts";
import { checkupLoader } from "../checkup/workflow.ts";
import { analystLoader } from "../analyst/workflow.ts";
import { treeLoader } from "../business-tree/workflow.ts";
import { businessLoader } from "../company-analysis-workflow.ts";
import { reportLoader as secReportLoader } from "../sec/report-agent.ts";

type RunRow = { kind: RunKind; id: string; params: string; created_at: number; status: RunStatus; error: string | null; output: string | null };
/** What a connected client (the admin, a chat) sees of the run, kept current with every wake. */
export type RunView = { kind: RunKind | null; id: string | null; status: RunStatus | null; step: string | null; updatedAt: string | null };
const FINAL = new Set<RunStatus>(["complete", "errored", "terminated"]);
const OUTPUT_LIMIT = 1024 * 1024;
/** Longer than one invocation can live, so the wake set before a run only fires if that invocation died or hung. */
const WATCHDOG_MS = 16 * 60_000;

/**
 * One durable run on the Agents SDK: the task's params, its status and its step journal in this Agent's SQLite, and
 * the Agent's durable schedule as the only thing that advances it. Every wake replays the task from the top against
 * the journal (engine.ts); a wake that dies without finishing is retried by the schedule.
 */
export class TaskRunner extends Agent<Env, RunView> {
  initialState: RunView = { kind: null, id: null, status: null, step: null, updatedAt: null };
  private readonly cache = new Map<string, StepRecord>();
  private busySince = 0;
  private rewake = false;
  private tables = false;
  /** The run's agent sessions: each recipe run (an item, a report, a valuation loop, a lens) is a Pi session here. */
  private readonly pi = new PiHost({ sql: this.ctx.storage.sql, env: this.env }, this.loaders(), {
    models: () => piModelIds(this.env as unknown as AnalysisEnv),
    // A session that ended wakes the run, which is waiting on it, without waiting for its next check.
    onSettled: () => { void this.wake(Date.now()); },
  });
  private readonly piInstalled = this.lifecycle.use(this.pi.harness);

  private loaders(): Record<string, PiLoader> {
    const env = () => companyPolicyEnvironment(this.taskEnv());
    return {
      items: async spec => itemsLoader(spec, await env()),
      "sec-report": async spec => secReportLoader(spec, await env()),
      valuation: async spec => valuationLoader(spec, await env()),
      lens: async spec => lensLoader(spec, await env()),
      checkup: async spec => checkupLoader(spec, await env()),
      analyst: async spec => analystLoader(spec, await env()),
      tree: async spec => treeLoader(spec, await env()),
      business: async spec => businessLoader(spec, await env()),
      report: async spec => reportLoader(spec, await env()),
    };
  }

  /** The env a task runs with: the run bindings, and this run's Pi sessions. */
  private taskEnv(): AnalysisEnv {
    const runs: PiRuns = { start: (kind, spec, opening, options) => this.pi.start(kind, spec, opening, options), poll: operationId => this.pi.poll(operationId) };
    return { ...withRuns(this.env as unknown as AnalysisEnv), PI: runs };
  }

  private db() {
    if (!this.tables) {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS run (k INTEGER PRIMARY KEY CHECK (k = 1), kind TEXT NOT NULL, id TEXT NOT NULL, params TEXT NOT NULL,
        created_at INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, output TEXT, updated_at INTEGER NOT NULL,
        wake_id TEXT, wake_at INTEGER)`);
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS steps (name TEXT PRIMARY KEY, record TEXT NOT NULL)");
      this.tables = true;
    }
    return this.ctx.storage.sql;
  }

  private row(): RunRow | undefined {
    return this.db().exec<RunRow>("SELECT kind, id, params, created_at, status, error, output FROM run WHERE k = 1").toArray()[0];
  }

  private setStatus(status: RunStatus, fields: { error?: string; output?: string; step?: string | null } = {}) {
    this.db().exec("UPDATE run SET status = ?, error = ?, output = ?, updated_at = ? WHERE k = 1", status, fields.error ?? null, fields.output ?? null, Date.now());
    this.setState({ ...this.state, status, ...(fields.step !== undefined ? { step: fields.step } : {}), updatedAt: new Date().toISOString() });
  }

  async start(kind: RunKind, id: string, params: unknown, createdAt: number): Promise<void> {
    if (this.row()) throw new Error(`instance.already_exists: ${kind} ${id}`);
    this.db().exec("INSERT INTO run (k, kind, id, params, created_at, status, updated_at) VALUES (1, ?, ?, ?, ?, 'queued', ?)",
      kind, id, JSON.stringify(params ?? null), createdAt, Date.now());
    this.setState({ kind, id, status: "queued", step: null, updatedAt: new Date().toISOString() });
    await this.wake(Date.now());
  }

  async status(): Promise<RunState> {
    const row = this.row();
    if (!row) throw new Error("instance.not_found");
    return { status: row.status, ...(row.error ? { error: JSON.parse(row.error) } : {}), ...(row.output ? { output: JSON.parse(row.output) } : {}) };
  }

  /** The run's state and what each of its agent sessions did, turn by turn. */
  async report() {
    const row = this.row();
    return { status: row?.status ?? null, error: row?.error ? JSON.parse(row.error) as unknown : null, step: this.state.step, updatedAt: this.state.updatedAt, sessions: this.pi.sessionsReport() };
  }

  async terminate(): Promise<void> {
    const row = this.row();
    if (!row || FINAL.has(row.status)) return;
    this.setStatus("terminated", { error: JSON.stringify({ name: "Terminated", message: "terminated" }) });
    for (const schedule of this.getSchedules()) await this.cancelSchedule(schedule.id);
  }

  /**
   * The run's next wake. One wake is pending at a time: an earlier one already pending stands, a later one is replaced,
   * so a session that settles early brings the wake forward instead of starting a second chain of wakes.
   */
  private async wake(at: number): Promise<void> {
    const pending = this.db().exec<{ wake_id: string | null; wake_at: number | null }>("SELECT wake_id, wake_at FROM run WHERE k = 1").toArray()[0];
    if (!pending) return;
    if (pending.wake_id && pending.wake_at !== null && pending.wake_at <= at) return;
    if (pending.wake_id) await this.cancelSchedule(pending.wake_id).catch(() => false);
    const schedule = await this.schedule(new Date(at), "advance");
    this.db().exec("UPDATE run SET wake_id = ?, wake_at = ? WHERE k = 1", schedule.id, at);
  }

  /** One wake: replays the task, runs what is due, and schedules the next wake or records how the run ended. */
  async advance(): Promise<void> {
    // The wake that is due is this one; a later one still pending keeps its place.
    this.db().exec("UPDATE run SET wake_id = NULL, wake_at = NULL WHERE k = 1 AND wake_at <= ?", Date.now());
    const row = this.row();
    if (!row || FINAL.has(row.status)) return;
    // A wake that arrives while one runs (a session settled meanwhile) is taken up when that one ends.
    if (this.busySince && Date.now() - this.busySince < WATCHDOG_MS) { this.rewake = true; return; }
    this.busySince = Date.now();
    this.rewake = false;
    try {
      await this.wake(Date.now() + WATCHDOG_MS);
      this.setStatus("running");
      const task = RUN_TASKS[row.kind];
      const env = this.taskEnv();
      const params = JSON.parse(row.params) as never;
      const outcome = await invoke(this.journal(), (step) => task(params, { env, step, id: row.id, timestamp: new Date(row.created_at) }));
      // Terminated while the step ran: the outcome is dropped.
      if (this.row()?.status === "terminated") return;
      if (outcome.kind === "yield") {
        this.setStatus(outcome.waiting ? "waiting" : "running");
        await this.wake(this.rewake ? Date.now() : outcome.at);
      } else if (outcome.kind === "complete") {
        const output = JSON.stringify(outcome.output ?? null);
        this.setStatus("complete", { output: output.length > OUTPUT_LIMIT ? JSON.stringify({ truncated: true }) : output, step: null });
        this.cache.clear();
      } else {
        this.setStatus("errored", { error: JSON.stringify(outcome.error) });
        console.error(JSON.stringify({ event: "run-errored", kind: row.kind, id: row.id, error: outcome.error.message.slice(0, 500) }));
      }
    } finally { this.busySince = 0; }
  }

  private journal(): Journal {
    return {
      step: (name) => {
        const cached = this.cache.get(name);
        if (cached) return cached;
        const stored = this.db().exec<{ record: string }>("SELECT record FROM steps WHERE name = ?", name).toArray()[0];
        const record = stored ? JSON.parse(stored.record) as StepRecord : undefined;
        if (record) this.cache.set(name, record);
        return record;
      },
      save: (record) => {
        this.db().exec("INSERT OR REPLACE INTO steps (name, record) VALUES (?, ?)", record.name, JSON.stringify(record));
        this.cache.set(record.name, record);
        if (record.done) this.setState({ ...this.state, step: record.name, updatedAt: new Date().toISOString() });
      },
    };
  }
}
