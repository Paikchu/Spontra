import type { AiRunKind } from '../../../../shared/analysis-contract/ai-runs-admin.ts';
import type { BusinessMapFlow, FeatureRunProgress, FlowEdge, FlowNode, FlowNodeState } from '../../../../shared/analysis-contract/business-map-admin.ts';
import { SOURCES, SUBSCRIPTIONS, TASKS, type EventType, type TaskName } from '../pipeline/registry.ts';
import { AiRunStore } from '../ai-runs/store.ts';

/**
 * The tasks the admin's flow graph draws: the financial map's chain and the reader-facing features fed from it. Library
 * indexing, tags, peers, translation and storage housekeeping run beside them and are left out; an edge needs both ends drawn.
 */
export const FLOW_TASKS = [
  'maintenance', 'collect', 'history', 'map-derive', 'library', 'events', 'sec-report', 'guidance', 'company-analysis',
  'findings', 'analyst', 'checkup', 'items', 'explainer', 'tree', 'valuation',
] as const satisfies readonly TaskName[];
const FLOW_SOURCES = ['sec-discovery', 'admin'] as const;
/** The model Workflows whose steps the AI run store records. */
const RUN_KIND: Partial<Record<TaskName, AiRunKind>> = { guidance: 'guidance', findings: 'findings', analyst: 'analyst', checkup: 'checkup', explainer: 'explainer', tree: 'tree', valuation: 'valuation' };
/** A Workflow task answers `later` while it polls its run; one not heard of for this long is not counted as running. */
const RUNNING_WINDOW_MS = 2 * 3600_000;

/** The drawn part of the event registry: an edge per pair of drawn nodes an event links, with the events it carries. */
export function flowGraph(): { nodes: Array<{ id: string; source: boolean; depth: number }>; edges: FlowEdge[] } {
  const drawn = new Set<string>([...FLOW_SOURCES, ...FLOW_TASKS]);
  const emits = (id: string): readonly EventType[] => (SOURCES[id] ?? TASKS[id as TaskName]?.emits ?? []);
  const edges = new Map<string, FlowEdge>();
  for (const from of drawn) for (const event of emits(from)) for (const { task } of SUBSCRIPTIONS[event] ?? []) {
    if (!drawn.has(task) || task === from) continue;
    const key = `${from}>${task}`, edge = edges.get(key) ?? { from, to: task, events: [] };
    if (!edge.events.includes(event)) edge.events.push(event);
    edges.set(key, edge);
  }
  // The registry is acyclic (validateRegistry), so the longest chain into each node settles.
  const depth = new Map<string, number>([...drawn].map(id => [id, 0]));
  for (let changed = true, round = 0; changed && round < drawn.size; round++) {
    changed = false;
    for (const { from, to } of edges.values()) if (depth.get(to)! < depth.get(from)! + 1) { depth.set(to, depth.get(from)! + 1); changed = true; }
  }
  return { nodes: [...drawn].map(id => ({ id, source: (FLOW_SOURCES as readonly string[]).includes(id), depth: depth.get(id)! })), edges: [...edges.values()] };
}

type LogRow = { messageId: string; causeId: string | null; kind: string; name: string; outcome: string; createdAt: string };
type RunRow = { runId: string; status: string; stage: string | null; startedAt: string; updatedAt: string };

/** The source that emits an event with no cause: the admin's own requests first, the EDGAR poll for what only it sends. */
const sourceOf = (event: string) => FLOW_SOURCES.slice().reverse().find(source => (SOURCES[source] as readonly string[]).includes(event)) ?? null;
const MAINTENANCE_STATE: Record<string, FlowNodeState> = { queued: 'queued', running: 'running', cancel_requested: 'running', succeeded: 'done', partial: 'done', failed: 'failed' };

/**
 * Each drawn node's state for one company. A task is running while a model run of it is in flight, or while its due row
 * stays and its last log entry is the Workflow being polled (`later`); queued while its due row waits; otherwise as its
 * last run ended. `via` follows the cause recorded with the run back to the event and the task or source that sent it.
 * The maintenance task runs globally, so its node reads the company's own maintenance task instead.
 */
export async function readFlow(db: D1Database, ticker: string, now = Date.now()): Promise<BusinessMapFlow> {
  const graph = flowGraph();
  const store = new AiRunStore(db);
  const recent = new Date(now - RUNNING_WINDOW_MS).toISOString();
  const [due, log, runs, job, maintenance] = await Promise.all([
    db.prepare("SELECT task, due_at dueAt, first_requested_at firstAt, cause_id causeId FROM pipeline_due WHERE ticker = ?").bind(ticker)
      .all<{ task: string; dueAt: string; firstAt: string; causeId: string | null }>().then(r => r.results).catch(() => []),
    db.prepare("SELECT message_id messageId, cause_id causeId, kind, name, outcome, created_at createdAt FROM pipeline_log WHERE ticker = ? ORDER BY created_at DESC LIMIT 400").bind(ticker)
      .all<LogRow>().then(r => r.results).catch(() => [] as LogRow[]),
    store.latestRuns().catch(() => new Map<string, RunRow>()),
    db.prepare("SELECT current_stage stage, created_at startedAt, updated_at at FROM sec_analysis_jobs WHERE ticker = ? AND status = 'running' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1")
      .bind(ticker, recent).first<{ stage: string; startedAt: string; at: string }>().catch(() => null),
    db.prepare("SELECT status, created_at createdAt, updated_at updatedAt FROM financial_maintenance_tasks WHERE ticker = ? ORDER BY created_at DESC LIMIT 1").bind(ticker)
      .first<{ status: string; createdAt: string; updatedAt: string }>().catch(() => null),
  ]);
  const byMessage = new Map(log.map(row => [row.messageId, row]));
  const via = (causeId: string | null): FlowNode['via'] => {
    let row = causeId ? byMessage.get(causeId) : undefined;
    // A Workflow polled again names the previous message of its run as the cause; the event is at the start of that chain.
    for (let hop = 0; row && row.kind === 'task' && hop < 50; hop++) row = row.causeId ? byMessage.get(row.causeId) : undefined;
    if (!row) return null;
    const from = row.causeId ? byMessage.get(row.causeId)?.name ?? null : sourceOf(row.name);
    return from ? { from, event: row.name } : null;
  };
  const latest = new Map<string, LogRow>(), ended = new Map<string, LogRow>();
  for (const row of log) {
    if (row.kind !== 'task') continue;
    if (!latest.has(row.name)) latest.set(row.name, row);
    if ((row.outcome === 'done' || row.outcome === 'failed') && !ended.has(row.name)) ended.set(row.name, row);
  }
  const dueBy = new Map(due.map(row => [row.task, row]));
  const progressOf = async (task: string): Promise<FeatureRunProgress | null> => {
    if (task === 'sec-report' && job) return { kind: 'report', status: 'running', stage: job.stage, steps: [], startedAt: job.startedAt, updatedAt: job.at };
    const kind = RUN_KIND[task as TaskName], run = kind ? runs.get(`${kind}:${ticker}`) : undefined;
    if (!kind || !run || (run.status !== 'running' && run.status !== 'waiting')) return null;
    const full = await store.get(kind, ticker, run.runId).catch(() => null);
    return { kind, status: run.status, stage: run.stage, steps: full?.log ?? [], startedAt: run.startedAt, updatedAt: run.updatedAt };
  };
  const nodes = await Promise.all(graph.nodes.map(async (node): Promise<FlowNode> => {
    if (node.source) {
      const sent = log.find(row => row.kind === 'event' && !row.causeId && sourceOf(row.name) === node.id);
      return { ...node, state: sent ? 'done' : 'idle', at: sent?.createdAt ?? null, via: null, progress: null };
    }
    if (node.id === 'maintenance') {
      const state = maintenance ? MAINTENANCE_STATE[maintenance.status] ?? 'idle' : 'idle';
      return { ...node, state, at: maintenance ? (state === 'running' || state === 'queued' ? maintenance.createdAt : maintenance.updatedAt) : null,
        via: maintenance ? { from: 'admin', event: 'maintenance.requested' } : null, progress: null };
    }
    const waiting = dueBy.get(node.id), last = latest.get(node.id), end = ended.get(node.id);
    const progress = await progressOf(node.id);
    const polled = !!waiting && last?.outcome === 'later' && now - Date.parse(last.createdAt) < RUNNING_WINDOW_MS;
    const state: FlowNodeState = progress || polled ? 'running' : waiting ? 'queued' : end ? (end.outcome === 'failed' ? 'failed' : 'done') : 'idle';
    const at = state === 'running' ? progress?.startedAt ?? waiting?.firstAt ?? null : state === 'queued' ? waiting!.dueAt : end?.createdAt ?? null;
    return { ...node, state, at, via: via(waiting?.causeId ?? end?.causeId ?? null), progress };
  }));
  return { ticker, nodes, edges: graph.edges };
}
