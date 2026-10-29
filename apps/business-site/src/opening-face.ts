/** What the company page shows. The map waits for the active view; supplemental sections can settle independently. */
export type OpeningFace = "map" | "failed" | "state" | "loading";

export function openingFace(state: { ready: boolean; failed: boolean; flow: boolean; publication: boolean }): OpeningFace {
  if (!state.ready) return state.failed ? "failed" : "loading";
  if (state.flow) return "map";
  if (state.failed) return "failed";
  if (state.publication) return "state";
  return "loading";
}
