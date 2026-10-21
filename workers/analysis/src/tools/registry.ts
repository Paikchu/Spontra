import { z } from "zod";
import { toolResult, type AgentBlock, type AgentSchema, type AgentTool, type ToolCall } from "../tool-loop.ts";

/**
 * The tool contract every agent shares (docs/stage-agent-design.md §4), after DeepSeek Harness's `ToolDefinition`:
 * typed parameters checked before the call, a decision before it runs (allow, deny, or ask the reader) and after
 * (accept, or block with feedback the model reads), and an observation written for the model. `S` is the run's own
 * state (materials read, numbers resolved, the last compile) that the tools of one run share.
 */
export type ToolDefinition<A, R, S> = {
  name: string;
  description: string;
  parameters: z.ZodType<A>;
  /** Strict schemas close every object; a tool taking a whole document leaves it open and the harness checks it. */
  strict?: boolean;
  execute(args: A, ctx: ToolContext<S>): Promise<R> | R;
  /** What the model reads back; the loop appends the budget line. */
  observe(args: A, value: R, state: S): string;
  timeoutMs?: number;
  concurrencySafe?: boolean;
  /** The daily allowance a call draws on besides the model call itself. */
  budget?: "web" | "research" | "report" | null;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool<S> = ToolDefinition<any, any, S>;

/** Declares a tool with its parameter and result types inferred, then widens it for a recipe's list. */
export const defineTool = <S>() => <A, R>(tool: ToolDefinition<A, R, S>): AnyTool<S> => tool as AnyTool<S>;

/**
 * `stage` runs one piece of outside work durably: in a Workflow a named step whose result is replayed after a restart,
 * in the stage a plain call. A tool fetches inside it and updates the run's state from what it returns, so a replay
 * rebuilds the same state without fetching again.
 */
export type ToolContext<S> = { state: S; signal: AbortSignal; recipe: string; stage: <T>(name: string, work: () => Promise<T>) => Promise<T> };
export type PreToolDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "ask"; question: string };
export type PostToolDecision = { kind: "accept" } | { kind: "block"; feedback: string };
export type ToolExecution = { name: string; args: unknown };
export type ToolPolicy = {
  allow: readonly string[];
  pre?: (exec: ToolExecution) => PreToolDecision;
  post?: (exec: ToolExecution, value: unknown) => PostToolDecision;
};
/** One call's outcome as the loop records it. */
export type ToolOutcome = { observation: string; error?: boolean; value?: unknown; asked?: string };

/** The model-facing schema of a tool, from its zod parameters. */
export function toolSchema<S>(tool: AnyTool<S>): AgentTool {
  const json = z.toJSONSchema(tool.parameters, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  const { $schema: _schema, ...rest } = json;
  const input_schema = { type: "object", properties: {}, required: [], ...(tool.strict === false ? rest : closed(rest)) } as AgentSchema;
  return { name: tool.name, description: tool.description, ...(tool.strict === false ? {} : { strict: true as const }), input_schema };
}

/** Keywords a strict tool schema cannot carry; the parameters' zod schema still enforces them when the call runs. */
const UNSUPPORTED_IN_STRICT = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "format", "maxItems", "default"]);

/**
 * A strict tool's arguments always match its schema, so every object in the schema is closed, and the bounds strict
 * schemas do not support (numeric ranges, string lengths and patterns, array sizes beyond "at least one") are left
 * to the harness's own check of the arguments.
 */
function closed(node: unknown): Record<string, unknown> {
  if (Array.isArray(node)) return node.map(closed) as unknown as Record<string, unknown>;
  if (!node || typeof node !== "object") return node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (UNSUPPORTED_IN_STRICT.has(k) || (k === "minItems" && typeof v === "number" && v > 1)) continue;
    out[k] = typeof v === "object" ? closed(v) : v;
  }
  if (out.type === "object" && out.properties) out.additionalProperties = false;
  return out;
}

export function schemasFor<S>(tools: AnyTool<S>[], policy: ToolPolicy): AgentTool[] {
  return tools.filter(t => policy.allow.includes(t.name)).map(toolSchema);
}

/**
 * Runs one call through the pipeline: allowed by the policy, parameters through the schema, the pre decision, the
 * call itself under its timeout, then the post decision. An ordinary failure is an observation, never a thrown error,
 * so a turn goes on; `ask` comes back to the executor, which either asks the reader or treats it as a refusal.
 */
export async function runTool<S>(tools: AnyTool<S>[], policy: ToolPolicy, call: { name: string; input: unknown }, ctx: ToolContext<S>): Promise<ToolOutcome> {
  const name = call.name.trim();
  const tool = tools.find(t => t.name === name);
  if (!tool || !policy.allow.includes(name)) return { observation: `There is no tool "${name}". Use one of: ${policy.allow.join(", ")}.`, error: true };
  const raw = typeof call.input === "string" ? safeJson(call.input) : call.input;
  const parsed = tool.parameters.safeParse(raw ?? {});
  if (!parsed.success) return { observation: `The arguments do not match ${name}'s schema: ${parsed.error.issues.slice(0, 6).map(i => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ")}`, error: true };
  const exec = { name, args: parsed.data };
  const pre = policy.pre?.(exec) ?? { kind: "allow" };
  if (pre.kind === "deny") return { observation: `Not run: ${pre.reason}`, error: true };
  if (pre.kind === "ask") return { observation: "", asked: pre.question };
  let value: unknown;
  try { value = await withTimeout(Promise.resolve(tool.execute(parsed.data, ctx)), tool.timeoutMs ?? 60_000, name); }
  catch (error) { return { observation: `${name} failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000), error: true }; }
  const post = policy.post?.(exec, value) ?? { kind: "accept" };
  if (post.kind === "block") return { observation: post.feedback, error: true, value };
  return { observation: tool.observe(parsed.data, value, ctx.state), value };
}

/** The call's tool_result block. */
export const resultBlock = (call: ToolCall, outcome: ToolOutcome, budgetLine: string): AgentBlock => toolResult(call, `${outcome.observation}${budgetLine ? `\n\n${budgetLine}` : ""}`, outcome.error);

function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return text; } }

async function withTimeout<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} took longer than ${ms / 1000}s`)), ms); })]); }
  finally { clearTimeout(timer); }
}
