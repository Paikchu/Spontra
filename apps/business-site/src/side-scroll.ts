import { useEffect, useState, type RefObject } from "react";

/** How long the swipe hint stays before it fades on its own. */
export const HINT_MS = 3000;

export type SideScroll = { overflow: boolean; atEnd: boolean };

/** Whether a box holds more than it shows sideways, and whether the reader has reached its right edge (a pixel of slack). */
export function sideScroll(box: { scrollLeft: number; scrollWidth: number; clientWidth: number }): SideScroll {
  const overflow = box.scrollWidth - box.clientWidth > 1;
  return { overflow, atEnd: !overflow || box.scrollLeft + box.clientWidth >= box.scrollWidth - 1 };
}

/**
 * A sideways scroller's state for its edge mask and its "swipe" hint. The hint shows while the content overflows and
 * the reader has not scrolled yet, for {@link HINT_MS} at most; the mask stays until the right edge is reached.
 */
export function useSideScroll(ref: RefObject<HTMLElement | null>, key: unknown): SideScroll & { hint: boolean } {
  const [state, setState] = useState<SideScroll>({ overflow: false, atEnd: true });
  const [hint, setHint] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setHint(true);
    const measure = () => setState(sideScroll(el));
    const onScroll = () => { measure(); if (el.scrollLeft > 4) setHint(false); };
    measure();
    const timer = window.setTimeout(() => setHint(false), HINT_MS);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    for (const child of el.children) observer?.observe(child);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.clearTimeout(timer); observer?.disconnect(); el.removeEventListener("scroll", onScroll); };
  }, [ref, key]);
  return { ...state, hint: hint && state.overflow && !state.atEnd };
}

/** True while the viewport matches the query; false where there is no window (the server render). */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia(query);
    const apply = () => setMatches(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [query]);
  return matches;
}
