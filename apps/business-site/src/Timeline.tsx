import { Button } from "@/components/ui/button";
import React, { useMemo, type CSSProperties } from "react";
import { CLASS_TONE, EVENT_CLASS_LABEL, type TimelinePoint } from "./events-model";

const DAY = 86_400_000;

/**
 * The time axis under the chart: every report filing and every event on one line, so a run of
 * insider sales or an 8-K between two reports reads where it happened. A report tick moves the
 * stage to that quarter; an event tick opens its lens.
 */
export function Timeline({ points, currentPeriod, focus, now, onReport, onEvent }: {
  points: TimelinePoint[];
  /** The reference date the axis extends to, fixed by the page so a re-render never shifts the track. */
  now: number;
  currentPeriod: string | null;
  focus: string | null;
  onReport: (id: string, periodEnd: string) => void;
  onEvent: (id: string) => void;
}) {
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
  if (!points.length) return null;
  const x = (d: string) => (Date.parse(d) - start) / (end - start) * 100;
  // A report in focus is the lit report; otherwise the lit report is the quarter the stage shows.
  const reportFocused = points.some(p => p.kind === "report" && p.id === focus);
  return <div className="timeline" role="group" aria-label="申报时间轴">
    <div className="timeline-track">
      {ticks.map(t => <span key={t.label} className="timeline-tick" style={{ left: `${t.at}%` }}>{t.label}</span>)}
      {points.map(p => {
        const report = p.kind === "report";
        const active = report ? (reportFocused ? p.id === focus : p.periodEnd === currentPeriod) : p.id === focus;
        return <Button variant="unstyled" type="button" key={p.id} className="timeline-point" data-kind={p.kind} data-weight={p.weight} data-class={p.cls} aria-pressed={active}
          style={{ left: `${x(p.date)}%`, "--tone": report ? "var(--foreground)" : CLASS_TONE[p.cls!] } as CSSProperties}
          title={`${p.date} · ${report ? p.title : `${EVENT_CLASS_LABEL[p.cls!]} · ${p.title}`}`} aria-label={`${p.date} ${p.title}`}
          onClick={() => report ? onReport(p.id, p.periodEnd!) : onEvent(p.id)} />;
      })}
    </div>
  </div>;
}
