import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "@/packages/web/src/ui/button";
import { useMemo, useState, type ReactNode } from "react";
import type { CompanyEvent, EventClass } from "@/shared/analysis-contract/events";
import type { PublicFilingDigest } from "@/shared/analysis-contract/filings";
import { messages } from "@/packages/web/src/i18n";
import { SourceLanguage } from "@/packages/web/src/i18n/SourceLanguage";
import { EVENT_CLASS_LABEL, eventTitle, eventTitleLang, shortDate } from "./events-model";
import { railDigest, reportTitle, reportTitleLang, type RailItem, type RailItems } from "./reports-model";
import { RailSection } from "./RailSection";
import { arrivalStyle, RailRow, rowExit, useArrivals } from "./arrivals";

const m = messages({
  reports: "Reports", nonTrade: (n: number) => `Form 4 non-trade ${n}`, pending: (n: number) => `Form 4 pending ${n}`,
  title: "Filings and events", type: "Type", all: "All", report: "Report", periodEnded: (date: string) => `Period ended ${date}`,
  director: "Director", tenPercent: "10% owner",
}, {
  reports: "财报", nonTrade: (n: number) => `Form 4 非交易 ${n}`, pending: (n: number) => `Form 4 待处理 ${n}`,
  title: "文件与事件", type: "类型", all: "全部", report: "财报", periodEnded: (date: string) => `截至 ${date}`,
  director: "董事", tenPercent: "10% 股东",
});

/** A row's group for the open list's filter: reports, or the event's class. */
const groupOf = (item: RailItem) => item.kind === "report" ? "report" : item.event.class;
const groupLabel = (key: string) => key === "report" ? m.reports : EVENT_CLASS_LABEL[key as EventClass];

/**
 * The filing timeline, under the findings in the rail: every report and every 8-K or traded Form 4, newest first,
 * one row each, marked as on the time axis (a square for a report, a dot in its class colour for an event).
 * Closed, it shows the newest report and the latest few filings; open, the whole list with a rule where this
 * period ends, a year mark where the year turns, and the class legend doubling as a filter.
 */
export function EventsList({ rail, updates, focus, pendingInsider, expanded, onFocus, onExpand }: {
  rail: RailItems;
  /** Updates the reader took; the filings an update brought enter animated, newest first, pushing the rest down. */
  updates: number;
  /** The focused report accession or event id. */
  focus: string | null;
  pendingInsider: number;
  expanded: boolean;
  onFocus: (item: RailItem | null) => void;
  onExpand: (open: boolean) => void;
}) {
  const [group, setGroup] = useState<string | null>(null);
  const all = useMemo(() => [...rail.recent, ...rail.earlier], [rail]);
  const ids = all.map(i => i.id);
  const arrived = useArrivals(ids, updates);
  const still = useReducedMotion();
  const rowMotion: RowMotion = { layout: still ? false : "position", layoutDependency: ids.join(), exit: rowExit };
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of all) counts.set(groupOf(item), (counts.get(groupOf(item)) ?? 0) + 1);
    return [...counts].sort((a, b) => (a[0] === "report" ? -1 : b[0] === "report" ? 1 : b[1] - a[1]));
  }, [all]);
  const digest = new Set(railDigest(rail, focus).map(i => i.id));
  const shown = expanded && group ? all.filter(i => groupOf(i) === group) : all;
  const firstEarlier = rail.earlier.find(i => shown.includes(i))?.id;
  const thisYear = (rail.recent[0] ?? all[0])?.date.slice(0, 4);
  const notes = [rail.quiet > 0 ? m.nonTrade(rail.quiet) : null, pendingInsider > 0 ? m.pending(pendingInsider) : null].filter(Boolean).join(" · ");
  return <RailSection name="events" title={m.title} tag={<SourceLanguage of={(expanded ? shown : shown.filter(i => digest.has(i.id))).map(i => i.kind === "report" ? i.report.headline : i.event.summary?.headline)} />} hint={notes || undefined} expandable={all.length > digest.size}
    expanded={expanded} focused={focus != null} onExpand={open => { if (!open) setGroup(null); onExpand(open); }}>
    {expanded && groups.length > 1 && <div className="section-filters" role="radiogroup" aria-label={m.type}>
      {[[null, all.length] as const, ...groups].map(([key, count]) => <Button variant="unstyled" type="button" key={key ?? "all"} role="radio" aria-checked={group === key} className="section-filter"
        data-class={key ?? undefined} onClick={() => setGroup(key)}>
        {key == null ? m.all : groupLabel(key)}{key != null && <small>{count}</small>}
      </Button>)}
    </div>}
    <div className="findings-rows section-body" id="rail-events" role="radiogroup" aria-label={m.title}>
      {/* A filter remounts the list, so switching it never plays the update's entrance or exit. */}
      <AnimatePresence key={group ?? "all"} initial={false} mode="popLayout">
      {shown.flatMap((item, i) => {
        const year = item.date.slice(0, 4);
        const turn = year !== (i ? shown[i - 1].date.slice(0, 4) : thisYear);
        const extra = digest.has(item.id) ? undefined : "";
        const pick = () => onFocus(focus === item.id ? null : item);
        const row = { checked: focus === item.id, extra, onClick: pick, arrive: arrived.get(item.id), motion: rowMotion };
        const nodes: ReactNode[] = [];
        if (item.id === firstEarlier && i > 0) nodes.push(<motion.hr key="rule" className="section-rule" data-extra="" {...rowMotion} />);
        if (turn) nodes.push(<motion.p key={`year-${year}`} className="section-group" data-extra="" aria-hidden="true" {...rowMotion}>{year}</motion.p>);
        nodes.push(item.kind === "report" ? <ReportRow key={item.id} report={item.report} {...row} /> : <EventRow key={item.id} event={item.event} {...row} />);
        return nodes;
      })}
      </AnimatePresence>
    </div>
  </RailSection>;
}

type RowMotion = { layout: false | "position"; layoutDependency: string; exit: typeof rowExit };
type RowProps = { checked: boolean; extra?: string; onClick: () => void; arrive?: number; motion: RowMotion };

function ReportRow({ report, checked, extra, onClick, arrive, motion }: RowProps & { report: PublicFilingDigest }) {
  const forms = report.sources.length ? report.sources.map(s => s.form).join(" + ") : report.form;
  return <RailRow variant="unstyled" type="button" role="radio" aria-checked={checked} className="finding-row event-row report-row" data-class="report" data-extra={extra} onClick={onClick}
    {...motion} data-arrived={arrive != null ? "" : undefined} style={arrivalStyle(arrive)}
    title={`${m.report} · ${forms} · ${m.periodEnded(String(report.periodEnd))} · ${report.filingDate}`} aria-label={`${m.report} ${shortDate(report.date)} ${reportTitle(report)}`}>
    <time className="event-date" dateTime={report.date}>{shortDate(report.date)}</time>
    <span className="finding-title" lang={reportTitleLang(report)}>{reportTitle(report)}</span>
    {report.periodLabel && <span className="finding-kind"><small>{report.periodLabel}</small></span>}
  </RailRow>;
}

function EventRow({ event, checked, extra, onClick, arrive, motion }: RowProps & { event: CompanyEvent }) {
  const t = event.insider;
  // The class reads from the mark; only an insider's role is worth a line of its own.
  const meta = t ? [t.title ?? (t.isDirector ? m.director : t.isTenPercentOwner ? m.tenPercent : null), t.sold && t.rule10b51 === true ? "10b5-1" : null].filter(Boolean).join(" · ") : "";
  const items = event.items.filter(i => i !== "9.01").map(i => `Item ${i}`).join(", ");
  return <RailRow variant="unstyled" type="button" role="radio" aria-checked={checked} className="finding-row event-row" data-class={event.class} data-extra={extra} onClick={onClick}
    {...motion} data-arrived={arrive != null ? "" : undefined} style={arrivalStyle(arrive)}
    title={[EVENT_CLASS_LABEL[event.class], event.form, items, event.filedAt].filter(Boolean).join(" · ")} aria-label={`${EVENT_CLASS_LABEL[event.class]} ${shortDate(event.filedAt)} ${eventTitle(event)}${meta ? ` ${meta}` : ""}`}>
    <time className="event-date" dateTime={event.filedAt}>{shortDate(event.filedAt)}</time>
    <span className="finding-title" lang={eventTitleLang(event)}>{eventTitle(event)}</span>
    {meta && <span className="finding-kind"><small>{meta}</small></span>}
  </RailRow>;
}
