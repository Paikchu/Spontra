/** Events the admin may send by hand: replaying what a source would have emitted, for one company or all. */
export const MANUAL_PIPELINE_EVENTS = [
  { type: "collection.requested", label: "重新采集财报", scope: "company" },
  { type: "financials.published", label: "重建地图快照", scope: "company" },
  { type: "archive.prune.requested", label: "全量清理存档副本", scope: "global" },
] as const;
export type ManualPipelineEvent = typeof MANUAL_PIPELINE_EVENTS[number]["type"];

export type PipelineDue = { ticker: string; task: string; dueAt: string; firstRequestedAt: string; causeId: string | null };
export type PipelineDead = { id: string; kind: string | null; name: string | null; ticker: string | null; attempts: number; createdAt: string; body: string };
export type PipelineLogEntry = {
  id: string; messageId: string; causeId: string | null; kind: "event" | "task"; name: string; ticker: string;
  outcome: string; detail: string | null; createdAt: string;
};

export type PipelineOverview = {
  /** When the SEC discovery Cron last read EDGAR successfully; null before its first run. */
  discoveryAt: string | null;
  /** The discovery Cron runs every 10 minutes; no success for 30 means it stopped. */
  discoveryStale: boolean;
  /** `stale`: an event has waited more than 15 minutes, longer than one discovery period should allow. */
  outbox: { pending: number; oldestAt: string | null; stale: boolean };
  due: PipelineDue[];
  dead: PipelineDead[];
  log: PipelineLogEntry[];
  versions: { current: Record<string, string>; announced: Record<string, string> | null; deployedAt: string | null };
  companies: string[];
};

/** A message and the ones that caused it, newest first, back to the event that started the chain. */
export type PipelineTrail = { entries: PipelineLogEntry[] };
