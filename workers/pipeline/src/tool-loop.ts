/**
 * What an agent loop acting through Claude client tools needs (docs/business-tree.md → 对话形式). The exchange only
 * grows: each reply goes back exactly as it came, thinking included, and each call's result follows it as a
 * tool_result. A loop never asks for its reasoning written out beside a decision (Claude declines that as
 * reasoning_extraction) and never packs past turns into one user message (that reads as a fabricated transcript).
 */

/** A content block as the Messages API writes it (`text`, `thinking`, `tool_use`, `tool_result`, …). */
export type AgentBlock = { type: string } & Record<string, unknown>;
/** One turn of the exchange: the model's replies, exactly as returned, as assistant turns; what the harness answered as user turns. */
export type AgentMessage = { role: "user" | "assistant"; content: string | AgentBlock[] };
export type AgentSchema = { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties?: false };
/**
 * A client tool. A strict tool's arguments always match its schema, so every object in it is closed. A tool taking a
 * whole document is left open: the document grammar is larger than a strict schema may be, and the harness checks it.
 */
export type AgentTool = { name: string; description: string; strict?: true; input_schema: AgentSchema };
/** One turn's reply: its content blocks as they are to be sent back and why it stopped, or why there is no reply. */
export type AgentReply = { content: AgentBlock[]; stopReason: string | null; refusalCategory?: string | null } | { error: string };
/** One turn of a loop, taken through the tools. `messages` is the whole exchange so far; it only ever grows. */
export type AgentAct = (stage: string, system: string, tools: AgentTool[], messages: AgentMessage[]) => Promise<AgentReply>;
export type ToolCall = AgentBlock & { id: string; name: string; input: unknown };

/** Turns in a row with no usable reply before a loop stops: then the provider is failing, not the model's turn. */
export const FAILED_REPLIES = 3;
/** Tool calls one reply may make that the harness runs; the rest are answered "not run". */
export const CALLS_PER_TURN = 4;

/** A closed object schema, as a strict tool needs; properties left out of `required` are optional. */
export const closedObject = (properties: Record<string, unknown>, required = Object.keys(properties)): AgentSchema => ({ type: "object", properties, required, additionalProperties: false });

/**
 * Why a reply cannot join the exchange: the provider failed, Claude declined, or the reply was cut off at the output
 * limit. Such a turn adds nothing, so the next one sends the same exchange again. Null when the reply can join.
 */
export function replyFailure(reply: AgentReply): string | null {
  if ("error" in reply) return reply.error;
  if (reply.stopReason === "refusal") return `refusal${reply.refusalCategory ? ` (${reply.refusalCategory})` : ""}`;
  if (reply.stopReason === "max_tokens") return "max_tokens: the reply was cut off at the output limit";
  return null;
}

/** What a reply says outside its calls, for the operator's trace. */
export const replyText = (content: AgentBlock[]): string => content.flatMap(b => b.type === "text" && typeof b.text === "string" ? [b.text] : []).join(" ").trim();
export const toolCalls = (content: AgentBlock[]): ToolCall[] => content.filter((b): b is ToolCall => b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string");

/** An object, or one written as a JSON string; anything else is null. */
export function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim().startsWith("{")) { try { return asObject(JSON.parse(value)); } catch { return null; } }
  return null;
}

export const toolResult = (call: ToolCall, content: string, error?: boolean): AgentBlock => ({ type: "tool_result", tool_use_id: call.id, content, ...(error ? { is_error: true } : {}) });
