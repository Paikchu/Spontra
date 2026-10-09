import { Button } from "@/components/ui/button";
import React, { useState } from "react";
import type { CompanyEvent } from "@/shared/analysis-contract/events";
import { EVENT_CLASS_LABEL, eventTitle, shortDate, type RailEvents } from "./events-model";

/**
 * What the company filed since its last report, under the findings in the rail: one row per 8-K or
 * traded Form 4, newest first. A row in focus opens the event's lens on the stage. Older events and
 * untraded Form 4 filings fold away so the period's events stay in view.
 */
export function EventsList({ rail, focus, pendingInsider, onFocus }: {
  rail: RailEvents;
  focus: string | null;
  pendingInsider: number;
  onFocus: (id: string | null) => void;
}) {
  const [earlier, setEarlier] = useState(false);
  const rows = earlier ? [...rail.recent, ...rail.earlier] : rail.recent;
  return <section className="findings events" aria-label="期间事件" data-focus={focus ? "" : undefined}>
    <header className="findings-head">
      <span className="findings-title">期间事件<small>{shortDate(rail.since)} 起 · {rail.recent.length} 项</small></span>
      {rail.earlier.length > 0 && <Button variant="unstyled" type="button" className="findings-story" aria-pressed={earlier} onClick={() => setEarlier(v => !v)}>{earlier ? "收起更早" : `更早 ${rail.earlier.length} 项`}</Button>}
    </header>
    <div className="findings-rows" role="radiogroup" aria-label="选择事件以在图中查看">
      {rows.map(e => <Row key={e.id} event={e} checked={focus === e.id} onClick={() => onFocus(focus === e.id ? null : e.id)} />)}
    </div>
    {(rail.quiet > 0 || pendingInsider > 0) && <p className="events-note">
      {rail.quiet > 0 && <span>{rail.quiet} 份 Form 4 为授予、代扣或赠与，未列出</span>}
      {pendingInsider > 0 && <span>{pendingInsider} 份 Form 4 待读取</span>}
    </p>}
  </section>;
}

function Row({ event, checked, onClick }: { event: CompanyEvent; checked: boolean; onClick: () => void }) {
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
