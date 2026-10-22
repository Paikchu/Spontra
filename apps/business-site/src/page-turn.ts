import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

/**
 * Home and a company trade places: the search card grows into the company's rail, its field becoming the company row,
 * and the rail shrinks back into the card on the way home. The names that pair them exist only while `data-vt` is set;
 * without view transitions, or with reduced motion, the page swaps at once.
 */
let turn: ViewTransition | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export function turnPage(update: () => void) {
  if (typeof document.startViewTransition !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) { update(); return; }
  const root = document.documentElement;
  root.dataset.vt = "page";
  const transition = document.startViewTransition(() => flushSync(update));
  turn = transition;
  const done = () => {
    if (turn !== transition) return;
    turn = null;
    delete root.dataset.vt;
    notify();
  };
  transition.finished.then(done, done);
  notify();
}

/** True while a page turn is in flight. A browser skips the turn when an element it pairs leaves the page, so pages hold their rail until it lands. */
export function usePageTurning() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => turn !== null);
}
