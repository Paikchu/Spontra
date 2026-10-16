import { motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/packages/web/src/ui/button";

const NONE: ReadonlyMap<string, number> = new Map();
/** How long a row stays marked as new: its entrance and the glow that fades after it. */
const MARKED_MS = 2600;

/**
 * The rows a taken update brought, each with its place among them for a staggered entrance. `updates` counts the updates
 * the reader took; rows that appear for any other reason (the first load filling in, a filter) are not marked.
 */
export function useArrivals(ids: readonly string[], updates: number): ReadonlyMap<string, number> {
  const [arrived, setArrived] = useState(NONE);
  // A list that first mounts because an update brought it (a company's first findings) enters whole.
  const before = useRef<Set<string> | null>(updates > 0 ? new Set() : null);
  const taken = useRef(updates > 0 ? updates - 1 : updates);
  const timer = useRef(0);
  const key = ids.join("\n");
  // Before paint, so a new row is never drawn once without its entrance.
  useLayoutEffect(() => {
    const previous = before.current;
    before.current = new Set(ids);
    const update = taken.current !== updates;
    taken.current = updates;
    const fresh = previous && update ? ids.filter(id => !previous.has(id)) : [];
    if (!fresh.length) return;
    setArrived(new Map(fresh.map((id, i) => [id, i])));
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setArrived(NONE), MARKED_MS + fresh.length * 60);
  }, [key, updates]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(timer.current), []);
  return arrived;
}

/** A rail row that slides to its new place when an update reorders the list, and fades out when the update drops it. */
export const RailRow = motion.create(Button);
/** Rows an update brought enter one after another; the rest make room for them. */
export const arrivalStyle = (index: number | undefined): CSSProperties | undefined => index == null ? undefined : { ["--arrive" as string]: index };
export const rowExit = { opacity: 0, transition: { duration: .18 } };
