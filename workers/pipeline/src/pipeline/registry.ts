import type { Feature } from "../../../../shared/analysis-contract/business-features.ts";
/**
 * The pipeline's event graph (docs/pipeline-events.md): the events that exist, which tasks subscribe to each, and
 * what every task and source emits. Pure data, so the build checks it without the Workers runtime
 * (`scripts/check-pipeline-boundary.ts`). Adding a downstream task is a row here plus its implementation in
 * `tasks.ts`; no queue, marker or Cron.
 */
export const EVENT_TYPES = [
  "company.added", "filing.discovered", "collection.requested", "maintenance.requested",
  "financials.published", "filing.archived", "archive.superseded", "archive.prune.requested",
  "map.derived", "filings.indexed", "report.published", "analysis.published", "fundamentals.updated", "guidance.published",
  "task.version_changed",
  "transcript.stored", "explainer.published", "tree.published", "findings.published", "events.published", "dossier.published",
  "library.requested", "library.prepared", "library.cards.published", "library.links.requested", "library.links.published",
  "business.tags.requested", "business.tags.published",
  "peers.published", "translations.published",
  "presentation.unresolved",
  "feature.settings",
] as const;
export type EventType = typeof EVENT_TYPES[number];

export const TASK_NAMES = [
  "collect", "history", "reproject", "maintenance", "transcript",
  "map-derive", "archive-prune", "archive-prune-scan",
  "sec-report", "guidance", "events",
  "memory", "company-analysis", "explainer", "tree", "findings", "analyst",
  "library", "library-cards", "library-links", "library-search", "storage-sweep", "business-tags",
  "peers", "translate", "presentation",
] as const;
export type TaskName = typeof TASK_NAMES[number];

/** What a filing event says about the filing, for subscribers that only want some forms. */
export type EventDetail = { form?: string; items?: string; accession?: string; /** Comma-separated event classes an events.published carries for its new rows. */ classes?: string;
  /** The feature a `feature.settings` event is about. */ feature?: Feature };
export type PipelineEvent = { type: EventType; ticker: string; cik?: string | null; task?: TaskName | null; detail?: EventDetail | null };

/**
 * Which companies a task runs for when its version changes: every data company, the companies one reader-facing feature
 * is switched on for (docs/whitelist-feature-switches-design.md), or once globally.
 */
export type TaskScope = "data" | Feature | "global";
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
  "collect": { emits: ["financials.published", "filing.archived", "archive.superseded", "presentation.unresolved"], debounceMs: 30 * SECOND, maxWaitMs: 5 * MINUTE, scope: "data" },
  // Brings the company's quarterly revenue history up to date after a publication.
  "history": { emits: ["filing.archived", "archive.superseded"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "data" },
  // Re-projects archived filings whose capital projection predates the current version.
  "reproject": { emits: ["filing.archived", "archive.superseded"], debounceMs: 0, maxWaitMs: 0, scope: "global" },
  // Advances the admin's financial maintenance tasks, one step per run.
  "maintenance": { emits: ["financials.published", "filing.archived", "archive.superseded"], debounceMs: 0, maxWaitMs: 0, scope: "global" },
  // Fetches earnings-call transcripts for archived periodic reports and 6-K results, within the daily budget; the only
  // caller of the transcript provider.
  "transcript": { emits: ["transcript.stored"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "global" },
  // Rebuilds the map's older quarters and capital snapshot from archived filings.
  "map-derive": { emits: ["map.derived"], debounceMs: 30 * SECOND, maxWaitMs: 5 * MINUTE, scope: "data" },
  // Deletes archive copies replaced by a newer one, a day after the replacement.
  "archive-prune": { emits: [], debounceMs: 24 * HOUR, maxWaitMs: 24 * HOUR, scope: "data" },
  // A full pass over the archive for copies left behind before replacements were recorded; admin-requested.
  "archive-prune-scan": { emits: [], debounceMs: 0, maxWaitMs: 0, scope: "global" },
  // Runs the SEC report Workflow, which indexes the filing list, writes reports and 8-K summaries.
  "sec-report": { emits: ["filings.indexed", "report.published", "fundamentals.updated"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "reports" },
  // Extracts management guidance from earnings releases and the calls the transcript library stored (Workflow).
  "guidance": { emits: ["guidance.published"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "reports" },
  // Current reports and Form 4 filings for the map's event rail; no model.
  "events": { emits: ["events.published"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "data" },
  // Starts report memory for a published periodic report; the memory Workflow starts the company analysis itself.
  "memory": { emits: [], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "findings" },
  // Recovers company analyses that stopped, failed or are behind the prompt version.
  "company-analysis": { emits: ["analysis.published"], debounceMs: 30 * MINUTE, maxWaitMs: 2 * HOUR, scope: "findings" },
  // Model-written explanations of each disclosed business (Workflow).
  "explainer": { emits: ["explainer.published"], debounceMs: 10 * MINUTE, maxWaitMs: 2 * HOUR, scope: "explainer" },
  // The ReAct business mind map (Workflow).
  "tree": { emits: ["tree.published"], debounceMs: 10 * MINUTE, maxWaitMs: 2 * HOUR, scope: "tree" },
  // Report findings written from the map snapshot, guidance, SEC fundamentals and the company analysis (Workflow).
  "findings": { emits: ["findings.published"], debounceMs: 10 * MINUTE, maxWaitMs: 2 * HOUR, scope: "findings" },
  // The analyst agent: a research dossier per verified finding, from the filings, figures and peers (Workflow).
  "analyst": { emits: ["dossier.published"], debounceMs: 10 * MINUTE, maxWaitMs: 2 * HOUR, scope: "findings" },
  // Splits the company's archived documents into the filing library's sections and passages; no model.
  "library": { emits: ["library.prepared"], debounceMs: 30 * SECOND, maxWaitMs: 5 * MINUTE, scope: "data" },
  // Index cards for the sections of the company's recent documents (Workflow; model at low reasoning).
  "library-cards": { emits: ["library.cards.published"], debounceMs: 10 * MINUTE, maxWaitMs: 2 * HOUR, scope: "data" },
  // Proposes each business's map node, filing sections and cross-company category (Workflow; model at high reasoning).
  "library-links": { emits: ["library.links.published"], debounceMs: 10 * MINUTE, maxWaitMs: 2 * HOUR, scope: "data" },
  // Comparable units and their two levels of business tags, embedded and matched against other companies' (Workflow; model at high reasoning).
  "business-tags": { emits: ["business.tags.published"], debounceMs: 5 * MINUTE, maxWaitMs: HOUR, scope: "data" },
  // Uploads carded sections to the AI Search recall layer and removes the ones that left it; no model.
  "library-search": { emits: [], debounceMs: 2 * MINUTE, maxWaitMs: 30 * MINUTE, scope: "data" },
  // Deletes stored data no code reads any more, at most once a day; no model.
  "storage-sweep": { emits: [], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "global" },
  // One global projection of every data company's comparable figures, for peers tables resolved at read time; no model.
  "peers": { emits: ["peers.published"], debounceMs: 2 * MINUTE, maxWaitMs: 30 * MINUTE, scope: "global" },
  // Translates the reader-facing prose of every publication the map reads into Chinese, string by string (Workflow; model at low reasoning).
  "translate": { emits: ["translations.published"], debounceMs: 2 * MINUTE, maxWaitMs: 30 * MINUTE, scope: "data" },
  // Judges an income statement whose lines after operating income no calculation or statement row balances (model; the
  // arithmetic decides), then collects the issuer again through a maintenance task.
  "presentation": { emits: ["maintenance.requested"], debounceMs: 2 * MINUTE, maxWaitMs: 30 * MINUTE, scope: "data" },
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
  // A company new to the pipeline (admin whitelist, or a data ticker seen by discovery for the first time): its event
  // rail is built now, not at its next current report; collection comes with the maintenance or collection request.
  "company.added": [{ task: "events" }, { task: "presentation" }],
  "collection.requested": [{ task: "collect" }, { task: "history" }],
  "maintenance.requested": [{ task: "maintenance" }],
  "financials.published": [{ task: "map-derive" }, { task: "history" }, { task: "explainer" }, { task: "tree" }, { task: "library-links" }],
  "filing.archived": [{ task: "map-derive" }, { task: "analyst", when: e => /^10-[QK](?:\/A)?$/.test(form(e)) }, { task: "transcript", when: e => /^(?:10-[QK]|20-F|6-K)(?:\/A)?$/.test(form(e)) }, { task: "library" }, { task: "storage-sweep" }],
  "library.requested": [{ task: "library" }],
  "library.prepared": [{ task: "library-cards" }],
  "library.cards.published": [{ task: "library-links" }, { task: "library-search" }, { task: "storage-sweep" }],
  "library.links.requested": [{ task: "library-links" }],
  // The business links are the units' and sector tags' source; their tags and pairs are written right after them.
  "library.links.published": [{ task: "business-tags" }],
  "business.tags.requested": [{ task: "business-tags" }],
  "business.tags.published": [{ task: "peers" }],
  "archive.superseded": [{ task: "archive-prune" }],
  "archive.prune.requested": [{ task: "archive-prune-scan" }],
  "filings.indexed": [{ task: "guidance" }],
  // A stored call is guidance material for the company's earnings event; only where the reports feature is on.
  "transcript.stored": [{ task: "guidance" }],
  "report.published": [
    { task: "translate" },
    { task: "events", when: e => /^(?:8|6)-K/.test(form(e)) },
    { task: "memory", when: e => PERIODIC.test(form(e)) },
    { task: "company-analysis", when: e => PERIODIC.test(form(e)) },
  ],
  "map.derived": [{ task: "findings" }, { task: "peers" }, { task: "translate" }],
  "guidance.published": [{ task: "findings" }, { task: "translate" }],
  "fundamentals.updated": [{ task: "findings" }, { task: "peers" }],
  "analysis.published": [{ task: "findings" }],
  "findings.published": [{ task: "analyst" }, { task: "translate" }],
  // Every publication with reader-facing prose is translated once it lands (docs/i18n-design.md).
  "dossier.published": [{ task: "translate" }],
  "explainer.published": [{ task: "translate" }],
  "tree.published": [{ task: "translate" }],
  "events.published": [{ task: "translate" }],
  "presentation.unresolved": [{ task: "presentation" }],
  // A feature switch changed in the admin: the feature's first task checks whether there is something to write (the SEC
  // reports lead on to guidance; the findings chain starts from the company analysis already published); the map's
  // revisions move so shown or hidden content reaches readers at once.
  "feature.settings": [
    { task: "sec-report", when: e => e.detail?.feature === "reports" },
    { task: "findings", when: e => e.detail?.feature === "findings" },
    { task: "company-analysis", when: e => e.detail?.feature === "findings" },
    { task: "explainer", when: e => e.detail?.feature === "explainer" },
    { task: "tree", when: e => e.detail?.feature === "tree" },
  ],
};

/** Emitters that are not tasks. `task.version_changed` is routed to the one task it names, never subscribed. */
export const SOURCES: Record<string, readonly EventType[]> = {
  // The only Cron: polls EDGAR, which pushes nothing.
  "sec-discovery": ["company.added", "filing.discovered", "collection.requested"],
  "admin": ["company.added", "collection.requested", "maintenance.requested", "archive.prune.requested", "library.requested", "library.links.requested", "business.tags.requested", "business.tags.published", "presentation.unresolved", "feature.settings"],
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
