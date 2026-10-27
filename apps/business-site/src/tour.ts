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

/** Keep a visible spotlight and reserve space for the measured coach on short screens. */
export function tourLayout(rect: { top: number; left: number; width: number; height: number }, width: number, height: number, cardHeight: number, mobile: boolean) {
  const cardWidth = Math.min(300, width - 24);
  const left = Math.max(12, Math.min(rect.left, width - cardWidth - 12));
  const below = rect.top + rect.height + 18;
  const above = rect.top - cardHeight - 18;
  const top = !mobile && below + cardHeight <= height - 12 ? below
    : !mobile && above >= 12 ? above : Math.max(12, height - cardHeight - 12);
  const holeLeft = Math.max(8, rect.left - 6);
  const rawTop = Math.max(8, rect.top - 6);
  const holeTop = rawTop >= top ? Math.max(rawTop, top + cardHeight + 12) : rawTop;
  const holeRight = Math.min(width - 8, rect.left + rect.width + 6);
  const holeBottom = Math.min(height - 8, rect.top + rect.height + 6, top > holeTop ? top - 12 : height - 8);
  return {
    hole: holeRight > holeLeft && holeBottom > holeTop ? { top: holeTop, left: holeLeft, width: holeRight - holeLeft, height: holeBottom - holeTop } : null,
    card: { top, left, width: cardWidth, height: cardHeight },
  };
}
