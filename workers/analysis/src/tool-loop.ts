/**
 * What an agent loop acting through Claude client tools needs. The exchange only
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
export type AgentClientTool = { name: string; description: string; strict?: true; input_schema: AgentSchema };
/** One turn's reply: its content blocks as they are to be sent back and why it stopped, or why there is no reply. */
export type AgentReply = { content: AgentBlock[]; stopReason: string | null; refusalCategory?: string | null } | { error: string };
export type ToolCall = AgentBlock & { id: string; name: string; input: unknown };

/** Tool calls one reply may make that the harness runs; the rest are answered "not run". */
export const CALLS_PER_TURN = 4;

/** A closed object schema, as a strict tool needs; properties left out of `required` are optional. */
export const closedObject = (properties: Record<string, unknown>, required = Object.keys(properties)): AgentSchema => ({ type: "object", properties, required, additionalProperties: false });


/** An object, or one written as a JSON string; anything else is null. */
export function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim().startsWith("{")) { try { return asObject(JSON.parse(value)); } catch { return null; } }
  return null;
}
