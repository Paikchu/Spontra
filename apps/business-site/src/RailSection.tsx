import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/packages/web/src/ui/button";

/** The rail sections; each can open over the whole rail. */
export type RailSectionKey = "business" | "findings" | "events";

/**
 * Swaps the rail between its digest and one section's full list. Where the browser has view
 * transitions the section grows from its place into the rail; elsewhere, or with reduced motion, it swaps at once.
 */
export function railTransition(update: () => void) {
  if (typeof document.startViewTransition !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) { update(); return; }
  document.startViewTransition(() => flushSync(update));
}

/**
 * One section of the rail, the same shape for businesses, findings and filings: a title, icon actions, and a chevron
 * that opens the whole list over the rail. Closed, rows outside the digest carry `data-extra` and stay hidden on wide
 * screens; open, every row shows and a back button (or Escape, once nothing in it is in focus) returns.
 * As a drawer the section has no header: its first row is the head and toggles it, and the rows unfold under it in place.
 * The body must carry `id="rail-<name>"`.
 */
export function RailSection({ name, title, hint, expandable, expanded, focused, drawer = false, onExpand, actions, children }: {
  name: RailSectionKey;
  title: string;
  /** Context for the chevron's tooltip, such as the report the rows come from. */
  hint?: string;
  /** The digest hides some rows, so opening the section shows more. */
  expandable: boolean;
  expanded: boolean;
  /** A row of this section is in focus: Escape clears it before closing the section. */
  focused: boolean;
  /** Open in place, under the section's first row, rather than over the whole rail. */
  drawer?: boolean;
  onExpand: (open: boolean) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const more = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    (expanded ? back : more).current?.focus({ preventScroll: true });
  }, [expanded]);
  const toggle = (open: boolean) => { moved.current = true; onExpand(open); };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (drawer || !expanded || e.key !== "Escape" || focused) return;
    e.stopPropagation();
    toggle(false);
  };
  const open = expanded ? "" : undefined;
  return <section className="findings" data-section={name} data-expanded={drawer ? undefined : open} data-open={drawer ? open : undefined} data-focus={focused ? "" : undefined} aria-label={title} onKeyDown={onKeyDown}>
    {!drawer && <header className="findings-head">
      {expanded && <Button variant="unstyled" type="button" ref={back} className="icon-button section-back" aria-label={`收起${title}`} title="返回 (Esc)" onClick={() => toggle(false)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 6-6 6 6 6" /></svg>
      </Button>}
      <span className="findings-title">{title}</span>
      {actions}
      {expandable && !expanded && <Button variant="unstyled" type="button" ref={more} className="icon-button section-action section-expand" aria-expanded={false} aria-controls={`rail-${name}`}
        aria-label={`展开全部${title}`} title={hint ? `展开全部 · ${hint}` : "展开全部"} onClick={() => toggle(true)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
      </Button>}
    </header>}
    {children}
  </section>;
}
