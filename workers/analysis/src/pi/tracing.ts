/** The part of the Workers custom spans API the Pi host uses. */
export type PiSpan = { setAttribute(key: string, value: string | number | boolean | undefined): void; end(): void };
export type PiTracer = { startSpan(name: string): PiSpan; enterSpan<T>(name: string, callback: (span: PiSpan) => T): T };

/** Set by the Worker's entry module, the one file that loads `cloudflare:workers`; unset, nothing is traced. */
let tracer: PiTracer | undefined;
export function installPiTracer(value: PiTracer | undefined) { tracer = value; }

type Identity = { kind: string; conversation: string };
type Open = { turn: PiSpan; chat: PiSpan | null };
const NOOP: PiSpan = { setAttribute() {}, end() {} };

/** A trace never fails the work it observes. */
function quietly<T>(work: () => T, fallback: T): T {
  try { return work(); } catch { return fallback; }
}

/**
 * The GenAI spans of Pi sessions, metadata only: names, models, token counts and outcomes, never messages or tool
 * payloads. A turn is one model request and the tool calls of its reply. Pi drives the loop through separate hooks, so
 * no callback encloses a turn: `invoke_agent` and `chat` are opened and closed by hand and do not nest in the waterfall;
 * the agent and conversation attributes tie them together. A turn cut by an eviction is closed by the runtime.
 */
export class PiTurnTraces {
  private readonly open = new Map<string, Open>();
  private readonly source: () => PiTracer | undefined;
  constructor(source: () => PiTracer | undefined = () => tracer) { this.source = source; }

  private identify(span: PiSpan, operation: string, who: Identity) {
    span.setAttribute("gen_ai.operation.name", operation);
    span.setAttribute("gen_ai.agent.name", `spontra-${who.kind}`);
    span.setAttribute("gen_ai.agent.id", `spontra-analysis/${who.kind}`);
    span.setAttribute("gen_ai.conversation.id", who.conversation);
  }

  beginTurn(who: Identity, model: string, turn: number) {
    this.endTurn(who.conversation);
    quietly(() => {
      const t = this.source();
      if (!t) return;
      const agent = t.startSpan(`invoke_agent spontra-${who.kind}`), chat = t.startSpan(`chat ${model}`);
      this.identify(agent, "invoke_agent", who);
      this.identify(chat, "chat", who);
      agent.setAttribute("spontra.turn", turn);
      chat.setAttribute("gen_ai.request.model", model);
      this.open.set(who.conversation, { turn: agent, chat });
    }, undefined);
  }

  endChat(conversation: string, result: { inputTokens: number; outputTokens: number; finishReason?: string; error?: boolean }) {
    quietly(() => {
      const open = this.open.get(conversation);
      if (!open?.chat) return;
      open.chat.setAttribute("gen_ai.usage.input_tokens", result.inputTokens);
      open.chat.setAttribute("gen_ai.usage.output_tokens", result.outputTokens);
      if (result.finishReason) open.chat.setAttribute("gen_ai.response.finish_reasons", result.finishReason);
      if (result.error) open.chat.setAttribute("error.type", "model_error");
      open.chat.end();
      open.chat = null;
    }, undefined);
  }

  endTurn(conversation: string) {
    quietly(() => {
      const open = this.open.get(conversation);
      if (!open) return;
      this.open.delete(conversation);
      open.chat?.end();
      open.turn.end();
    }, undefined);
  }

  /** One tool run, its span open while it runs; the outcome's error flag is recorded, its content is not. */
  async tool<R extends { error?: boolean }>(who: Identity, name: string, callId: string, work: () => Promise<R>): Promise<R> {
    const t = quietly(() => this.source(), undefined);
    if (!t) return work();
    let started = false;
    const run = async (span: PiSpan) => {
      started = true;
      quietly(() => {
        this.identify(span, "execute_tool", who);
        span.setAttribute("gen_ai.tool.name", name);
        span.setAttribute("gen_ai.tool.call.id", callId);
      }, undefined);
      const result = await work();
      if (result.error) quietly(() => span.setAttribute("error.type", "tool_error"), undefined);
      return result;
    };
    try { return await t.enterSpan(`execute_tool ${name}`, run); }
    catch (error) { if (started) throw error; return run(NOOP); }
  }
}
