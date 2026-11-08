import { z } from "zod";
import { nativeSearchSchema, type NativeSearch } from "../web-search/native.ts";
import type { AgentClientTool } from "../tool-loop.ts";
import type { AnyTool, ToolPolicy } from "../tools/registry.ts";

/** What a hand-written tool answers: the observation the model reads, and whether the call failed. */
export type HandResult = { observation: string; error?: boolean };
type Args = Record<string, unknown>;

/**
 * A tool whose schema is written by hand and whose run reads and updates the recipe state, so the state alone (stored
 * after every call) carries the session across an eviction.
 */
export function handTool<S>(schema: AgentClientTool, run: (args: Args, state: S) => Promise<HandResult> | HandResult): AnyTool<S> {
  return {
    name: schema.name, description: schema.description, schema, strict: false, parameters: z.record(z.string(), z.unknown()),
    execute: (args: Args, ctx) => run(args, ctx.state), observe: (_args: Args, value: HandResult) => value.observation,
  };
}

/** The web search a session makes, handed to the recipe as one batch of hits; `remaining` hides it once spent. */
export function handSearch<S>(name: string, remaining: (state: S) => number, run: (batch: NativeSearch, state: S) => Promise<HandResult> | HandResult, excluded?: string[]): AnyTool<S> {
  return {
    name, description: "Register web search results.", parameters: nativeSearchSchema, nativeSearch: { remaining, ...(excluded ? { excluded } : {}) },
    execute: (batch: NativeSearch, ctx) => run(batch, ctx.state), observe: (_args: NativeSearch, value: HandResult) => value.observation,
  };
}

/** Every tool allowed; a failed call reads as an error to the model. */
export const handPolicy = (tools: readonly { name: string }[]): ToolPolicy => ({
  allow: tools.map((t) => t.name),
  post: (_exec, value) => (value as HandResult | undefined)?.error ? { kind: "block", feedback: (value as HandResult).observation } : { kind: "accept" },
});
