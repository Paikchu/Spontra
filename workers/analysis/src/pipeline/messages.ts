import { EVENT_TYPES, TASK_NAMES, type EventDetail, type EventType, type TaskName } from "./registry.ts";

export const EVENTS_QUEUE_NAME = "spontra-pipeline-events";
export const TASKS_QUEUE_NAME = "spontra-pipeline-tasks";
export const DEAD_QUEUE_NAME = "spontra-pipeline-dlq";

/** An event as sent from the outbox: identity and type only; subscribers read the current state from D1. */
export type EventMessage = {
  v: 1; kind: "event"; id: string; causeId: string | null; type: EventType; ticker: string;
  cik: string | null; task: TaskName | null; detail: EventDetail | null; at: string;
};
/** One subscriber's run: valid only while `pipeline_due` still holds this `dueAt` for the company and task. */
export type TaskMessage = { v: 1; kind: "task"; id: string; causeId: string; task: TaskName; ticker: string; dueAt: string };

const TICKER = /^(?:\*|[A-Z][A-Z0-9.-]{0,11})$/;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export function readEventMessage(body: unknown): EventMessage | null {
  if (!record(body) || body.v !== 1 || body.kind !== "event" || typeof body.id !== "string" || typeof body.ticker !== "string" || !TICKER.test(body.ticker)) return null;
  if (!EVENT_TYPES.includes(body.type as EventType)) return null;
  if (body.task !== null && !TASK_NAMES.includes(body.task as TaskName)) return null;
  return body as EventMessage;
}

export function readTaskMessage(body: unknown): TaskMessage | null {
  if (!record(body) || body.v !== 1 || body.kind !== "task" || typeof body.id !== "string" || typeof body.dueAt !== "string" || typeof body.ticker !== "string" || !TICKER.test(body.ticker)) return null;
  return TASK_NAMES.includes(body.task as TaskName) ? body as TaskMessage : null;
}
