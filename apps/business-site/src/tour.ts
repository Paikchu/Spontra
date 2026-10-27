export const TOUR_DONE_KEY = "bv-tour-done";
/** Set by an automated run that wants the first-visit tour. Ordinary webdriver sessions leave it unset. */
export const TOUR_FORCE_KEY = "bv-tour-auto";
export const TOUR_STEPS = 3 as const;

export type TourStep = 0 | 1 | 2;
export type TourKey = "next" | "back" | "skip";

export type TourMove =
  | { type: "step"; step: TourStep }
  | { type: "done" }
  | { type: "skip" }
  | { type: "stay" };

export function readTourDone(storage: { getItem(key: string): string | null } | null): boolean {
  try { return storage?.getItem(TOUR_DONE_KEY) === "1"; } catch { return false; }
}

export function writeTourDone(storage: { setItem(key: string, value: string): void } | null): void {
  try { storage?.setItem(TOUR_DONE_KEY, "1"); } catch { /* Private mode. */ }
}

/**
 * Real first visits open the tour. Playwright sets `navigator.webdriver`, and the existing company-page
 * screenshots do not expect a layer, so those runs stay quiet unless they opt in with `bv-tour-auto`.
 * A finished tour (`bv-tour-done`) never auto-opens; the rail button ignores this and starts at step 1.
 */
export function shouldAutoOpen(input: { done: boolean; webdriver: boolean; force: boolean }): boolean {
  if (input.done) return false;
  if (input.webdriver && !input.force) return false;
  return true;
}

export function tourKey(key: string): TourKey | null {
  if (key === "ArrowRight" || key === "Enter") return "next";
  if (key === "ArrowLeft") return "back";
  if (key === "Escape") return "skip";
  return null;
}

export function reduceTour(step: TourStep, action: TourKey): TourMove {
  if (action === "skip") return { type: "skip" };
  if (action === "back") return step === 0 ? { type: "stay" } : { type: "step", step: (step - 1) as TourStep };
  if (step === 2) return { type: "done" };
  return { type: "step", step: (step + 1) as TourStep };
}
