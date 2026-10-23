import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { messages, useLocale } from "@/packages/web/src/i18n";
import type { EventClass } from "@/shared/analysis-contract/events";
import { CLASS_TONE, EVENT_CLASS_LABEL, type TimelinePoint } from "./events-model";
import { clusterByGap, narrowTypes, pointType, readTimelineTypes, timelineSearch } from "./timeline-model";

const m = messages({
  label: "Filing timeline",
  all: "All",
  report: "Reports",
  cluster: (n: number) => `${n} events`,
  filters: "Event types",
}, {
  label: "文件时间轴",
  all: "全部",
  report: "财报",
  cluster: (n: number) => `${n} 个事件`,
  filters: "事件类型",
});

const DAY = 86_400_000;
const TYPE_ORDER = ["report", "earnings", "guidance", "executive", "insider", "deal", "financing", "capital_return", "vote", "legal", "other"];
/** Markers closer than this share one target. 24px is the hit size, which already covers the 12px rule. */
const HIT_FINE = 24;
const HIT_COARSE = 36;

function typeName(type: string): string {
  if (type === "report") return m.report;
  return EVENT_CLASS_LABEL[type as EventClass] ?? type;
}

function toneOf(point: TimelinePoint): string {
  return point.kind === "report" ? "var(--foreground)" : CLASS_TONE[point.cls ?? "other"];
}

/**
 * The time axis under the chart. Types filter from the chips (the choice lives in the URL).
 * Points that would sit on top of each other become one numbered marker; its list opens on click.
 * Tab lands on the axis, and the arrow keys move across events.
 */
export function Timeline({ points, currentPeriod, now, activeEventId, activeReportId, onReport, onEvent }: {
  points: TimelinePoint[];
  now: number;
  currentPeriod: string | null;
  activeEventId: string | null;
  activeReportId: string | null;
  onReport: (id: string, periodEnd: string) => void;
  onEvent: (id: string) => void;
}) {
  useLocale();
  const listId = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hit, setHit] = useState(HIT_FINE);
  const [picked, setPicked] = useState<string[] | null>(() => readTimelineTypes(location.search));
  const [cursor, setCursor] = useState(0);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [trackFocus, setTrackFocus] = useState(false);

  useEffect(() => {
    const element = trackRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const query = matchMedia("(pointer: coarse)");
    const apply = () => setHit(query.matches ? HIT_COARSE : HIT_FINE);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  useEffect(() => {
    const sync = () => setPicked(readTimelineTypes(location.search));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const { start, end, ticks } = useMemo(() => {
    if (!points.length) return { start: 0, end: 1, ticks: [] as Array<{ label: string; at: number }> };
    const first = Date.parse(points[0].date), last = Math.max(Date.parse(points[points.length - 1].date), now - 3 * DAY);
    const pad = Math.max(14 * DAY, (last - first) * 0.03);
    const start = first - pad, end = last + pad;
    const ticks: Array<{ label: string; at: number }> = [];
    const cursorDate = new Date(start); cursorDate.setUTCDate(1); cursorDate.setUTCMonth(cursorDate.getUTCMonth() + 1);
    while (cursorDate.getTime() < end) {
      if (cursorDate.getUTCMonth() % 3 === 0) ticks.push({ label: `${cursorDate.getUTCFullYear()}.${String(cursorDate.getUTCMonth() + 1).padStart(2, "0")}`, at: (cursorDate.getTime() - start) / (end - start) * 100 });
      cursorDate.setUTCMonth(cursorDate.getUTCMonth() + 1);
    }
    return { start, end, ticks };
  }, [points, now]);

  const present = useMemo(() => {
    const counts = new Map<string, number>();
    for (const point of points) counts.set(pointType(point), (counts.get(pointType(point)) ?? 0) + 1);
    return TYPE_ORDER.filter(type => counts.has(type)).map(type => ({ type, count: counts.get(type)! }));
  }, [points]);
  const selected = narrowTypes(picked, present.map(item => item.type));
  const shown = useMemo(() => selected ? points.filter(point => selected.includes(pointType(point))) : points, [points, selected]);
  const marks = useMemo(() => width ? clusterByGap(shown, point => (Date.parse(point.date) - start) / (end - start) * width, Math.max(12, hit)) : [], [shown, width, hit, start, end]);
  const cursorIndex = shown.length ? Math.min(cursor, shown.length - 1) : 0;

  function writeFilter(next: string[] | null) {
    const narrowed = narrowTypes(next, present.map(item => item.type));
    setPicked(narrowed);
    setCursor(0);
    setOpenId(null);
    const search = timelineSearch(location.search, narrowed);
    const href = location.pathname + search + location.hash;
    if (href !== location.pathname + location.search + location.hash) history.replaceState(history.state, "", href);
  }
  function toggle(type: string) {
    if (!selected) { writeFilter([type]); return; }
    const next = selected.includes(type) ? selected.filter(item => item !== type) : [...selected, type];
    writeFilter(next);
  }
  function activate(point: TimelinePoint) {
    setOpenId(null);
    if (point.kind === "report") onReport(point.id, point.periodEnd ?? "");
    else onEvent(point.id);
  }
  function onTrackKey(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest(".timeline-pop")) return;
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    if (event.key === "Escape") { setOpenId(null); return; }
    if (!shown.length) return;
    if (event.key === "Enter") { const point = shown[cursorIndex]; if (point) activate(point); return; }
    setHoverId(null);
    setCursor(() => {
      const count = shown.length;
      if (!count) return 0;
      return event.key === "ArrowRight" ? (cursorIndex + 1) % count : (cursorIndex - 1 + count) % count;
    });
    setOpenId(null);
  }

  if (!points.length) return null;
  const cursorPoint = shown[cursorIndex] ?? null;
  const tipPoint = hoverId ? shown.find(point => point.id === hoverId) ?? null : trackFocus ? cursorPoint : null;
  const current = (point: TimelinePoint) => point.id === activeEventId || point.id === activeReportId || (point.kind === "report" && point.periodEnd != null && point.periodEnd === currentPeriod);

  return <div className="timeline">
    <div className="timeline-filters" role="toolbar" aria-label={m.filters}>
      <button type="button" aria-pressed={selected == null} onClick={() => writeFilter(null)}>{m.all}<small>{points.length}</small></button>
      {present.map(item => <button key={item.type} type="button" aria-pressed={selected?.includes(item.type) ?? false} onClick={() => toggle(item.type)}>
        {typeName(item.type)}<small>{item.count}</small>
      </button>)}
    </div>
    <div
      ref={trackRef}
      className="timeline-track"
      role="listbox"
      aria-label={m.label}
      tabIndex={0}
      aria-activedescendant={cursorPoint ? `${listId}-${cursorIndex}` : undefined}
      onKeyDown={onTrackKey}
      onFocus={() => setTrackFocus(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setTrackFocus(false); }}
    >
      {ticks.map(tick => <span key={tick.label} className="timeline-tick" style={{ left: `${tick.at}%` }}>{tick.label}</span>)}
      {marks.map(mark => {
        const lead = mark.items.length === 1 ? mark.items[0]! : (mark.items.find(point => point.id === cursorPoint?.id) ?? mark.items[0]!);
        const many = mark.items.length > 1;
        const x = mark.x / width * 100;
        const open = openId === mark.id;
        const described = tipPoint && mark.items.some(point => point.id === tipPoint.id) ? tipPoint : many ? null : lead;
        return <div key={mark.id} className="timeline-mark" style={{ left: `${x}%` }}>
          <button
            type="button"
            tabIndex={-1}
            id={mark.items.some(point => point.id === cursorPoint?.id) ? `${listId}-${cursorIndex}` : undefined}
            className="timeline-hit"
            role="option"
            aria-selected={mark.items.some(point => point.id === cursorPoint?.id)}
            data-kind={lead.kind}
            data-weight={many ? undefined : lead.weight}
            data-current={mark.items.some(current) || undefined}
            data-cursor={mark.items.some(point => point.id === cursorPoint?.id) && trackFocus || undefined}
            style={{ "--tone": toneOf(lead) } as CSSProperties}
            aria-label={many ? m.cluster(mark.items.length) : `${lead.date} ${typeName(pointType(lead))} ${lead.title}`}
            aria-haspopup={many ? "true" : undefined}
            onMouseEnter={() => setHoverId(lead.id)}
            onMouseLeave={() => setHoverId(id => id === lead.id ? null : id)}
            onFocus={() => { setHoverId(lead.id); const index = shown.findIndex(point => point.id === lead.id); if (index >= 0) setCursor(index); }}
            onClick={() => { if (many) setOpenId(id => id === mark.id ? null : mark.id); else activate(lead); }}
          >
            {many ? <b>{mark.items.length}</b> : <i />}
          </button>
          {open && <ul className="timeline-pop" id="tl-pop" onKeyDown={event => {
            const buttons = [...event.currentTarget.querySelectorAll("button")];
            const index = buttons.indexOf(event.target as HTMLButtonElement);
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              event.stopPropagation();
              const next = event.key === "ArrowDown" ? Math.min(buttons.length - 1, index + 1) : Math.max(0, index - 1);
              buttons[next]?.focus();
            } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpenId(null); trackRef.current?.focus(); }
          }}>
            {mark.items.map(point => <li key={point.id}>
              <button type="button" onClick={() => activate(point)}>
                <small>{point.date} · {typeName(pointType(point))}</small>
                <span>{point.title}</span>
              </button>
            </li>)}
          </ul>}
          {described && !open && <p className="timeline-tip" role="tooltip" data-edge={x > 78 ? "end" : x < 22 ? "start" : undefined}>
            <small>{described.date} · {typeName(pointType(described))}</small>
            <span>{described.title}</span>
          </p>}
        </div>;
      })}
    </div>
  </div>;
}
