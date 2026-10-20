import type { AnalysisEnv } from "../operations.ts";
import { outboxStatement } from "./outbox.ts";
import { TASK_NAMES, type TaskName } from "./registry.ts";
import { TASK_IMPLEMENTATIONS } from "./tasks.ts";

type Stored = { payload: string; deployed_at: string };

/**
 * Announces every task whose version changed since the code that last ran: one `task.version_changed` per task,
 * written with the new version record in one batch. One primary-key read when nothing changed. Versions only move
 * forward: while a deployment rolls out, an invocation of the older code finds a newer record and leaves it alone.
 */
export async function announceTaskVersions(env: AnalysisEnv): Promise<TaskName[]> {
  if (!env.DB) return [];
  const current = Object.fromEntries(TASK_NAMES.map(task => [task, TASK_IMPLEMENTATIONS[task].version])) as Record<TaskName, string>;
  const payload = JSON.stringify(current);
  const stored = await env.DB.prepare("SELECT payload, deployed_at FROM pipeline_versions WHERE id = 'tasks'").first<Stored>();
  if (stored?.payload === payload) return [];
  const deployedAt = env.CF_VERSION_METADATA?.timestamp ?? new Date(0).toISOString();
  if (stored && Date.parse(stored.deployed_at) > Date.parse(deployedAt)) return [];
  let previous: Partial<Record<TaskName, string>> = {};
  try { previous = stored ? JSON.parse(stored.payload) as typeof previous : {}; } catch { /* treated as all changed */ }
  const changed = TASK_NAMES.filter(task => previous[task] !== current[task]);
  const at = new Date().toISOString();
  const [written] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO pipeline_versions (id, payload, deployed_at, updated_at) VALUES ('tasks', ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, deployed_at = excluded.deployed_at, updated_at = excluded.updated_at
      WHERE pipeline_versions.payload <> excluded.payload AND pipeline_versions.deployed_at <= excluded.deployed_at`).bind(payload, deployedAt, at),
    // Only the invocation whose write took effect announces; a concurrent one finds the record already current.
    ...changed.map(task => outboxStatement(env.DB!, { type: "task.version_changed", ticker: "*", task }, at,
      { sql: "EXISTS(SELECT 1 FROM pipeline_versions WHERE id = 'tasks' AND payload = ? AND updated_at = ?)", binds: [payload, at] })),
  ]);
  return (written!.meta.changes ?? 0) > 0 ? changed : [];
}
