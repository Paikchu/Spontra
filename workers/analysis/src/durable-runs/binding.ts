import type { RunState } from "./engine.ts";
import type { StoredPiSession } from "../pi/host.ts";
import type { FilingSpec } from "../filing-analysis/recipe.ts";

/** The run kinds, named by the env property each one is reached through. */
export const RUN_BINDINGS = [
  "BUSINESS_EXPLAINER_WORKFLOW", "BUSINESS_TREE_WORKFLOW", "VALUATION_WORKFLOW",
  "BUSINESS_CLASSIFICATION_WORKFLOW", "BUSINESS_TAGS_WORKFLOW", "TRANSLATE_WORKFLOW",
  "SEC_MEMORY_WORKFLOW", "REPORT_WORKFLOW", "PUBLIC_RESEARCH_WORKFLOW", "MATERIAL_PILOT_WORKFLOW", "MATERIAL_PREPARE_WORKFLOW", "MATERIAL_BRIEF_WORKFLOW", "FILING_OPERATOR_COMPLETION_WORKFLOW",
] as const;
export type RunKind = typeof RUN_BINDINGS[number];

/** The RPC surface of one run's Durable Object. */
export type RunStub = {
  start(kind: RunKind, id: string, params: unknown, createdAt: number): Promise<void>;
  status(): Promise<RunState>;
  terminate(): Promise<void>;
  report(): Promise<unknown>;
  readPublicResearchSession(runId: string, stage: string): Promise<{ runId: string; status: "terminated"; session: StoredPiSession } | null>;
  readFilingShadowSession(runId: string, spec: FilingSpec): Promise<StoredPiSession | null>;
  startSession(kind: string, spec: unknown, opening: string, operationId: string): Promise<void>;
};
type RunNamespace = { idFromName(name: string): unknown; get(id: never): unknown };

/** Instance ids are unique per kind, as they were per Workflow. */
export const runName = (kind: RunKind, id: string) => `${kind}:${id}`;

/**
 * A binding with the create/get/status surface the task code already uses, backed by one `TaskRunner` Agent per run.
 * The SDK is imported on first use, so code that only passes the env around stays importable outside the runtime.
 */
export function runBinding(namespace: RunNamespace, kind: RunKind) {
  const stub = async (id: string) => {
    const { getAgentByName } = await import("agents");
    return await getAgentByName(namespace as never, runName(kind, id)) as unknown as RunStub;
  };
  return {
    async create({ id, params }: { id: string; params: unknown }) {
      await (await stub(id)).start(kind, id, params, Date.now());
      return { id };
    },
    async get(id: string) {
      const run = await stub(id);
      return { id, status: () => run.status(), terminate: () => run.terminate(), report: () => run.report() };
    },
    // Do not initialize/reroute an Agent through getAgentByName on a storage-only read.
    async readPublicResearchSession(id: string, stage: string) {
      const run = namespace.get(namespace.idFromName(runName(kind, id)) as never) as RunStub;
      return run.readPublicResearchSession(id, stage);
    },
  };
}

/** Pi sessions that run on their own in a `TaskRunner` Agent of their own: nothing polls them, and one publishes its own result. */
export function filingSessions(env: object) {
  const namespace = (env as { TASK_RUNS?: RunNamespace }).TASK_RUNS;
  if (!namespace) return null;
  const stub = async (id: string) => {
    const { getAgentByName } = await import("agents");
    return await getAgentByName(namespace as never, `FILING:${id}`) as unknown as RunStub;
  };
  return {
    start: async (id: string, kind: string, spec: unknown, opening: string, operationId: string) => (await stub(id)).startSession(kind, spec, opening, operationId),
    report: async (id: string) => (await stub(id)).report(),
    // A checkpoint read must not initialize Pi through getAgentByName or repair a session.
    readEndedShadow: (id: string, spec: FilingSpec) => (namespace.get(namespace.idFromName(`FILING:${id}`) as never) as RunStub).readFilingShadowSession(id, spec),
    stop: async (id: string) => (await stub(id)).terminate(),
  };
}

const RUNS_READY = Symbol.for("spontra.runs");

/** The env with every run binding in place; an env without the `TASK_RUNS` namespace is returned as it is. */
export function withRuns<E extends object>(env: E): E {
  const namespace = (env as { TASK_RUNS?: RunNamespace }).TASK_RUNS;
  if (!namespace || (env as { [RUNS_READY]?: true })[RUNS_READY]) return env;
  const bindings = Object.fromEntries(RUN_BINDINGS.map((kind) => [kind, runBinding(namespace, kind)]));
  return { ...env, ...bindings, [RUNS_READY]: true };
}
