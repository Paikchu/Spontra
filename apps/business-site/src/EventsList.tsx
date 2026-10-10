import { Button } from "@/packages/web/src/ui/button";
import { Fragment, useMemo, useState } from "react";
import type { CompanyEvent, EventClass } from "@/shared/analysis-contract/events";
import type { PublicFilingDigest } from "@/shared/analysis-contract/filings";
import { EVENT_CLASS_LABEL, eventTitle, shortDate } from "./events-model";
import { railDigest, reportTitle, type RailItem, type RailItems } from "./reports-model";
import { RailSection } from "./RailSection";

/** A row's group for the open list's filter: reports, or the event's class. */
const groupOf = (item: RailItem) => item.kind === "report" ? "report" : item.event.class;
const groupLabel = (key: string) => key === "report" ? "财报" : EVENT_CLASS_LABEL[key as EventClass];

/**
 * The filing timeline, under the findings in the rail: every report and every 8-K or traded Form 4, newest first,
 * one row each, marked as on the time axis (a square for a report, a dot in its class colour for an event).
 * Closed, it shows the newest report and the latest few filings; open, the whole list with a rule where this
 * period ends, a year mark where the year turns, and the class legend doubling as a filter.
 */
export function EventsList({ rail, focus, pendingInsider, expanded, onFocus, onExpand }: {
  rail: RailItems;
  /** The focused report accession or event id. */
  focus: string | null;
  pendingInsider: number;
  expanded: boolean;
  onFocus: (item: RailItem | null) => void;
  onExpand: (open: boolean) => void;
}) {
  const [group, setGroup] = useState<string | null>(null);
  const all = useMemo(() => [...rail.recent, ...rail.earlier], [rail]);
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of all) counts.set(groupOf(item), (counts.get(groupOf(item)) ?? 0) + 1);
    return [...counts].sort((a, b) => (a[0] === "report" ? -1 : b[0] === "report" ? 1 : b[1] - a[1]));
  }, [all]);
  const digest = new Set(railDigest(rail, focus).map(i => i.id));
  const shown = expanded && group ? all.filter(i => groupOf(i) === group) : all;
  const firstEarlier = rail.earlier.find(i => shown.includes(i))?.id;
  const thisYear = (rail.recent[0] ?? all[0])?.date.slice(0, 4);
  const notes = [rail.quiet > 0 ? `另有 ${rail.quiet} 份 Form 4 为授予、代扣或赠与` : null, pendingInsider > 0 ? `${pendingInsider} 份 Form 4 待读取` : null].filter(Boolean).join("；");
  return <RailSection name="events" title="财报与事件" hint={notes || undefined} expandable={all.length > digest.size}
    expanded={expanded} focused={focus != null} onExpand={open => { if (!open) setGroup(null); onExpand(open); }}>
    {expanded && groups.length > 1 && <div className="section-filters" role="radiogroup" aria-label="按类型筛选">
      {[[null, all.length] as const, ...groups].map(([key, count]) => <Button variant="unstyled" type="button" key={key ?? "all"} role="radio" aria-checked={group === key} className="section-filter"
        data-class={key ?? undefined} onClick={() => setGroup(key)}>
        {key == null ? "全部" : groupLabel(key)}{key != null && <small>{count}</small>}
      </Button>)}
    </div>}
    <div className="findings-rows section-body" id="rail-events" role="radiogroup" aria-label="选择财报或事件以在图中查看">
      {shown.map((item, i) => {
        const year = item.date.slice(0, 4);
        const turn = year !== (i ? shown[i - 1].date.slice(0, 4) : thisYear);
        const extra = digest.has(item.id) ? undefined : "";
        const pick = () => onFocus(focus === item.id ? null : item);
        return <Fragment key={item.id}>
          {item.id === firstEarlier && i > 0 && <hr className="section-rule" data-extra="" />}
          {turn && <p className="section-group" data-extra="" aria-hidden="true">{year}</p>}
          {item.kind === "report"
            ? <ReportRow report={item.report} checked={focus === item.id} extra={extra} onClick={pick} />
            : <EventRow event={item.event} checked={focus === item.id} extra={extra} onClick={pick} />}
        </Fragment>;
      })}
    </div>
  </RailSection>;
}

function ReportRow({ report, checked, extra, onClick }: { report: PublicFilingDigest; checked: boolean; extra?: string; onClick: () => void }) {
  const forms = report.sources.length ? report.sources.map(s => s.form).join(" + ") : report.form;
  return <Button variant="unstyled" type="button" role="radio" aria-checked={checked} className="finding-row event-row report-row" data-class="report" data-extra={extra} onClick={onClick}
    title={`财报 · ${forms} · 截至 ${report.periodEnd} · ${report.filingDate}`} aria-label={`财报 ${shortDate(report.date)} ${reportTitle(report)}`}>
    <time className="event-date" dateTime={report.date}>{shortDate(report.date)}</time>
    <span className="finding-title">{reportTitle(report)}</span>
    {report.periodLabel && <span className="finding-kind"><small>{report.periodLabel}</small></span>}
  </Button>;
}

function EventRow({ event, checked, extra, onClick }: { event: CompanyEvent; checked: boolean; extra?: string; onClick: () => void }) {
  const t = event.insider;
  // The class reads from the mark; only an insider's role is worth a line of its own.
  const meta = t ? [t.title ?? (t.isDirector ? "董事" : t.isTenPercentOwner ? "10% 股东" : null), t.sold && t.rule10b51 === true ? "10b5-1" : null].filter(Boolean).join(" · ") : "";
  const items = event.items.filter(i => i !== "9.01").map(i => `Item ${i}`).join(", ");
  return <Button variant="unstyled" type="button" role="radio" aria-checked={checked} className="finding-row event-row" data-class={event.class} data-extra={extra} onClick={onClick}
    title={[EVENT_CLASS_LABEL[event.class], event.form, items, event.filedAt].filter(Boolean).join(" · ")} aria-label={`${EVENT_CLASS_LABEL[event.class]} ${shortDate(event.filedAt)} ${eventTitle(event)}${meta ? ` ${meta}` : ""}`}>
    <time className="event-date" dateTime={event.filedAt}>{shortDate(event.filedAt)}</time>
    <span className="finding-title">{eventTitle(event)}</span>
    {meta && <span className="finding-kind"><small>{meta}</small></span>}
  </Button>;
}
