"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

/* Light effects that follow real interaction only (see Design System README "光与动效"). */

let hydrated = false;
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Mount last inside <body>. Passive effects run after every earlier sibling's layout effects,
 * so components hydrating with the first server response see `hydrated === false` and keep
 * the server-rendered value instead of flashing back to zero.
 */
export function SpontraEffects() {
  useEffect(() => {
    hydrated = true;
    let frame = 0;
    let pending: PointerEvent | null = null;
    const paint = () => {
      frame = 0;
      const event = pending;
      pending = null;
      const target = (event?.target as Element | null)?.closest?.<HTMLElement>(".sp-lit");
      if (!event || !target) return;
      const box = target.getBoundingClientRect();
      target.style.setProperty("--mx", `${event.clientX - box.left}px`);
      target.style.setProperty("--my", `${event.clientY - box.top}px`);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      pending = event;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    document.addEventListener("pointermove", move, { passive: true });
    return () => { document.removeEventListener("pointermove", move); if (frame) cancelAnimationFrame(frame); };
  }, []);
  return null;
}

/**
 * Rolls the first number in `value` (e.g. "$82,003.54") up from zero when the page is opened
 * inside the app. The server render and reduced-motion users always get the final text.
 * The tween writes to the existing text node, so React state and reconciliation stay untouched.
 */
export function CountUp({ value, duration = 1100 }: { value: string; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = ref.current?.firstChild;
    const match = /-?[\d,]*\.?\d+/.exec(value);
    if (!hydrated || reducedMotion() || !node || node.nodeType !== Node.TEXT_NODE || !match) return;
    const target = Number.parseFloat(match[0].replace(/,/g, ""));
    const decimals = match[0].includes(".") ? match[0].split(".")[1].length : 0;
    const render = (progress: number) => {
      const current = (Math.abs(target) * progress).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      node.nodeValue = value.slice(0, match.index) + (target < 0 ? "-" : "") + current + value.slice(match.index + match[0].length);
    };
    let start: number | null = null;
    let frame = 0;
    const tick = (time: number) => {
      start ??= time;
      const k = Math.min(1, (time - start) / duration);
      if (k < 1) { render(1 - Math.pow(1 - k, 3)); frame = requestAnimationFrame(tick); }
      else node.nodeValue = value;
    };
    render(0);
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); node.nodeValue = value; };
  }, [value, duration]);
  return <span ref={ref}>{value}</span>;
}
