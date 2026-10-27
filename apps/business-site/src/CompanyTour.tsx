import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { messages } from "@/packages/web/src/i18n";
import { track } from "./track";
import { TOUR_FORCE_KEY, readTourDone, reduceTour, shouldAutoOpen, tourKey, writeTourDone, tourLayout, type TourStep } from "./tour";

const m = messages({
  how: "How to read this page",
  next: "Next",
  done: "Done",
  skip: "Skip",
  back: "Back",
  step1: "What this quarter earned: revenue, gross profit, operating and net income, with YoY change",
  step2: "Where money comes from and goes: business lines on the left, down to net income on the right. Hover any band",
  step3: "Click the timeline to see past quarters. Numbers on dots count key events that share that spot",
}, {
  how: "怎么看这一页",
  next: "下一步",
  done: "完成",
  skip: "跳过",
  back: "上一步",
  step1: "这一季赚了多少：营收、毛利、营业利润和净利润，旁边是同比变化",
  step2: "钱从哪来、花在哪：左边是各业务收入，右边一路扣到净利润。悬停任何一段看数字",
  step3: "点时间轴看历史季度。圆点上的数字是叠在同一处的重要事件数",
});

const TARGETS = ["[data-tour='stats']", "[data-tour='chart']", "[data-tour='timeline']"];

type Box = { top: number; left: number; width: number; height: number };

function measure(step: TourStep, mobile: boolean, card: DOMRect | undefined) {
  const target = document.querySelector(TARGETS[step]!);
  return target ? tourLayout(target.getBoundingClientRect(), window.innerWidth, mobile && card?.height ? Math.min(window.innerHeight, card.bottom + 12) : window.innerHeight, card?.height || 168, mobile) : { hole: null, card: null };
}

/**
 * Three-step coach for a company page. The rail button always restarts at step 1.
 * The first visit waits until the map is on screen, then opens unless the reader finished it
 * or this is an automated browser that did not ask for the tour.
 */
export function CompanyTour({ available = true }: { available?: boolean }) {
  const COPY = [m.step1, m.step2, m.step3] as const;
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<TourStep>(0);
  const [box, setBox] = useState<{ hole: Box | null; card: Box | null }>({ hole: null, card: null });
  const [mobile, setMobile] = useState(() => typeof matchMedia === "function" && matchMedia("(max-width: 960px)").matches);
  const cardRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const timer = useRef(0);

  function start() {
    window.clearTimeout(timer.current);
    if (!available || document.querySelector("dialog[open]") || !document.querySelector(TARGETS[0]!)) return;
    setStep(0);
    setOpen(true);
    track("tour_start");
  }

  useEffect(() => {
    if (!available) { setOpen(false); return; }
    let storage: Storage | null = null;
    let session: Storage | null = null;
    try { storage = localStorage; session = sessionStorage; } catch { /* Private mode. */ }
    let force = false;
    try { force = session?.getItem(TOUR_FORCE_KEY) === "1"; } catch { /* Private mode. */ }
    const webdriver = typeof navigator !== "undefined" && navigator.webdriver === true;
    if (!shouldAutoOpen({ done: readTourDone(storage), webdriver, force })) return;
    timer.current = window.setTimeout(start, 600);
    return () => window.clearTimeout(timer.current);
  }, [available]);

  useEffect(() => {
    if (!open) return;
    const target = document.querySelector(TARGETS[step] ?? "");

    if (!target) return;
    try { target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); } catch { target.scrollIntoView({ block: "center", inline: "nearest" }); }
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const narrow = matchMedia("(max-width: 960px)").matches;
      setMobile(narrow);
      if (!document.querySelector(TARGETS[step]!)) { setOpen(false); return; }
      setBox(measure(step, narrow, cardRef.current?.getBoundingClientRect()));
    };
    place();
    const observer = new ResizeObserver(place);
    const target = document.querySelector(TARGETS[step]!);
    if (target) observer.observe(target);
    if (cardRef.current) observer.observe(cardRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, step, mobile]);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (document.querySelector("dialog[open]")) { setOpen(false); return; }
    dialog?.showModal();
    cardRef.current?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      const back = returnTo.current;
      if (back && back !== document.body && document.contains(back) && !back.matches(":disabled") && !back.closest("[inert]")) back.focus({ preventScroll: true });
      else document.getElementById("company-stage")?.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "Tab") {
        const buttons = [...(cardRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const first = buttons[0];
        const last = buttons.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === cardRef.current)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
        return;
      }
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "Enter" && event.target instanceof HTMLElement && event.target.closest("button")) return;
      const action = tourKey(event.key);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      const move = reduceTour(step, action);
      if (move.type === "step") setStep(move.step);
      if (move.type === "done" || move.type === "skip") {
        try { writeTourDone(localStorage); } catch { /* Private mode. */ }
        track(move.type === "done" ? "tour_done" : "tour_skip");
        setOpen(false);
      }
    };
    const dialog = dialogRef.current;
    dialog?.addEventListener("keydown", onKey);
    return () => dialog?.removeEventListener("keydown", onKey);
  }, [open, step]);

  function click(action: "next" | "back" | "skip") {
    const move = reduceTour(step, action);
    if (move.type === "step") setStep(move.step);
    if (move.type === "done" || move.type === "skip") {
      try { writeTourDone(localStorage); } catch { /* Private mode. */ }
      track(move.type === "done" ? "tour_done" : "tour_skip");
      setOpen(false);
    }
  }

  const layer = open ? <dialog ref={dialogRef} className="tour-layer" data-hole={box.hole ? "" : undefined} aria-labelledby="company-tour-text" onCancel={event => { event.preventDefault(); click("skip"); }}>
    <div className="tour-shade" />
    {box.hole && <div className="tour-hole" style={{ top: box.hole.top, left: box.hole.left, width: box.hole.width, height: box.hole.height }} />}
    <div ref={cardRef} className="tour-card" tabIndex={-1} data-show="" data-mobile={mobile || undefined}
      style={mobile || !box.card ? undefined : { top: box.card.top, left: box.card.left }}>
      <div className="tour-dots" aria-hidden="true">{COPY.map((_, index) => <i key={index} data-on={index === step || undefined} />)}</div>
      <p id="company-tour-text">{COPY[step]}</p>
      <div className="tour-actions">
        <button type="button" className="tour-skip" onClick={() => click("skip")}>{m.skip}</button>
        <span>
          {step > 0 && <button type="button" className="tour-back" onClick={() => click("back")}>{m.back}</button>}
          <button type="button" className="tour-next" onClick={() => click("next")}>{step === 2 ? m.done : m.next}</button>
        </span>
      </div>
    </div>
  </dialog> : null;

  return <>
    <button type="button" className="rail-tour" disabled={!available} onClick={start}>{m.how}</button>
    {layer && typeof document !== "undefined" ? createPortal(layer, document.body) : null}
  </>;
}
