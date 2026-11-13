import type { MaterialRef } from "../../../../shared/analysis-contract/filing-material.ts";
import type { FindingPassage } from "../../../../shared/analysis-contract/findings.ts";
import { materialTools } from "../filing-material/tools.ts";
import type { AnalysisEnv } from "../operations.ts";
import type { AnyTool } from "../tools/registry.ts";

export type SecToolState = { materialRefs?: Record<string, MaterialRef>; used: { finds: number; reads: number } };
export type SecToolBudget = { finds: number; reads: number };
export type SecToolInput<S extends SecToolState> = {
  env: AnalysisEnv; ticker: string; budget: SecToolBudget;
  register: (state: S, passage: FindingPassage) => string;
  spent: { finds: string; reads: string };
};

export function secFilingTools<S extends SecToolState>(input: SecToolInput<S>): AnyTool<S>[] {
  return materialTools<S>({ env: input.env, ticker: input.ticker, register: input.register, pins: state => state.materialRefs ??= {} }).map(tool => ({ ...tool,
    execute: async (args, ctx) => {
      const budget = tool.name === "find_filing_tables" ? "finds" : tool.name.startsWith("read_") ? "reads" : null;
      if (budget) {
        if (ctx.state.used[budget] >= input.budget[budget]) throw new Error(`no ${budget} left; ${input.spent[budget]}`);
        ctx.state.used[budget]++;
      }
      return tool.execute(args, ctx);
    },
  }));
}
