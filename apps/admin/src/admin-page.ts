import { createContext, useContext, useEffect, useRef } from "react";

/**
 * Whether a page of the admin is the one shown. A visited page stays mounted with its data when another is opened;
 * a hidden page polls nothing and leaves the address bar alone.
 */
export const PageActive = createContext(true);

/** Whether the page is shown, as a ref for timers and listeners that are set up once. */
export function usePageActive() {
  const active = useContext(PageActive), ref = useRef(active);
  useEffect(() => { ref.current = active; }, [active]);
  return ref;
}

/** Runs `refresh` each time the page is shown again: what it kept shows at once and is brought up to date behind it. */
export function useOnReturn(refresh: () => void) {
  const active = useContext(PageActive), was = useRef(active), latest = useRef(refresh);
  useEffect(() => { latest.current = refresh; });
  useEffect(() => { if (active && !was.current) latest.current(); was.current = active; }, [active]);
}
