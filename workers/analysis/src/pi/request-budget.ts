import type { Models } from "@earendil-works/pi-ai";

export type ProviderRequestGate = () => Promise<void>;

/**
 * Pi hooks are advisory: its scheduler catches their exceptions. Enforce opt-in budgets at the HTTP transport,
 * outside that hook chain. The provider calls this fetch again for every SDK retry; parallel streams keep their
 * own persisted provider-session identity. completeSimple (including compaction) delegates to streamSimple.
 */
export function installProviderRequestGate(models: Models, resolve: (sessionId: string | undefined) => Promise<ProviderRequestGate | null>) {
  const stream = models.streamSimple.bind(models);
  models.streamSimple = (model, context, options) => {
    const send = options?.fetch ?? globalThis.fetch;
    return stream(model, context, {
      ...options,
      // Spontra registers only Chat Completions HTTP models; an alternate transport must not bypass this gate.
      transport: "sse",
      fetch: async (input, init) => {
        const gate = await resolve(options?.sessionId);
        await gate?.();
        return send(input, init);
      },
    });
  };
}
