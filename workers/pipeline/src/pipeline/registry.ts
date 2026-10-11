/**
 * The pipeline's event graph (docs/pipeline-events.md): the events that exist, which tasks subscribe to each, and
 * what every task and source emits. Pure data, so the build checks it without the Workers runtime
 * (`scripts/check-pipeline-boundary.ts`). Adding a downstream task is a row here plus its implementation in
 * `tasks.ts`; no queue, marker or Cron.
 */
export const EVENT_TYPES = [
  "filing.discovered", "company.added", "maintenance.requested",
  "financials.published", "filing.archived", "archive.superseded", "archive.prune.requested",
  "map.derived", "report.published", "analysis.published", "fundamentals.updated", "guidance.published",
  "task.version_changed",
  "transcript.stored", "explainer.published", "tree.published", "findings.published", "events.published",
] as const;
export type EventType = typeof EVENT_TYPES[number];

export const TASK_NAMES = ["map-derive", "archive-prune", "archive-prune-scan"] as const;
export type TaskName = typeof TASK_NAMES[number];

/** What a filing event says about the filing, for subscribers that only want some forms. */
export type EventDetail = { form?: string; items?: string; accession?: string };
export type PipelineEvent = { type: EventType; ticker: string; cik?: string | null; task?: TaskName | null; detail?: EventDetail | null };

/** Which companies a task runs for when its version changes: every data company, the AI list, or once globally. */
export type TaskScope = "data" | "ai" | "tree" | "global";
export type TaskMeta = {
  emits: readonly EventType[];
  /** Triggers inside this window push the run back, never beyond `maxWaitMs` after the first. */
  debounceMs: number;
  maxWaitMs: number;
  scope: TaskScope;
};

const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE;
export const TASKS: Record<TaskName, TaskMeta> = {
  // Rebuilds the map's older quarters and capital snapshot from archived filings.
  "map-derive": { emits: ["map.derived"], debounceMs: 30 * SECOND, maxWaitMs: 5 * MINUTE, scope: "data" },
  // Deletes archive copies replaced by a newer one, a day after the replacement.
  "archive-prune": { emits: [], debounceMs: 24 * HOUR, maxWaitMs: 24 * HOUR, scope: "data" },
  // A full pass over the archive for copies left behind before replacements were recorded; admin-requested.
  "archive-prune-scan": { emits: [], debounceMs: 0, maxWaitMs: 0, scope: "global" },
};

export type Subscription = { task: TaskName; when?: (event: PipelineEvent) => boolean };
export const SUBSCRIPTIONS: Partial<Record<EventType, readonly Subscription[]>> = {
  "financials.published": [{ task: "map-derive" }],
  "filing.archived": [{ task: "map-derive" }],
  "archive.superseded": [{ task: "archive-prune" }],
  "archive.prune.requested": [{ task: "archive-prune-scan" }],
};

/** Emitters that are not tasks. `task.version_changed` is routed to the one task it names, never subscribed. */
export const SOURCES: Record<string, readonly EventType[]> = {
  // Financial collection and archiving still run on the two-minute Cron until they become tasks (P2).
  "financial-data": ["financials.published", "filing.archived", "archive.superseded"],
  "admin": ["archive.prune.requested"],
  "invocation": ["task.version_changed"],
};

/** Every problem with the graph: a subscription nobody can trigger, an unknown name, or a loop between tasks. */
export function validateRegistry(): string[] {
  const errors: string[] = [];
  const emitted = new Set<EventType>([...Object.values(SOURCES).flat(), ...TASK_NAMES.flatMap(task => TASKS[task].emits)]);
  for (const [type, subscriptions] of Object.entries(SUBSCRIPTIONS) as Array<[EventType, readonly Subscription[]]>) {
    if (!EVENT_TYPES.includes(type)) errors.push(`unknown event ${type}`);
    if (type === "task.version_changed") errors.push("task.version_changed is routed by name and cannot be subscribed");
    if (!emitted.has(type)) errors.push(`${type} is subscribed but nothing emits it`);
    for (const { task } of subscriptions) if (!TASK_NAMES.includes(task)) errors.push(`${type} subscribes unknown task ${task}`);
  }
  for (const task of TASK_NAMES) {
    const meta = TASKS[task];
    if (meta.maxWaitMs < meta.debounceMs) errors.push(`${task} waits less than its debounce`);
    if (meta.maxWaitMs > 24 * HOUR) errors.push(`${task} waits longer than a queue message can be delayed`);
  }
  // A task's emitted events lead to the tasks subscribed to them; any path back to the start is a loop.
  const next = (task: TaskName) => TASKS[task].emits.flatMap(type => (SUBSCRIPTIONS[type] ?? []).map(s => s.task));
  const visit = (task: TaskName, path: TaskName[]): void => {
    if (path.includes(task)) { errors.push(`loop: ${[...path, task].join(" → ")}`); return; }
    for (const child of new Set(next(task))) visit(child, [...path, task]);
  };
  for (const task of TASK_NAMES) visit(task, []);
  return [...new Set(errors)];
}
