import type { Feature, Layer } from "../../../../shared/analysis-contract/business-features.ts";
import { isOfferingForm, isProxyForm } from "../../../../shared/analysis-runtime/events.ts";
import { archivedForm, reportedForm } from "./filing-forms.ts";
/**
 * The pipeline's event graph: the events that exist, which tasks subscribe to each, and
 * what every task and source emits. Pure data, so the build checks it without the Workers runtime
 * (`scripts/check-analysis-boundary.ts`). Adding a downstream task is a row here plus its implementation in
 * `tasks.ts`; no queue, marker or Cron.
 */
export const EVENT_TYPES = [
  "company.added", "filing.discovered", "collection.requested", "maintenance.requested",
  "financials.published", "filing.archived", "archive.superseded", "archive.prune.requested", "archive.requested", "archive.unsupported",
  "map.derived", "extract.published", "filings.indexed", "report.published", "analysis.published", "fundamentals.updated", "guidance.published",
  "task.version_changed",
  "transcript.stored", "explainer.published", "tree.published", "findings.published", "events.published", "dossier.published", "checkup.published", "items.published",
  "library.requested", "library.prepared", "library.cards.published", "library.links.requested", "library.links.published",
  "business.tags.requested", "business.tags.published",
  "peers.published", "translations.published",
  "valuation.published",
  "presentation.unresolved",
  "feature.settings",
] as const;
export type EventType = typeof EVENT_TYPES[number];

export const TASK_NAMES = [
  "collect", "history", "reproject", "maintenance", "transcript", "archive",
  "map-derive", "archive-prune", "archive-prune-scan",
  "fundamentals", "guidance", "events", "extract",
  "memory", "company-analysis", "explainer", "tree", "findings", "analyst", "checkup", "filing-analysis",
  "library", "library-cards", "library-links", "library-search", "storage-sweep", "business-tags",
  "peers", "translate", "presentation", "valuation",
] as const;
export type TaskName = typeof TASK_NAMES[number];

/** What a filing event says about the filing, for subscribers that only want some forms. */
export type EventDetail = { form?: string; items?: string; accession?: string; /** Comma-separated event classes an events.published carries for its new rows. */ classes?: string;
  /** The layer a `feature.settings` event is about. */ feature?: Layer };
export type PipelineEvent = { type: EventType; ticker: string; cik?: string | null; task?: TaskName | null; detail?: EventDetail | null };

/**
 * Which companies a task runs for (docs/spontra-architecture-upgrade.md): the companies one analysis layer is switched
 * on for — `map` is the whitelist, the others the layer switches above it — or once globally.
 */
export type TaskScope = "map" | Feature | "global";
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
  "collect": { emits: ["financials.published", "filing.archived", "archive.superseded", "presentation.unresolved"], debounceMs: 30 * SECOND, maxWaitMs: 5 * MINUTE, scope: "map" },
  // Stores the current reports collection does not read (8-Ks without Item 2.02), so every filing the SEC report
  // analyses is in the archive (docs/sec-archive.md); no model.
  "archive": { emits: ["filing.archived", "archive.superseded", "archive.unsupported"], debounceMs: 30 * SECOND, maxWaitMs: 5 * MINUTE, scope: "map" },
  // Brings the company's quarterly revenue history up to date after a publication.
  "history": { emits: ["filing.archived", "archive.superseded"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "map" },
  // Re-projects archived filings whose capital projection predates the current version.
  "reproject": { emits: ["filing.archived", "archive.superseded"], debounceMs: 0, maxWaitMs: 0, scope: "global" },
  // Advances the admin's financial maintenance tasks, one step per run.
  "maintenance": { emits: ["financials.published", "filing.archived", "archive.superseded"], debounceMs: 0, maxWaitMs: 0, scope: "global" },
  // Fetches earnings-call transcripts for archived periodic reports and 6-K results, within the daily budget; the only
  // caller of the transcript provider.
  "transcript": { emits: ["transcript.stored"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "global" },
  // Rebuilds the map's older quarters and capital snapshot from archived filings.
  "map-derive": { emits: ["map.derived"], debounceMs: 30 * SECOND, maxWaitMs: 5 * MINUTE, scope: "map" },
  // Deletes archive copies replaced by a newer one, a day after the replacement.
  "archive-prune": { emits: [], debounceMs: 24 * HOUR, maxWaitMs: 24 * HOUR, scope: "map" },
  // A full pass over the archive for copies left behind before replacements were recorded; admin-requested.
  "archive-prune-scan": { emits: [], debounceMs: 0, maxWaitMs: 0, scope: "global" },
  // Runs the SEC report Workflow, which indexes the filing list, writes reports and 8-K summaries.
  // Re-reads Company Facts when new statements are published, so the SEC fundamentals keep up with the page; retried
  // while Company Facts is still behind the filing. No model.
  "fundamentals": { emits: ["fundamentals.updated"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "map" },
  // Extracts management guidance from earnings releases and the calls the transcript library stored (Workflow).
  "guidance": { emits: ["guidance.published"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "filings" },
  // Current reports and Form 4 filings for the map's event rail, and every company's filings list; no model.
  "events": { emits: ["events.published", "filings.indexed"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "map" },
  // Layer 2's per-period extract: the eight quarters, the ledger every finding's figures come from and the checkup's
  // flags, cut from layer 1's publication and the guidance so the layers above never read layer 1; no model.
  "extract": { emits: ["extract.published"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "filings" },
  // Starts report memory for a published periodic report; the memory Workflow starts the company analysis itself.
  "memory": { emits: [], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "filings" },
  // Recovers company analyses that stopped, failed or are behind the prompt version.
  "company-analysis": { emits: ["analysis.published"], debounceMs: 30 * MINUTE, maxWaitMs: 2 * HOUR, scope: "findings" },
  // Model-written explanations of each disclosed business (Workflow).
  "explainer": { emits: ["explainer.published"], debounceMs: 10 * MINUTE, maxWaitMs: 2 * HOUR, scope: "tree" },
  // The ReAct business mind map (Workflow).
  "tree": { emits: ["tree.published"], debounceMs: 10 * MINUTE, maxWaitMs: 2 * HOUR, scope: "tree" },
  // Report findings written from the map snapshot, guidance, SEC fundamentals and the company analysis (Workflow).
  "findings": { emits: ["findings.published"], debounceMs: 10 * MINUTE, maxWaitMs: 2 * HOUR, scope: "findings" },
  // The analyst agent: a research dossier per verified finding, from the filings, figures and peers (Workflow).
  "analyst": { emits: ["dossier.published"], debounceMs: 10 * MINUTE, maxWaitMs: 2 * HOUR, scope: "findings" },
  // A written analysis of each metric the three-statement checkup flags, read against the current and earlier filings (Workflow).
  "checkup": { emits: ["checkup.published"], debounceMs: 10 * MINUTE, maxWaitMs: 2 * HOUR, scope: "findings" },
  // The analysis of each row of the filings rail: reports, current reports and flagged Form 4s, each by the shared agent
  // loop with the tools every analysis is composed with (Workflow; model at the reasoning tier).
  // Every filing's one path (docs/filing-analysis-design.md); the sessions it starts publish on their own.
  "filing-analysis": { emits: ["filings.indexed", "report.published", "fundamentals.updated"], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "filings" },
  // Splits the company's archived documents into the filing library's sections and passages; no model.
  "library": { emits: ["library.prepared"], debounceMs: 30 * SECOND, maxWaitMs: 5 * MINUTE, scope: "filings" },
  // Index cards for the sections of the company's recent documents (Workflow; model at low reasoning).
  "library-cards": { emits: ["library.cards.published"], debounceMs: 10 * MINUTE, maxWaitMs: 2 * HOUR, scope: "filings" },
  // Proposes each business's map node, filing sections and cross-company category (Workflow; model at high reasoning).
  "library-links": { emits: ["library.links.published"], debounceMs: 10 * MINUTE, maxWaitMs: 2 * HOUR, scope: "filings" },
  // Comparable units and their two levels of business tags, embedded and matched against other companies' (Workflow; model at high reasoning).
  "business-tags": { emits: ["business.tags.published"], debounceMs: 5 * MINUTE, maxWaitMs: HOUR, scope: "filings" },
  // Uploads carded sections to the AI Search recall layer and removes the ones that left it; no model.
  "library-search": { emits: [], debounceMs: 2 * MINUTE, maxWaitMs: 30 * MINUTE, scope: "filings" },
  // Deletes stored data no code reads any more, at most once a day; no model.
  "storage-sweep": { emits: [], debounceMs: MINUTE, maxWaitMs: 10 * MINUTE, scope: "global" },
  // One global projection of every data company's comparable figures, for peers tables resolved at read time; no model.
  "peers": { emits: ["peers.published"], debounceMs: 2 * MINUTE, maxWaitMs: 30 * MINUTE, scope: "global" },
  // Translates the reader-facing prose of every publication the map reads into Chinese, string by string (Workflow; model at low reasoning).
  "translate": { emits: ["translations.published"], debounceMs: 2 * MINUTE, maxWaitMs: 30 * MINUTE, scope: "map" },
  // Judges an income statement whose lines after operating income no calculation or statement row balances (model; the
  // arithmetic decides), then collects the issuer again through a maintenance task.
  "presentation": { emits: ["maintenance.requested"], debounceMs: 2 * MINUTE, maxWaitMs: 30 * MINUTE, scope: "map" },
  // The valuation assessment: five researched dimensions and a calculated model,
  // rewritten when the figures, filings, guidance or calls it reads from change (Workflow; model at the reasoning tier).
  "valuation": { emits: ["valuation.published"], debounceMs: 5 * MINUTE, maxWaitMs: 30 * MINUTE, scope: "valuation" },
};

const form = (event: PipelineEvent) => event.detail?.form ?? "";
const PERIODIC = /^(?:10-[QK]|20-F|40-F)(?:\/A)?$/;
const earnings = (event: PipelineEvent) => /^8-K/.test(form(event)) && /(^|,)\s*2\.02\b/.test(event.detail?.items ?? "");

export type Subscription = { task: TaskName; when?: (event: PipelineEvent) => boolean };
export const SUBSCRIPTIONS: Partial<Record<EventType, readonly Subscription[]>> = {
  "filing.discovered": [
    { task: "collect", when: e => PERIODIC.test(form(e)) || /^6-K/.test(form(e)) || earnings(e) },
    // Every current report (and 40-F) is archived by its own task; collection stores only some of them, and a stored
    // document is not downloaded again. The SEC report follows `filing.archived`.
    { task: "archive", when: e => archivedForm(form(e)) },
    // Every business filing: the rail lists current reports, Form 4s, offerings and proxies, and the run indexes the filings list for all.
    { task: "events", when: e => PERIODIC.test(form(e)) || /^(?:8-K|6-K|4)(?:\/A)?$/.test(form(e)) || isOfferingForm(form(e)) || isProxyForm(form(e)) },
  ],
  // A company new to the pipeline (admin whitelist, or a data ticker seen by discovery for the first time): its event
  // rail is built now, not at its next current report; collection comes with the maintenance or collection request.
  "company.added": [{ task: "events" }, { task: "presentation" }],
  // A company's baseline lists current reports no `filing.discovered` announced.
  "archive.requested": [{ task: "archive" }],
  // A filing the archive gave up on heads no earnings group any more: the report regroups its period's readable sources.
  "collection.requested": [{ task: "collect" }, { task: "history" }],
  "maintenance.requested": [{ task: "maintenance" }],
  "financials.published": [{ task: "fundamentals" }, { task: "map-derive" }, { task: "history" }, { task: "explainer" }, { task: "tree" }, { task: "library-links" }, { task: "valuation" }],
  // The SEC report reads filings from the archive alone, so it starts when a filing it analyses is archived.
  "filing.archived": [{ task: "guidance", when: e => /^8-K/.test(form(e)) }, { task: "map-derive" },
    { task: "filing-analysis", when: e => reportedForm(form(e)) }, { task: "analyst", when: e => /^10-[QK](?:\/A)?$/.test(form(e)) }, { task: "transcript", when: e => /^(?:10-[QK]|20-F|6-K)(?:\/A)?$/.test(form(e)) }, { task: "library" }, { task: "storage-sweep" }],
  "library.requested": [{ task: "library" }],
  // A filing newly split into the library is text the checkup notes can now read against the earlier ones.
  "library.prepared": [{ task: "library-cards" }, { task: "checkup" }, { task: "filing-analysis" }, { task: "valuation" }],
  "library.cards.published": [{ task: "library-links" }, { task: "library-search" }, { task: "storage-sweep" }],
  "library.links.requested": [{ task: "library-links" }],
  // The business links are the units' and sector tags' source; their tags and pairs are written right after them.
  "library.links.published": [{ task: "business-tags" }],
  "business.tags.requested": [{ task: "business-tags" }],
  "business.tags.published": [{ task: "peers" }],
  "archive.superseded": [{ task: "archive-prune" }],
  "archive.prune.requested": [{ task: "archive-prune-scan" }],
  "filings.indexed": [{ task: "guidance" }],
  // A stored call is guidance material for the company's earnings event; only where layer 2 is on.
  "transcript.stored": [{ task: "guidance" }, { task: "valuation" }],
  "report.published": [
    { task: "translate" },
    { task: "events", when: e => /^(?:8|6)-K/.test(form(e)) },
    { task: "memory", when: e => PERIODIC.test(form(e)) },
    { task: "company-analysis", when: e => PERIODIC.test(form(e)) },
  ],
  // Findings read layer 2 only: the per-period extract, the filing analyses and the company analysis.
  "map.derived": [{ task: "extract" }, { task: "peers" }, { task: "translate" }, { task: "valuation" }],
  "guidance.published": [{ task: "extract" }, { task: "translate" }, { task: "valuation" }],
  "fundamentals.updated": [{ task: "extract" }, { task: "peers" }, { task: "valuation" }],
  "extract.published": [{ task: "findings" }],
  "analysis.published": [{ task: "findings" }],
  "findings.published": [{ task: "analyst" }, { task: "checkup" }, { task: "translate" }, { task: "valuation" }],
  // Every publication with reader-facing prose is translated once it lands.
  "dossier.published": [{ task: "translate" }],
  "checkup.published": [{ task: "translate" }],
  "explainer.published": [{ task: "translate" }],
  "tree.published": [{ task: "translate" }, { task: "valuation" }],
  "valuation.published": [{ task: "translate" }],
  // New rows on the rail are filings to analyse.
  "events.published": [{ task: "translate" }],
  "presentation.unresolved": [{ task: "presentation" }],
  // A feature switch changed in the admin: the feature's first task checks whether there is something to write (the SEC
  // reports lead on to guidance; the findings chain starts from the company analysis already published); the map's
  // revisions move so shown or hidden content reaches readers at once.
  "feature.settings": [
    // Layer 2: the archived filings are split into the library, the summaries and guidance written, each filing analysed.
    { task: "library", when: e => e.detail?.feature === "filings" },
    { task: "extract", when: e => e.detail?.feature === "filings" },
    { task: "filing-analysis", when: e => e.detail?.feature === "filings" },
    { task: "memory", when: e => e.detail?.feature === "filings" },
    { task: "findings", when: e => e.detail?.feature === "findings" },
    { task: "company-analysis", when: e => e.detail?.feature === "findings" },
    { task: "explainer", when: e => e.detail?.feature === "tree" },
    { task: "tree", when: e => e.detail?.feature === "tree" },
    { task: "valuation", when: e => e.detail?.feature === "valuation" },
  ],
};

/** Emitters that are not tasks. `task.version_changed` is routed to the one task it names, never subscribed. */
export const SOURCES: Record<string, readonly EventType[]> = {
  // The only Cron: polls EDGAR, which pushes nothing. Silent while scheduled analysis is off, as is "invocation".
  "sec-discovery": ["company.added", "filing.discovered", "collection.requested", "archive.requested"],
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
