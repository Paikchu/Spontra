import { Button } from "@/components/ui/button";
import React, { useState } from "react";
import type { CompanyEvent } from "@/shared/analysis-contract/events";
import type { PublicFilingDigest } from "@/shared/analysis-contract/filings";
import { EVENT_CLASS_LABEL, eventTitle, shortDate } from "./events-model";
import { reportTitle, type RailItem, type RailItems } from "./reports-model";
import type { ReactNode } from "react";

/**
 * The filing timeline, under the findings in the rail: every report and every 8-K or traded Form 4,
 * newest first, one row each. A row in focus opens its lens on the stage. Older rows and untraded
 * Form 4 filings fold away so the current period stays in view.
 */
export function EventsList({ rail, focus, pendingInsider, onFocus, hostPeriodEnd = null, findings = null }: {
  rail: RailItems;
  /** The focused report accession or event id. */
  focus: string | null;
  pendingInsider: number;
  onFocus: (item: RailItem | null) => void;
  /** The report period the findings were written from; its row carries them. */
  hostPeriodEnd?: string | null;
  findings?: ReactNode;
}) {
  const [earlier, setEarlier] = useState(false);
  const rows = earlier ? [...rail.recent, ...rail.earlier] : rail.recent;
  return <section className="findings events" aria-label="财报与事件" data-focus={focus ? "" : undefined}>
    <header className="findings-head">
      <span className="findings-title">财报与事件<small>{shortDate(rail.since)} 起 · {rail.recent.length} 项</small></span>
      {rail.earlier.length > 0 && <Button variant="unstyled" type="button" className="findings-story" aria-pressed={earlier} onClick={() => setEarlier(v => !v)}>{earlier ? "收起更早" : `更早 ${rail.earlier.length} 项`}</Button>}
    </header>
    <div className="findings-rows" role="radiogroup" aria-label="选择财报或事件以在图中查看">
      {rows.map(item => item.kind === "report"
        ? <div key={item.id} className="report-group" data-host={findings && item.report.periodEnd === hostPeriodEnd || undefined}>
            <ReportRow report={item.report} checked={focus === item.id} onClick={() => onFocus(focus === item.id ? null : item)} />
            {findings && item.report.periodEnd === hostPeriodEnd && findings}
          </div>
        : <EventRow key={item.id} event={item.event} checked={focus === item.id} onClick={() => onFocus(focus === item.id ? null : item)} />)}
    </div>
    {(rail.quiet > 0 || pendingInsider > 0) && <p className="events-note">
      {rail.quiet > 0 && <span>{rail.quiet} 份 Form 4 为授予、代扣或赠与，未列出</span>}
      {pendingInsider > 0 && <span>{pendingInsider} 份 Form 4 待读取</span>}
    </p>}
  </section>;
}

function ReportRow({ report, checked, onClick }: { report: PublicFilingDigest; checked: boolean; onClick: () => void }) {
  const meta = report.sources.length ? `${report.sources.map(s => s.form).join(" + ")} · 截至 ${report.periodEnd}` : `${report.form} · 截至 ${report.periodEnd}`;
  return <Button variant="unstyled" type="button" role="radio" aria-checked={checked} className="finding-row event-row report-row" data-class="report" onClick={onClick}
    title={`${report.form} · ${report.filingDate}`}>
    <time className="event-date" dateTime={report.date}>{shortDate(report.date)}</time>
    <span className="finding-title">{reportTitle(report)}</span>
    <span className="finding-kind"><span>{report.periodLabel ?? "财报"}</span><small>{meta}</small></span>
  </Button>;
}

function EventRow({ event, checked, onClick }: { event: CompanyEvent; checked: boolean; onClick: () => void }) {
  const t = event.insider;
  const meta = t ? [t.title ?? (t.isDirector ? "董事" : t.isTenPercentOwner ? "10% 股东" : null), t.sold && t.rule10b51 === true ? "10b5-1" : null].filter(Boolean).join(" · ")
    : event.items.filter(i => i !== "9.01").map(i => `Item ${i}`).join(" · ");
  return <Button variant="unstyled" type="button" role="radio" aria-checked={checked} className="finding-row event-row" data-class={event.class} onClick={onClick}
    title={`${event.form} · ${event.filedAt}`}>
    <time className="event-date" dateTime={event.filedAt}>{shortDate(event.filedAt)}</time>
    <span className="finding-title">{eventTitle(event)}</span>
    <span className="finding-kind"><span>{EVENT_CLASS_LABEL[event.class]}</span>{meta && <small>{meta}</small>}</span>
  </Button>;
}
