import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { messages } from "@/packages/web/src/i18n";
import { track } from "./track";
import { TOUR_FORCE_KEY, readTourDone, reduceTour, shouldAutoOpen, tourKey, writeTourDone, type TourStep } from "./tour";

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

const COPY = [m.step1, m.step2, m.step3] as const;
const TARGETS = ["[data-tour='stats']", "[data-tour='chart']", "[data-tour='timeline']"];

type Box = { top: number; left: number; width: number; height: number };

function measure(step: TourStep, mobile: boolean): { hole: Box | null; card: Box | null } {
  const target = document.querySelector(TARGETS[step] ?? "");
  if (!target) return { hole: null, card: null };
  const rect = target.getBoundingClientRect();
  const pad = 6;
  const holeLeft = Math.max(8, Math.min(rect.left - pad, window.innerWidth - 32));
  const hole = {
    top: Math.max(8, rect.top - pad),
    left: holeLeft,
    width: Math.max(24, Math.min(rect.width + pad * 2, window.innerWidth - holeLeft - 8)),
    height: Math.max(24, rect.height + pad * 2),
  };
  if (mobile) return { hole, card: null };
  const width = Math.min(300, window.innerWidth - 24);
  const height = 168;
  let top = hole.top + hole.height + 12;
  let left = hole.left;
  if (top + height > window.innerHeight - 12) top = Math.max(12, hole.top - height - 12);
  if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
  return { hole, card: { top, left, width, height } };
}

/**
 * Three-step coach for a company page. The rail button always restarts at step 1.
 * The first visit waits until the map is on screen, then opens unless the reader finished it
 * or this is an automated browser that did not ask for the tour.
 */
export function CompanyTour() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<TourStep>(0);
  const [box, setBox] = useState<{ hole: Box | null; card: Box | null }>({ hole: null, card: null });
  const [mobile, setMobile] = useState(() => typeof matchMedia === "function" && matchMedia("(max-width: 959px)").matches);
  const cardRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const timer = useRef(0);

  function start() {
    window.clearTimeout(timer.current);
    setStep(0);
    setOpen(true);
    track("tour_start");
  }

  useEffect(() => {
    let storage: Storage | null = null;
    let session: Storage | null = null;
    try { storage = localStorage; session = sessionStorage; } catch { /* Private mode. */ }
    const force = session?.getItem(TOUR_FORCE_KEY) === "1";
    const webdriver = typeof navigator !== "undefined" && navigator.webdriver === true;
    if (!shouldAutoOpen({ done: readTourDone(storage), webdriver, force })) return;
    timer.current = window.setTimeout(start, 600);
    return () => window.clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    if (!open || !matchMedia("(max-width: 959px)").matches) return;
    const target = document.querySelector(TARGETS[step] ?? "");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const top = window.scrollY + rect.top - (window.innerHeight - rect.height) / 2;
    window.scrollTo({ top: Math.max(0, top), left: 0, behavior: reduce ? "auto" : "smooth" });
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const narrow = matchMedia("(max-width: 959px)").matches;
      setMobile(narrow);
      setBox(measure(step, narrow));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus({ preventScroll: true });
    return () => {
      const back = returnTo.current;
      if (back && document.contains(back)) back.focus({ preventScroll: true });
      else document.getElementById("company-stage")?.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
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
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
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

  const layer = open ? <div className="tour-layer">
    <div className="tour-shade" />
    {box.hole && <div className="tour-hole" style={{ top: box.hole.top, left: box.hole.left, width: box.hole.width, height: box.hole.height }} />}
    <div ref={cardRef} className="tour-card" role="dialog" aria-modal="true" aria-labelledby="company-tour-text" tabIndex={-1} data-show="" data-mobile={mobile || undefined}
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
  </div> : null;

  return <>
    <button type="button" className="rail-tour" onClick={start}>{m.how}</button>
    {layer && typeof document !== "undefined" ? createPortal(layer, document.body) : null}
  </>;
}
