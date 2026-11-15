import type { TaskImplementation, TaskOutcome } from "../pipeline/tasks.ts";
import { listFilingMaterials, prepareFilingMaterial } from "./index.ts";
import { MATERIAL_PREPARATION_VERSION } from "./store.ts";

export const MATERIAL_TASKS = {
  "filing-material": {
    version: MATERIAL_PREPARATION_VERSION,
    async run(env, ticker, { causeId }): Promise<TaskOutcome> {
      const states = (await listFilingMaterials(env, ticker)).filter(state => state.status !== "ready" || state.preparationVersion !== MATERIAL_PREPARATION_VERSION);
      if (!states.length) return { status: "done", detail: { waiting: 0 } };
      const first = states.find(state => state.status === "preparing") ?? states.at(-1)!;
      const result = await prepareFilingMaterial(env, first.filing, { causeId });
      const remaining = states.length - Number(result.status === "ready");
      const otherPending = states.some(state => state !== first && state.status === "preparing");
      return remaining ? { status: "later", afterMs: result.status === "blocked" && !otherPending ? 15 * 60_000 : 1000, detail: result }
        : { status: "done", detail: result };
    },
  },
} satisfies Record<string, TaskImplementation>;
