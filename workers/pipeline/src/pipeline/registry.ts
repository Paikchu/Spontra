/**
 * The pipeline's event graph (docs/pipeline-events.md): the events that exist, which tasks subscribe to each, and
 * what every task and source emits. Pure data, so the build checks it without the Workers runtime
 * (`scripts/check-pipeline-boundary.ts`). Adding a downstream task is a row here plus its implementation in
 * `tasks.ts`; no queue, marker or Cron.
 */
export const EVENT_TYPES = [
  "filing.discovered", "collection.requested", "maintenance.requested",
  "financials.published", "filing.archived", "archive.superseded", "archive.prune.requested",
  "map.derived", "filings.indexed", "report.published", "analysis.published", "fundamentals.updated", "guidance.published",
  "task.version_changed",
  "transcript.stored", "explainer.published", "tree.published", "findings.published", "events.published",
  "library.requested", "library.prepared",
] as const;
export type EventType = typeof EVENT_TYPES[number];

export const TASK_NAMES = [
  "collect", "history", "reproject", "maintenance", "transcript",
  "map-derive", "archive-prune", "archive-prune-scan",
  "sec-report", "guidance", "events",
  "memory", "company-analysis", "explainer", "tree", "findings",
  "library",
] as const;
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
  // Collects a company's latest complete statements from EDGAR and publishes them.
  "collect": { emits: ["financials.published", "filing.archived", "archive.superseded"], debounceMs: 30 * SECOND, maxWaitMs: 5 * MINUTE, scope: "data" },
  // Brings the company's quarterly revenue history up to date after a publication.
  "history": { emits: ["filing.archived", "archive.superseded"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "data" },
  // Re-projects archived filings whose capital projection predates the current version.
  "reproject": { emits: ["filing.archived", "archive.superseded"], debounceMs: 0, maxWaitMs: 0, scope: "global" },
  // Advances the admin's financial maintenance tasks, one step per run.
  "maintenance": { emits: ["financials.published", "filing.archived", "archive.superseded"], debounceMs: 0, maxWaitMs: 0, scope: "global" },
  // Fetches earnings-call transcripts for archived periodic reports, within the daily budget.
  "transcript": { emits: ["transcript.stored"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "global" },
  // Rebuilds the map's older quarters and capital snapshot from archived filings.
  "map-derive": { emits: ["map.derived"], debounceMs: 30 * SECOND, maxWaitMs: 5 * MINUTE, scope: "data" },
  // Deletes archive copies replaced by a newer one, a day after the replacement.
  "archive-prune": { emits: [], debounceMs: 24 * HOUR, maxWaitMs: 24 * HOUR, scope: "data" },
  // A full pass over the archive for copies left behind before replacements were recorded; admin-requested.
  "archive-prune-scan": { emits: [], debounceMs: 0, maxWaitMs: 0, scope: "global" },
  // Runs the SEC report Workflow, which indexes the filing list, writes reports and 8-K summaries.
  "sec-report": { emits: ["filings.indexed", "report.published", "fundamentals.updated"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "ai" },
  // Extracts management guidance from earnings releases (Workflow).
  "guidance": { emits: ["guidance.published"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "ai" },
  // Current reports and Form 4 filings for the map's event rail; no model.
  "events": { emits: ["events.published"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "data" },
  // Starts report memory for a published periodic report; the memory Workflow starts the company analysis itself.
  "memory": { emits: [], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "ai" },
  // Recovers company analyses that stopped, failed or are behind the prompt version.
  "company-analysis": { emits: ["analysis.published"], debounceMs: 30 * MINUTE, maxWaitMs: 2 * HOUR, scope: "ai" },
  // Model-written explanations of each disclosed business (Workflow).
  "explainer": { emits: ["explainer.published"], debounceMs: 10 * MINUTE, maxWaitMs: 2 * HOUR, scope: "ai" },
  // The ReAct business mind map (Workflow).
  "tree": { emits: ["tree.published"], debounceMs: 10 * MINUTE, maxWaitMs: 2 * HOUR, scope: "tree" },
  // Report findings written from the map snapshot, guidance, SEC fundamentals and the company analysis (Workflow).
  "findings": { emits: ["findings.published"], debounceMs: 10 * MINUTE, maxWaitMs: 2 * HOUR, scope: "ai" },
  // Splits the company's archived documents into the filing library's sections and passages; no model.
  "library": { emits: ["library.prepared"], debounceMs: 30 * SECOND, maxWaitMs: 5 * MINUTE, scope: "data" },
};

const form = (event: PipelineEvent) => event.detail?.form ?? "";
const PERIODIC = /^(?:10-[QK]|20-F|40-F)(?:\/A)?$/;
const earnings = (event: PipelineEvent) => /^8-K/.test(form(event)) && /(^|,)\s*2\.02\b/.test(event.detail?.items ?? "");

export type Subscription = { task: TaskName; when?: (event: PipelineEvent) => boolean };
export const SUBSCRIPTIONS: Partial<Record<EventType, readonly Subscription[]>> = {
  "filing.discovered": [
    { task: "collect", when: e => PERIODIC.test(form(e)) || /^6-K/.test(form(e)) || earnings(e) },
    { task: "sec-report", when: e => PERIODIC.test(form(e)) || /^(?:8|6)-K/.test(form(e)) },
    { task: "events", when: e => /^(?:8-K|6-K|4)(?:\/A)?$/.test(form(e)) },
  ],
  "collection.requested": [{ task: "collect" }, { task: "history" }],
  "maintenance.requested": [{ task: "maintenance" }],
  "financials.published": [{ task: "map-derive" }, { task: "history" }, { task: "explainer" }, { task: "tree" }],
  "filing.archived": [{ task: "map-derive" }, { task: "transcript", when: e => /^10-[QK](?:\/A)?$/.test(form(e)) }, { task: "library" }],
  "library.requested": [{ task: "library" }],
  "archive.superseded": [{ task: "archive-prune" }],
  "archive.prune.requested": [{ task: "archive-prune-scan" }],
  "filings.indexed": [{ task: "guidance" }],
  "report.published": [
    { task: "events", when: e => /^(?:8|6)-K/.test(form(e)) },
    { task: "memory", when: e => PERIODIC.test(form(e)) },
    { task: "company-analysis", when: e => PERIODIC.test(form(e)) },
  ],
  "map.derived": [{ task: "findings" }],
  "guidance.published": [{ task: "findings" }],
  "fundamentals.updated": [{ task: "findings" }],
  "analysis.published": [{ task: "findings" }],
};

/** Emitters that are not tasks. `task.version_changed` is routed to the one task it names, never subscribed. */
export const SOURCES: Record<string, readonly EventType[]> = {
  // The only Cron: polls EDGAR, which pushes nothing.
  "sec-discovery": ["filing.discovered"],
  "admin": ["collection.requested", "maintenance.requested", "archive.prune.requested", "library.requested"],
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
