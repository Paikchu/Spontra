import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import type { FiscalLabelSource } from "@/shared/analysis-contract/period";
import { periodLabel, type PeriodCopy } from "@/shared/analysis-runtime/fiscal-label";
import { getLocale } from "@/packages/web/src/i18n";

type Phase = "closed" | "open" | "closing";

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
  return reduced;
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 620px)");
    const apply = () => setNarrow(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
  return narrow;
}

/** One delayed tooltip. Hover and keyboard focus wait 150ms; a touch toggles immediately. */
function useMarkTip(text: string) {
  const id = useId();
  const reduced = useReducedMotion();
  const anchor = useRef<HTMLElement | null>(null);
  const openTimer = useRef(0);
  const closeTimer = useRef(0);
  const [phase, setPhase] = useState<Phase>("closed");
  const [box, setBox] = useState({ left: 8, top: 8 });
  useEffect(() => () => { window.clearTimeout(openTimer.current); window.clearTimeout(closeTimer.current); }, []);
  const place = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 16);
    setBox({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: rect.bottom + 6 });
  };
  const show = (el: HTMLElement, immediate = false) => {
    anchor.current = el;
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(openTimer.current);
    const delay = immediate || reduced ? 0 : 150;
    openTimer.current = window.setTimeout(() => { place(el); setPhase("open"); }, delay);
  };
  const hide = () => {
    window.clearTimeout(openTimer.current);
    setPhase(current => {
      if (current !== "open") return "closed";
      window.clearTimeout(closeTimer.current);
      closeTimer.current = window.setTimeout(() => setPhase("closed"), reduced ? 0 : 80);
      return "closing";
    });
  };
  useEffect(() => {
    if (phase === "closed") return;
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") hide(); };
    const onPointer = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && anchor.current?.contains(target)) return;
      hide();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onPointer); };
  }, [phase]);
  const node = phase !== "closed" && typeof document !== "undefined" ? createPortal(
    <div className="period-tip" id={id} role="tooltip" data-state={phase} style={{ left: box.left, top: box.top }}>{text}</div>,
    document.body,
  ) : null;
  return { id, phase, show, hide, node };
}

export type PeriodMarkProps = {
  ticker?: string | null;
  periodEnd: string | null;
  periodStart?: string | null;
  fiscalYear?: number | null;
  fiscalQuarter?: number | null;
  fiscalYearEndMonth?: number | null;
  labelSource?: FiscalLabelSource | null;
  companyName?: string | null;
  /** Pill beside the company header, home-card footer, signal header, or a rail aside. */
  variant: "pill" | "footer" | "signal" | "inline";
  pending?: boolean;
};

/** The one period label. The primary is a button-like mark with a delayed explanation. */
export function PeriodMark({ ticker, periodEnd, periodStart, fiscalYear, fiscalQuarter, fiscalYearEndMonth, labelSource, companyName, variant, pending }: PeriodMarkProps) {
  const narrow = useNarrow();
  const locale = getLocale();
  const labels = periodEnd && !pending ? periodLabel({ ticker, periodEnd, periodStart, fiscalYear, fiscalQuarter, fiscalYearEndMonth, labelSource, companyName }, locale) : null;
  const hideSecondary = !labels?.primary || variant === "signal" || variant === "inline" || (variant === "footer" && narrow);
  const tipText = labels ? (hideSecondary && labels.primary ? `${labels.secondary}\n${labels.tooltip}` : labels.tooltip) : "";
  const tip = useMarkTip(tipText);
  if (pending || !labels) return <span className="period-skeleton" aria-hidden="true" />;
  const text = labels.primary ?? labels.unknown;
  const secondary = variant === "footer" ? labels.secondaryShort : labels.secondary;
  const onMark = (el: HTMLElement, immediate = false) => tip.show(el, immediate);
  return <span className="period-mark" data-variant={variant} data-period={labels.periodEnd} data-ticker={ticker ?? undefined} data-unknown={labels.primary ? undefined : ""} data-calendar={labels.calendarYear ? "" : undefined}>
    <span
      className="period-primary"
      tabIndex={0}
      aria-describedby={tip.phase !== "closed" ? tip.id : undefined}
      onPointerEnter={(event: PointerEvent<HTMLElement>) => { if (event.pointerType !== "touch") onMark(event.currentTarget); }}
      onPointerLeave={(event: PointerEvent<HTMLElement>) => { if (event.pointerType !== "touch") tip.hide(); }}
      onFocus={(event: FocusEvent<HTMLElement>) => onMark(event.currentTarget)}
      onBlur={() => tip.hide()}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => { if (event.key === "Escape") { event.stopPropagation(); tip.hide(); } }}
      onClick={(event: MouseEvent<HTMLElement>) => {
        if (!narrow && event.detail !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (tip.phase === "open") tip.hide();
        else onMark(event.currentTarget, true);
      }}
    >{text}</span>
    {labels.primary && variant === "pill" && <span className="period-secondary"><span className="period-dot" aria-hidden="true">·</span>{secondary}</span>}
    {labels.primary && variant === "footer" && <span className="period-secondary">{secondary}</span>}
    {tip.node}
  </span>;
}

/** Axis date stays YYYY.MM. The current column adds the issuer quarter under it. */
export function QuarterBadge({ ticker, periodEnd, periodStart, current, prefix }: { ticker: string; periodEnd: string; periodStart?: string | null; current: boolean; prefix: string }) {
  const labels = periodLabel({ ticker, periodEnd, periodStart }, getLocale());
  return <span className="trend-period">
    <time dateTime={periodEnd}><span>{periodEnd.slice(0, 4)}</span><span className="trend-period-month">{periodEnd.slice(5, 7)}</span></time>
    {current && <b className="trend-now">{labels.primary ? <><span className="trend-now-prefix">{prefix}</span><span className="trend-now-sep"> · </span><span className="trend-now-fy">{labels.primary}</span></> : labels.unknown}</b>}
  </span>;
}

export function fiscalPhrase(ticker: string, periodEnd: string, periodStart?: string | null): PeriodCopy {
  return periodLabel({ ticker, periodEnd, periodStart }, getLocale());
}
