/** What the company page shows. The map waits until the opening read has settled, so it never paints half-empty. */
export type OpeningFace = "map" | "failed" | "state" | "loading";

export function openingFace(state: { ready: boolean; failed: boolean; flow: boolean; publication: boolean }): OpeningFace {
  if (!state.ready) return state.failed ? "failed" : "loading";
  if (state.flow) return "map";
  if (state.failed) return "failed";
  if (state.publication) return "state";
  return "loading";
}
