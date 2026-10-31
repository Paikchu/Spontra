import { Button } from "@/packages/web/src/ui/button";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { messages, useLocale } from "@/packages/web/src/i18n";
import { CLASS_TONE, EVENT_CLASS_LABEL, type TimelinePoint } from "./events-model";
import { clusterByGap, readableTicks } from "./timeline-model";
import { fiscalPhrase } from "./PeriodMark";

const m = messages({
  label: "Filing timeline",
  events: (n: number) => `${n} events`,
  report: "Report",
}, {
  label: "文件时间轴",
  events: (n: number) => `${n} 个事件`,
  report: "财报",
});

const DAY = 86_400_000;
/** Markers closer than a bubble's diameter share one bubble, so the numbers never sit on top of each other. */
const BUBBLE = 16;

/**
 * The time axis under the chart. The page decides which filings are on it (the event filter).
 * Points that would land on each other become one numbered bubble; hovering lists them, and a click opens the list.
 */
export function Timeline({ points, currentPeriod, now, onReport, onEvent, ticker }: {
  points: TimelinePoint[];
  /** The reference date the axis extends to, fixed by the page so a re-render never shifts the track. */
  now: number;
  currentPeriod: string | null;
  ticker: string;
  onReport: (id: string, periodEnd: string) => void;
  onEvent: (id: string) => void;
}) {
  useLocale();
  const listId = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  useEffect(() => {
    const element = trackRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setOpenId(null); setHoverId(null); }, [points]);

  const { start, end, ticks } = useMemo(() => {
    if (!points.length) return { start: 0, end: 1, ticks: [] as Array<{ label: string; at: number }> };
    const first = Date.parse(points[0].date), last = Math.max(Date.parse(points[points.length - 1].date), now - 3 * DAY);
    const pad = Math.max(14 * DAY, (last - first) * 0.03);
    const start = first - pad, end = last + pad;
    const ticks: Array<{ label: string; at: number }> = [];
    const cursor = new Date(start); cursor.setUTCDate(1); cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    while (cursor.getTime() < end) {
      if (cursor.getUTCMonth() % 3 === 0) ticks.push({ label: `${cursor.getUTCFullYear()}.${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`, at: (cursor.getTime() - start) / (end - start) * 100 });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return { start, end, ticks };
  }, [points, now]);

  const marks = useMemo(() => {
    if (!width || !points.length) return [];
    return clusterByGap(points, point => (Date.parse(point.date) - start) / (end - start) * width, BUBBLE);
  }, [points, width, start, end]);

  if (!points.length) return null;
  const xOf = (px: number) => width ? px / width * 100 : 0;
  const activate = (point: TimelinePoint) => {
    setOpenId(null);
    if (point.kind === "report") onReport(point.id, point.periodEnd ?? "");
    else onEvent(point.id);
  };
  const nameOf = (point: TimelinePoint) => {
    const fiscal = point.kind === "report" && point.periodEnd ? fiscalPhrase(ticker, point.periodEnd) : null;
    const primary = fiscal?.primary ?? fiscal?.unknown ?? "";
    const body = point.kind === "report" ? `${point.date} ${m.report} ${point.title}` : `${point.date} ${EVENT_CLASS_LABEL[point.cls!] ?? ""} ${point.title}`;
    return primary ? `${primary} · ${body}` : body;
  };

  return <div className="timeline" role="group" aria-label={m.label} data-tour="timeline">
    <div className="timeline-track" ref={trackRef}>
      {readableTicks(ticks, width).map(t => <span key={t.label} className="timeline-tick" style={{ left: `${t.at}%` }}>{t.label}</span>)}
      {marks.map(mark => {
        const many = mark.items.length > 1;
        const lead = mark.items[0]!;
        const report = !many && lead.kind === "report";
        const active = !!mark.items.some(point => point.kind === "report" && point.periodEnd === currentPeriod);
        const left = width ? xOf(mark.x) : (Date.parse(lead.date) - start) / (end - start) * 100;
        const open = openId === mark.id;
        const hover = hoverId === mark.id;
        const tone = report || lead.kind === "report" ? "var(--foreground)" : CLASS_TONE[lead.cls ?? "other"];
        return <div key={mark.id} className="timeline-mark" style={{ left: `${left}%` }}>
          <Button variant="unstyled" type="button" className={many ? "timeline-bubble" : "timeline-point"} data-kind={lead.kind} data-weight={many ? undefined : lead.weight} data-class={lead.cls}
            aria-pressed={active} aria-expanded={many ? open : undefined} aria-controls={many ? listId : undefined}
            style={{ "--tone": tone } as CSSProperties}
            aria-label={many ? m.events(mark.items.length) : nameOf(lead)}
            title={many ? undefined : nameOf(lead)}
            onMouseEnter={() => setHoverId(mark.id)} onMouseLeave={() => setHoverId(id => id === mark.id ? null : id)}
            onFocus={() => setHoverId(mark.id)} onBlur={() => setHoverId(id => id === mark.id ? null : id)}
            onClick={() => { if (many) setOpenId(id => id === mark.id ? null : mark.id); else activate(lead); }}>
            {many ? mark.items.length : null}
          </Button>
          {many && (hover || open) && <div className={open ? "timeline-pop" : "timeline-tip"} id={open ? listId : undefined} role={open ? "list" : "tooltip"} data-edge={left > 78 ? "end" : left < 22 ? "start" : undefined}>
            <p>{m.events(mark.items.length)}</p>
            <ul>
              {mark.items.map(point => <li key={point.id}>
                {open
                  ? <Button variant="unstyled" type="button" onClick={() => activate(point)}><small>{point.date}</small><span>{point.title}</span></Button>
                  : <span><small>{point.date}</small>{point.title}</span>}
              </li>)}
            </ul>
          </div>}
        </div>;
      })}
    </div>
  </div>;
}
