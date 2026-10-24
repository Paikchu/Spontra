import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "@/packages/web/src/ui/button";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { CompanyEvent } from "@/shared/analysis-contract/events";
import type { PublicFilingDigest } from "@/shared/analysis-contract/filings";
import { messages, useLocale } from "@/packages/web/src/i18n";
import { SourceLanguage } from "@/packages/web/src/i18n/SourceLanguage";
import { EVENT_CLASS_LABEL, eventTitle, eventTitleLang, shortDate } from "./events-model";
import { EVENT_FILTERS, exactShares, filterCounts, noiseRows, rowLeaves, type EventFilter, type NoiseRow } from "./event-noise";
import { filingQuarterLabel, reportTitle, reportTitleLang, type RailItem, type RailItems } from "./reports-model";
import { RailSection } from "./RailSection";
import { arrivalStyle, RailRow, rowExit, useArrivals } from "./arrivals";
import { useRailTip } from "./RailTip";

const m = messages({
  reports: "Reports", nonTrade: (n: number) => `Form 4 non-trade ${n}`, pending: (n: number) => `Form 4 pending ${n}`,
  title: "Filings and events", filters: "Event filter",
  key: "Key", earnings: "Earnings & guidance", material: "Material events", insiders: "Insiders", all: "All",
  plan: (name: string, n: number, shares: string) => `${name} · ${n} planned sales this month · ${shares} shares`,
  routine: (n: number) => `Routine 6-K filings × ${n}`,
  empty: "Nothing in this category yet",
  loadFailed: "Couldn't load this data", retry: "Retry",
  director: "Director", tenPercent: "10% owner", report: "Report", periodEnded: (date: string) => `Period ended ${date}`,
}, {
  reports: "财报", nonTrade: (n: number) => `Form 4 非交易 ${n}`, pending: (n: number) => `Form 4 待处理 ${n}`,
  title: "文件与事件", filters: "事件筛选",
  key: "重要", earnings: "财报与指引", material: "重大事件", insiders: "内部人", all: "全部",
  plan: (name: string, n: number, shares: string) => `${name} · 本月按计划卖出 ${n} 笔 · 合计 ${shares} 股`,
  routine: (n: number) => `6-K 例行文件 × ${n}`,
  empty: "这一类暂时没有事件",
  loadFailed: "数据暂时加载失败", retry: "重试",
  director: "董事", tenPercent: "10% 股东", report: "财报", periodEnded: (date: string) => `截至 ${date}`,
});

const filterLabel = (key: EventFilter) => key === "key" ? m.key : key === "earnings" ? m.earnings : key === "material" ? m.material : key === "insiders" ? m.insiders : m.all;

/**
 * Filings and events in the rail. A row of filters sits under the title (Key is the default); planned sales by one
 * person in one month fold into a single row, and 6-Ks with nothing to title them fold into a monthly row.
 */
export function EventsList({ rail, ticker, updates, focus, pendingInsider, expanded, phase = "ready", onFocus, onExpand, onRetry, filter, onFilter }: {
  rail: RailItems;
  ticker: string;
  /** Updates the reader took; the filings an update brought enter animated, newest first, pushing the rest down. */
  updates: number;
  /** The focused report accession or event id. */
  focus: string | null;
  pendingInsider: number;
  expanded: boolean;
  /** `loading` while a retry is in flight; `error` when the events request failed and the rest of the page did not. */
  phase?: "ready" | "loading" | "error";
  onFocus: (item: RailItem | null) => void;
  onExpand: (open: boolean) => void;
  onRetry?: () => void;
  filter: EventFilter;
  onFilter: (filter: EventFilter) => void;
}) {
  useLocale();
  const all = [...rail.recent, ...rail.earlier];
  const rows = noiseRows(all, filter);
  const counts = filterCounts(all);
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set());
  const ids = rows.flatMap(row => [row.id, ...rowLeaves(row).map(item => item.id)]);
  const arrived = useArrivals(ids, updates);
  const still = useReducedMotion();
  const tip = useRailTip();
  const rowMotion: RowMotion = { layout: still ? false : "position", layoutDependency: ids.join(), exit: rowExit };
  const digest = digestIds(rows, focus);
  const buttons = useRef(new Map<EventFilter, HTMLButtonElement>());
  useEffect(() => {
    if (!focus) return;
    const host = rows.find(row => row.kind !== "item" && row.items.some(item => item.id === focus));
    if (host) setOpenRows(current => current.has(host.id) ? current : new Set(current).add(host.id));
  }, [focus, filter]); // eslint-disable-line react-hooks/exhaustive-deps
  const notes = [rail.quiet > 0 ? m.nonTrade(rail.quiet) : null, pendingInsider > 0 ? m.pending(pendingInsider) : null].filter(Boolean).join(" · ");
  const shown = expanded ? rows : rows.filter(row => digest.has(row.id));
  const move = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = EVENT_FILTERS.indexOf(filter);
    const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? EVENT_FILTERS[(index + 1) % EVENT_FILTERS.length]
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? EVENT_FILTERS[(index - 1 + EVENT_FILTERS.length) % EVENT_FILTERS.length]
      : event.key === "Home" ? EVENT_FILTERS[0]
      : event.key === "End" ? EVENT_FILTERS[EVENT_FILTERS.length - 1]
      : null;
    if (!next || next === filter) { if (next) event.preventDefault(); return; }
    event.preventDefault();
    onFilter(next);
    buttons.current.get(next)?.focus();
  };
  return <RailSection name="events" title={m.title} count={phase === "ready" ? rows.length : undefined} tag={<SourceLanguage of={shown.flatMap(row => rowLeaves(row)).map(item => item.kind === "report" ? item.report.headline : item.event.summary?.headline)} />} hint={notes || undefined} expandable={rows.length > digest.size}
    expanded={expanded} focused={focus != null} onExpand={onExpand}>
    {phase === "loading" ? <EventSkeleton /> : phase === "error" ? <div className="event-state">
      <p>{m.loadFailed}</p>
      <Button variant="unstyled" type="button" onClick={onRetry}>{m.retry}</Button>
    </div> : <>
    <div className="event-filters" role="radiogroup" aria-label={m.filters} onKeyDown={move}>
      {EVENT_FILTERS.map(key => <Button variant="unstyled" type="button" key={key} role="radio" aria-checked={filter === key} tabIndex={filter === key ? 0 : -1}
        className="event-filter" ref={node => { if (node) buttons.current.set(key, node); else buttons.current.delete(key); }}
        onClick={() => onFilter(key)}>
        {filterLabel(key)}<small>{counts[key]}</small>
      </Button>)}
    </div>
    <div className="findings-rows section-body" id="rail-events">
      <AnimatePresence initial={false} mode="popLayout">
      {rows.length === 0 ? <motion.p key="empty" className="event-empty" initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={still ? undefined : { opacity: 0 }} transition={{ duration: .16 }}>{m.empty}</motion.p>
        : <motion.div key={filter} className="event-rows" initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={still ? undefined : { opacity: 0 }} transition={{ duration: .16, ease: [0.22, 1, 0.36, 1] }}>
        {rows.flatMap((row, i) => {
          const year = row.date.slice(0, 4);
          const turn = expanded && year !== (i ? rows[i - 1]!.date.slice(0, 4) : (rail.recent[0] ?? all[0])?.date.slice(0, 4));
          const extra = digest.has(row.id) ? undefined : "";
          const nodes: ReactNode[] = [];
          if (expanded && i > 0 && row.date < rail.since && rows[i - 1]!.date >= rail.since) nodes.push(<hr key="rule" className="section-rule" data-extra="" />);
          if (turn) nodes.push(<p key={`year-${year}`} className="section-group" data-extra="" aria-hidden="true">{year}</p>);
          nodes.push(<EventBlock key={row.id} row={row} ticker={ticker} extra={extra} open={openRows.has(row.id)} focus={focus} arrive={arrived.get(row.id)} motion={rowMotion}
            onToggle={() => setOpenRows(current => { const next = new Set(current); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; })}
            onFocus={onFocus} tip={tip.bind} />);
          return nodes;
        })}
        </motion.div>}
      </AnimatePresence>
      {tip.node}
    </div>
    </>}
  </RailSection>;
}

/** Closed, the newest report and the latest few rows; the focused row stays even when it is older. */
function digestIds(rows: NoiseRow[], focus: string | null): Set<string> {
  const ids = new Set<string>();
  let events = 0;
  for (const row of rows) {
    if (row.kind === "item" && row.item.kind === "report") continue;
    if (events < 3) { ids.add(row.id); events++; }
  }
  const report = rows.find(row => row.kind === "item" && row.item.kind === "report");
  if (report) ids.add(report.id);
  if (focus) {
    const host = rows.find(row => row.id === focus || rowLeaves(row).some(item => item.id === focus));
    if (host) ids.add(host.id);
  }
  return ids;
}

function EventSkeleton() {
  return <>
    <div className="event-filters" aria-hidden="true">{[0, 1, 2, 3, 4].map(i => <span key={i} className="event-filter event-filter--ghost" />)}</div>
    <div className="findings-rows section-body">
      {[0, 1, 2, 3, 4].map(i => <div key={i} className="finding-row event-row"><time className="event-date ghost-text">00.00</time><span className="finding-title ghost-text">{m.title}</span></div>)}
    </div>
  </>;
}

type RowMotion = { layout: false | "position"; layoutDependency: string; exit: typeof rowExit };
type RowProps = { checked: boolean; extra?: string; onClick: () => void; arrive?: number; motion: RowMotion; tip: ReturnType<typeof useRailTip>["bind"] };

function EventBlock({ row, ticker, extra, open, focus, arrive, motion, onToggle, onFocus, tip }: {
  row: NoiseRow; ticker: string; extra?: string; open: boolean; focus: string | null; arrive?: number; motion: RowMotion;
  onToggle: () => void; onFocus: (item: RailItem | null) => void; tip: RowProps["tip"];
}) {
  if (row.kind === "item") {
    const pick = () => onFocus(focus === row.item.id ? null : row.item);
    const props = { checked: focus === row.item.id, extra, onClick: pick, arrive, motion, tip };
    return row.item.kind === "report" ? <ReportRow report={row.item.report} ticker={ticker} {...props} /> : <EventRow event={row.item.event} {...props} />;
  }
  const title = row.kind === "plan" ? m.plan(row.name, row.items.length, exactShares(row.shares)) : m.routine(row.items.length);
  const panelId = `${row.id}-panel`;
  return <div className="event-fold" data-extra={extra} data-class={row.kind === "plan" ? "insider" : "other"}>
    <Button variant="unstyled" type="button" className="finding-row event-row event-fold-row" aria-expanded={open} aria-controls={panelId} data-arrived={arrive != null ? "" : undefined} style={arrivalStyle(arrive)}
      onClick={onToggle}>
      <time className="event-date" dateTime={row.date}>{shortDate(row.date)}</time>
      <span className="finding-title event-fold-title">
        <svg className="fold-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.2 2.2 8 6 4.2 9.8" /></svg>
        <span className="event-fold-text">{title}</span>
        {row.kind === "plan" && <span className="plan-tag">10b5-1</span>}
      </span>
    </Button>
    <div className="event-fold-panel" id={panelId} data-open={open ? "" : undefined} inert={open ? undefined : true}>
      <div className="event-fold-inner">
        {row.items.map(item => item.kind === "event" ? <EventRow key={item.id} event={item.event} checked={focus === item.id} onClick={() => onFocus(focus === item.id ? null : item)} arrive={undefined} motion={motion} tip={tip} /> : null)}
      </div>
    </div>
  </div>;
}

function ReportRow({ report, ticker, checked, extra, onClick, arrive, motion, tip }: RowProps & { report: PublicFilingDigest; ticker: string }) {
  const forms = report.sources.length ? report.sources.map(s => s.form).join(" + ") : report.form;
  const quarter = filingQuarterLabel(ticker, report);
  const title = reportTitle(report, ticker);
  const meta = [m.report, forms, quarter, m.periodEnded(String(report.periodEnd)), report.filingDate].filter(Boolean).join(" · ");
  return <RailRow variant="unstyled" type="button" role="radio" aria-checked={checked} className="finding-row event-row report-row" data-class="report" data-extra={extra} onClick={onClick}
    {...motion} data-arrived={arrive != null ? "" : undefined} style={arrivalStyle(arrive)}
    {...tip(title, reportTitleLang(report), meta)} aria-label={`${m.report} ${shortDate(report.date)} ${title}`}>
    <time className="event-date" dateTime={report.date}>{shortDate(report.date)}</time>
    <span className="finding-title" lang={reportTitleLang(report)}>{title}</span>
  </RailRow>;
}

function EventRow({ event, checked, extra, onClick, arrive, motion, tip }: RowProps & { event: CompanyEvent }) {
  const insider = event.insider;
  const meta = insider ? [insider.title ?? (insider.isDirector ? m.director : insider.isTenPercentOwner ? m.tenPercent : null), insider.sold && insider.rule10b51 === true ? "10b5-1" : null].filter(Boolean).join(" · ") : "";
  const items = event.items.filter(i => i !== "9.01").map(i => `Item ${i}`).join(", ");
  return <RailRow variant="unstyled" type="button" role="radio" aria-checked={checked} className="finding-row event-row" data-class={event.class} data-extra={extra} onClick={onClick}
    {...motion} data-arrived={arrive != null ? "" : undefined} style={arrivalStyle(arrive)}
    {...tip(eventTitle(event), eventTitleLang(event), [EVENT_CLASS_LABEL[event.class], event.form, items, meta, event.filedAt].filter(Boolean).join(" · "))}
    aria-label={`${EVENT_CLASS_LABEL[event.class]} ${shortDate(event.filedAt)} ${eventTitle(event)}${meta ? ` ${meta}` : ""}`}>
    <time className="event-date" dateTime={event.filedAt}>{shortDate(event.filedAt)}</time>
    <span className="finding-title" lang={eventTitleLang(event)}>{eventTitle(event)}</span>
    </RailRow>;
}
