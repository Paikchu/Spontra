import type { SecPipelineEnv } from "../operations.ts";
import { DEAD_QUEUE_NAME, EVENTS_QUEUE_NAME, readEventMessage, readTaskMessage, TASKS_QUEUE_NAME, type EventMessage } from "./messages.ts";
import { flushOutbox } from "./outbox.ts";
import { routeEvents } from "./router.ts";
import { runTaskMessage } from "./tasks.ts";
import { announceTaskVersions } from "./versions.ts";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * What every Cron and queue invocation does first: announce changed task versions and send events a previous
 * invocation committed but did not get to send. Neither ever fails the invocation it runs in. Read paths
 * (`MapReads`, admin reads) never call this.
 */
export async function pipelineEntry(env: SecPipelineEnv): Promise<void> {
  try {
    const changed = await announceTaskVersions(env);
    if (changed.length) console.log(JSON.stringify({ event: "pipeline-versions", changed }));
  } catch (error) { console.error(JSON.stringify({ event: "pipeline-versions", error: errorText(error) })); }
  try { await flushOutbox(env); } catch (error) { console.error(JSON.stringify({ event: "pipeline-outbox", error: errorText(error) })); }
}

/** A retry waits longer each time: 1, 2, 4, 8 minutes, then 15. */
const backoff = (attempts: number) => Math.min(900, 60 * 2 ** Math.max(0, attempts - 1));

export async function handlePipelineQueue(batch: MessageBatch<unknown>, env: SecPipelineEnv): Promise<void> {
  await pipelineEntry(env);
  if (batch.queue === EVENTS_QUEUE_NAME) {
    const events = batch.messages.map(m => readEventMessage(m.body)).filter((e): e is EventMessage => e !== null);
    if (events.length < batch.messages.length) console.error(JSON.stringify({ event: "pipeline-route", dropped: batch.messages.length - events.length }));
    try {
      const result = await routeEvents(env, events);
      console.log(JSON.stringify({ event: "pipeline-route", ...result }));
      batch.ackAll();
    } catch (error) {
      console.error(JSON.stringify({ event: "pipeline-route", error: errorText(error) }));
      batch.retryAll({ delaySeconds: 10 });
    }
    return;
  }
  if (batch.queue === TASKS_QUEUE_NAME) {
    for (const item of batch.messages) {
      const message = readTaskMessage(item.body);
      if (!message) { console.error(JSON.stringify({ event: "pipeline-task", dropped: item.id })); item.ack(); continue; }
      try {
        const result = await runTaskMessage(env, message);
        console.log(JSON.stringify({ event: "pipeline-task", task: message.task, ticker: message.ticker, ...result }));
        item.ack();
      } catch (error) {
        console.error(JSON.stringify({ event: "pipeline-task", task: message.task, ticker: message.ticker, attempts: item.attempts, error: errorText(error) }));
        item.retry({ delaySeconds: backoff(item.attempts) });
      }
    }
    // Events the runs just committed go out now rather than at the next invocation.
    await flushOutbox(env).catch(error => console.error(JSON.stringify({ event: "pipeline-outbox", error: errorText(error) })));
    return;
  }
  if (batch.queue === DEAD_QUEUE_NAME) {
    const db = env.DB!;
    const at = new Date().toISOString();
    await db.batch(batch.messages.map(item => {
      const body = item.body as { kind?: string; type?: string; task?: string; ticker?: string } | null;
      const name = body?.kind === "task" ? body.task : body?.type;
      // Error level, so a dead letter raises the Worker's error notification.
      console.error(JSON.stringify({ event: "pipeline-dead", id: item.id, kind: body?.kind, name, ticker: body?.ticker, attempts: item.attempts }));
      return db.prepare("INSERT INTO pipeline_dead (id, kind, name, ticker, body, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
        .bind(item.id, body?.kind ?? null, name ?? null, body?.ticker ?? null, JSON.stringify(item.body), item.attempts, at);
    }));
    batch.ackAll();
    return;
  }
  console.error(JSON.stringify({ event: "pipeline-queue", unknown: batch.queue }));
  batch.retryAll();
}
