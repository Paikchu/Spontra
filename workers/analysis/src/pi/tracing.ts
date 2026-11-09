/** The part of the Workers custom spans API the Pi host uses. */
export type PiSpan = { setAttribute(key: string, value: string | number | boolean | undefined): void; end(): void };
export type PiTracer = { enterSpan<T>(name: string, callback: (span: PiSpan) => T): T };

/** Set by the Worker's entry module, the one file that loads `cloudflare:workers`; unset, nothing is traced. */
let tracer: PiTracer | undefined;
export function installPiTracer(value: PiTracer | undefined) { tracer = value; }
export const currentPiTracer = () => tracer;

const PROVIDER = "deepseek";
const AGENT_VERSION = "1";
type Identity = { kind: string; conversation: string };
export type ToolTrace = { name: string; callId: string; durationMs: number; error: boolean };
/** One turn, metadata only: names, models, token counts, timings and outcomes, never messages or tool payloads. */
export type TurnTrace = Identity & { model: string; turn: number; durationMs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; finishReason?: string; error: boolean; tools: ToolTrace[] };
type Open = TurnTrace & { startedAt: number };

/** A trace never fails the work it observes. */
function quietly<T>(work: () => T, fallback: T): T {
  try { return work(); } catch { return fallback; }
}

/**
 * Records what each turn of a Pi session did. Pi carries a session on past the invocation that started it, into a
 * context whose trace has already closed, and every span made there is lost, the platform's own included. So nothing is
 * traced while a turn runs: its record goes to `sink` when it ends, and `emitTurnSpans` writes the spans later, from an
 * invocation of its own.
 */
export class PiTurnTraces {
  private readonly open = new Map<string, Open>();
  private readonly sink: (turn: TurnTrace) => void;
  constructor(sink: (turn: TurnTrace) => void) { this.sink = sink; }

  beginTurn(who: Identity, model: string, turn: number) {
    this.endTurn(who.conversation);
    this.open.set(who.conversation, { kind: who.kind, conversation: who.conversation, model, turn, durationMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, error: false, tools: [], startedAt: Date.now() });
  }

  endChat(conversation: string, result: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number; finishReason?: string; error?: boolean }) {
    const open = this.open.get(conversation);
    if (!open) return;
    open.inputTokens = result.inputTokens;
    open.outputTokens = result.outputTokens;
    open.cacheReadTokens = result.cacheReadTokens ?? 0;
    open.cacheCreationTokens = result.cacheCreationTokens ?? 0;
    open.durationMs = Date.now() - open.startedAt;
    if (result.finishReason) open.finishReason = result.finishReason;
    open.error = Boolean(result.error);
  }

  endTurn(conversation: string) {
    const open = this.open.get(conversation);
    if (!open) return;
    this.open.delete(conversation);
    const { startedAt: _started, ...turn } = open;
    void _started;
    quietly(() => this.sink(turn), undefined);
  }

  /** One tool run, timed; the outcome's error flag is recorded, its content is not. */
  async tool<R extends { error?: boolean }>(who: Identity, name: string, callId: string, work: () => Promise<R>): Promise<R> {
    const startedAt = Date.now();
    const result = await work();
    this.open.get(who.conversation)?.tools.push({ name, callId, durationMs: Date.now() - startedAt, error: Boolean(result.error) });
    return result;
  }
}

function identify(span: PiSpan, operation: string, turn: Identity) {
  span.setAttribute("gen_ai.operation.name", operation);
  span.setAttribute("gen_ai.agent.name", `spontra-${turn.kind}`);
  span.setAttribute("gen_ai.agent.id", `spontra-analysis/${turn.kind}`);
  span.setAttribute("gen_ai.conversation.id", turn.conversation);
  span.setAttribute("gen_ai.agent.version", AGENT_VERSION);
  span.setAttribute("cloudflare.agents.integration.name", "pi");
}

/** What a model call and the turn around it share, as the Agents SDK writes them on its own spans. */
function describeModel(span: PiSpan, turn: TurnTrace) {
  span.setAttribute("gen_ai.provider.name", PROVIDER);
  span.setAttribute("cloudflare.agents.operation.name", "pi.turn");
  span.setAttribute("cloudflare.agents.turn.request_id", `${turn.conversation}:${turn.turn}`);
  span.setAttribute("gen_ai.request.model", turn.model);
}

/** One recorded turn as the GenAI spans the Agents dashboard reads: `invoke_agent` holding `chat` and each `execute_tool`. */
export function emitTurnSpans(trace: PiTracer | undefined, turn: TurnTrace) {
  if (!trace) return;
  quietly(() => trace.enterSpan(`invoke_agent spontra-${turn.kind}`, (agent) => {
    identify(agent, "invoke_agent", turn);
    describeModel(agent, turn);
    agent.setAttribute("spontra.turn", turn.turn);
    agent.setAttribute("spontra.duration_ms", turn.durationMs);
    trace.enterSpan(`chat ${turn.model}`, (chat) => {
      identify(chat, "chat", turn);
      describeModel(chat, turn);
      chat.setAttribute("gen_ai.response.model", turn.model);
      chat.setAttribute("gen_ai.usage.input_tokens", turn.inputTokens);
      chat.setAttribute("gen_ai.usage.output_tokens", turn.outputTokens);
      chat.setAttribute("gen_ai.usage.cache_read.input_tokens", turn.cacheReadTokens);
      chat.setAttribute("gen_ai.usage.cache_creation.input_tokens", turn.cacheCreationTokens);
      chat.setAttribute("cloudflare.agents.usage.total_tokens", turn.inputTokens + turn.outputTokens);
      chat.setAttribute("cloudflare.agents.tool.count", turn.tools.length);
      if (turn.finishReason) chat.setAttribute("cloudflare.agents.response.finish_reason", turn.finishReason);
      chat.setAttribute("spontra.duration_ms", turn.durationMs);
      if (turn.finishReason) chat.setAttribute("gen_ai.response.finish_reasons", turn.finishReason);
      if (turn.error) chat.setAttribute("error.type", "model_error");
    });
    for (const tool of turn.tools) trace.enterSpan(`execute_tool ${tool.name}`, (span) => {
      identify(span, "execute_tool", turn);
      span.setAttribute("gen_ai.tool.name", tool.name);
      span.setAttribute("gen_ai.tool.call.id", tool.callId);
      span.setAttribute("spontra.duration_ms", tool.durationMs);
      if (tool.error) span.setAttribute("error.type", "tool_error");
    });
  }), undefined);
}
