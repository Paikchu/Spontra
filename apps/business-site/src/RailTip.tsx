import { useEffect, useRef, useState, type FocusEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";

type Tip = { title: string; lang?: string; meta?: string; left: number; top: number; width: number };

/**
 * A rail row's full title, laid over the row once the pointer rests on it: rows are one line, so a long
 * title is cut short in place. A muted second line carries the row's particulars (class, form, date, role).
 * The card sits in a portal at the row's own position, so the rail's clipping never cuts it, and any
 * scroll or blur takes it away.
 */
export function useRailTip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    addEventListener("scroll", hide, true);
    return () => removeEventListener("scroll", hide, true);
  }, [tip]);
  const hide = () => { clearTimeout(timer.current); setTip(null); };
  /** Handlers for one row: the card shows the row's `.finding-title` in full, from its left edge to the row's right. */
  const bind = (title: string, lang: string | undefined, meta?: string) => {
    const show = (el: HTMLElement) => {
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const row = el.getBoundingClientRect();
        const at = (el.querySelector<HTMLElement>(".finding-title") ?? el).getBoundingClientRect();
        setTip({ title, lang, meta, left: at.left - 10, top: row.top, width: row.right - at.left + 10 });
      }, 250);
    };
    return {
      onMouseEnter: (e: MouseEvent<HTMLElement>) => show(e.currentTarget),
      onMouseLeave: hide,
      onFocus: (e: FocusEvent<HTMLElement>) => { if (e.currentTarget.matches(":focus-visible")) show(e.currentTarget); },
      onBlur: hide,
    };
  };
  const node = tip && createPortal(<div className="rail-tip" role="tooltip" style={{ left: tip.left, top: tip.top, width: tip.width }}>
    <span lang={tip.lang}>{tip.title}</span>
    {tip.meta && <small>{tip.meta}</small>}
  </div>, document.body);
  return { bind, hide, node };
}
