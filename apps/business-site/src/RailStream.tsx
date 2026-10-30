import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "@/packages/web/src/ui/button";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CompanyEvent, EventClass } from "@/shared/analysis-contract/events";
import type { PublicFilingDigest } from "@/shared/analysis-contract/filings";
import { getLocale, messages, useLocale } from "@/packages/web/src/i18n";
import { eventClassLabel, isEsppTransaction, isPlannedInsiderTrade } from "@/shared/analysis-runtime/events";
import { normalizeDisplayText, perShare } from "@/shared/analysis-runtime/locale";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { eventTitle, eventTitleLang, shortDate } from "./events-model";
import { exactShares, insiderCompactMoney, noiseRows, rowLeaves, type EventFilter, type NoiseRow } from "./event-noise";
import { filingQuarterLabel, reportTitle, reportTitleLang, type RailItem, type RailItems } from "./reports-model";
import { KIND_LABEL, VIEW_LABEL, type VerifiedFinding } from "./findings-model";
import { arrivalStyle, RailRow, rowExit, useArrivals } from "./arrivals";
import { useRailTip } from "./RailTip";

const m = messages({
  title: "Findings, reports and events",
  report: "Report",
  sold: (n: number, amount: string) => `Sold ${n} times in 90 days · ${amount} total`,
  bought: (n: number, amount: string) => `Bought ${n} times in 90 days · ${amount} total`,
  plan: "10b5-1 plan", espp: "ESPP purchase",
  sale: "Open-market sale", purchase: "Open-market purchase", sec: "SEC filing ↗",
  detail: (shares: string, price: string, amount: string) => `${shares} shares · Average ${price} · ${amount} total`,
  routine: (n: number) => `Routine 6-K filings × ${n}`, forms: (n: number) => `Form 4 ×${n}`,
  empty: "Nothing in this category yet",
  loadFailed: "Couldn't load this data", retry: "Retry",
  director: "Director", tenPercent: "10% owner",
  severity: (kind: string, n: number) => `${kind} · Severity ${n}`, watchOutcome: "Watch outcome",
}, {
  title: "要点、财报与事件",
  report: "财报",
  sold: (n: number, amount: string) => `90 天内卖出 ${n} 笔 · 合计 ${amount}`,
  bought: (n: number, amount: string) => `90 天内买入 ${n} 笔 · 合计 ${amount}`,
  plan: "计划内", espp: "员工持股计划代买",
  sale: "公开市场卖出", purchase: "公开市场买入", sec: "SEC 文件 ↗",
  detail: (shares: string, price: string, amount: string) => `${shares} 股 · 均价 ${price} · 合计 ${amount}`,
  routine: (n: number) => `6-K 例行文件 × ${n}`, forms: (n: number) => `Form 4 ×${n}`,
  empty: "这一类暂时没有内容",
  loadFailed: "数据暂时加载失败", retry: "重试",
  director: "董事", tenPercent: "10% 股东",
  severity: (kind: string, n: number) => `${kind} · 重要度 ${n}`, watchOutcome: "跟踪结果",
});

/** The readings that carry the report's findings beside its filings; the event-only readings leave them out. */
const FINDINGS_IN: ReadonlySet<EventFilter> = new Set<EventFilter>(["key", "earnings", "all"]);

/** Older rows join this many at a time. */
const PAGE = 12;

type StreamRow = { kind: "noise"; id: string; date: string; row: NoiseRow } | { kind: "finding"; id: string; date: string; finding: VerifiedFinding };

/**
 * The findings slot in after the report they were written from, so the stream reads "the filing, then what it says";
 * without that report among the rows they lead the list.
 */
function composeRows(noise: NoiseRow[], findings: VerifiedFinding[], periodEnd: string | null, filter: EventFilter): StreamRow[] {
  const rows: StreamRow[] = noise.map(row => ({ kind: "noise", id: row.id, date: row.date, row }));
  if (!findings.length || !FINDINGS_IN.has(filter)) return rows;
  const at = noise.findIndex(row => row.kind === "item" && row.item.kind === "report" && row.item.report.periodEnd === periodEnd);
  const date = at >= 0 ? noise[at]!.date : periodEnd ?? "";
  rows.splice(at + 1, 0, ...findings.map((finding): StreamRow => ({ kind: "finding", id: finding.id, date, finding })));
  return rows;
}

/**
 * One stream for the rail: the report's findings, the filings and the events, newest first, in one shape per row: a
 * mark (the event's class, or the finding's severity in its kind's colour), a title, and a line of particulars that
 * starts with the date. Insider trades fold by person and direction over 90 days; routine 6-Ks fold by month.
 * The recent rows show first; older ones load as the reader scrolls to the end.
 */
export function RailStream({ rail, findings, findingsPeriodEnd, verdicts, ticker, updates, focus, phase = "ready", filter, onFocusItem, onFocusFinding, onRetry }: {
  rail: RailItems | null;
  /** Verified findings, most severe first. */
  findings: VerifiedFinding[];
  /** The period the findings were written about: they follow that report in the stream. */
  findingsPeriodEnd: string | null;
  /** Pass or fail of each finding's scored watch, by finding id, once its period reported. */
  verdicts?: Record<string, "pass" | "fail">;
  ticker: string;
  /** Updates the reader took; the rows an update brought enter animated, newest first, pushing the rest down. */
  updates: number;
  /** The focused finding id, report accession or event id. */
  focus: string | null;
  /** `loading` while a retry is in flight; `error` when the events request failed and the rest of the page did not. */
  phase?: "ready" | "loading" | "error";
  /** The reading of the list (`?events=`); Key by default. */
  filter: EventFilter;
  onFocusItem: (item: RailItem | null) => void;
  onFocusFinding: (id: string | null) => void;
  onRetry?: () => void;
}) {
  useLocale();
  const all = rail ? [...rail.recent, ...rail.earlier] : [];
  const noise = noiseRows(all, filter);
  const rows = composeRows(noise, findings, findingsPeriodEnd, filter);
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set());
  const hosts = (id: string | null) => id ? rows.find(r => r.id === id || (r.kind === "noise" && rowLeaves(r.row).some(item => item.id === id))) ?? null : null;
  const focusedRow = hosts(focus);
  // The recent rows open the list; each time the end comes into view another page of older rows joins, and the row in
  // focus is always among them.
  const since = rail?.since ?? "";
  const recentCount = Math.max(PAGE, rows.filter(r => r.date >= since).length);
  const [limit, setLimit] = useState(recentCount);
  const [pagedFor, setPagedFor] = useState(filter);
  if (pagedFor !== filter) { setPagedFor(filter); setLimit(recentCount); }
  const shown = rows.slice(0, Math.max(limit, focusedRow ? rows.indexOf(focusedRow) + 1 : 0));
  const more = shown.length < rows.length;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!el || !more) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) setLimit(n => n + PAGE); }, { root: el.closest(".rail-scroll"), rootMargin: "0px 0px 120px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [more, shown.length]);
  const ids = shown.flatMap(r => [r.id, ...(r.kind === "noise" ? rowLeaves(r.row).map(item => item.id) : [])]);
  const arrived = useArrivals(ids, updates);
  const still = useReducedMotion();
  const tip = useRailTip();
  const rowMotion: RowMotion = { layout: still ? false : "position", layoutDependency: ids.join(), exit: rowExit };
  const [previousFocus, setPreviousFocus] = useState<string | null>(null);
  if (previousFocus !== focus) {
    setPreviousFocus(focus);
    if (focusedRow?.kind === "noise" && focusedRow.row.kind !== "item" && !openRows.has(focusedRow.id)) setOpenRows(new Set(openRows).add(focusedRow.id));
  }
  const toggleRow = (id: string) => setOpenRows(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return <section className="stream" data-section="stream" data-focus={focus != null ? "" : undefined} aria-label={m.title}>
    {phase === "loading" ? <StreamSkeleton /> : phase === "error" ? <div className="event-state">
      <p>{m.loadFailed}</p>
      <Button variant="unstyled" type="button" onClick={onRetry}>{m.retry}</Button>
    </div> : <>
    <div className="stream-rows" id="rail-stream">
      <AnimatePresence initial={false} mode="popLayout">
      {rows.length === 0 ? <motion.p key="empty" className="event-empty" initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={still ? undefined : { opacity: 0 }} transition={{ duration: .16 }}>{m.empty}</motion.p>
        : <motion.div key={filter} className="event-rows" initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={still ? undefined : { opacity: 0 }} transition={{ duration: .16, ease: [0.22, 1, 0.36, 1] }}>
        {shown.map(r => r.kind === "finding"
          ? <FindingRow key={r.id} finding={r.finding} date={r.date} verdict={verdicts?.[r.id]} checked={focus === r.id} arrive={arrived.get(r.id)} motion={rowMotion} tip={tip.bind} onClick={() => onFocusFinding(focus === r.id ? null : r.id)} />
          : <NoiseBlock key={r.id} row={r.row} ticker={ticker} open={openRows.has(r.id)} focus={focus} arrive={arrived.get(r.id)} motion={rowMotion} onToggle={() => toggleRow(r.id)} onFocus={onFocusItem} tip={tip.bind} />)}
        </motion.div>}
      </AnimatePresence>
      {tip.node}
    </div>
    {more && <div ref={end} className="stream-end" aria-hidden="true" />}
    </>}
  </section>;
}

function StreamSkeleton() {
  return <>
    <div className="stream-rows">
      {[0, 1, 2, 3, 4].map(i => <div key={i} className="stream-row"><span className="stream-mark"><i className="finding-mark" /></span><span className="stream-body"><span className="stream-title ghost-text">{m.title}</span><span className="stream-meta ghost-text">00.00</span></span></div>)}
    </div>
  </>;
}

type RowMotion = { layout: false | "position"; layoutDependency: string; exit: typeof rowExit };
type RowProps = { checked: boolean; onClick: () => void; arrive?: number; motion: RowMotion; tip: ReturnType<typeof useRailTip>["bind"] };

/** The mark's shape is the event's class; its colour is the trade's direction, and a planned or routine filing stays quiet. */
function Mark({ cls, direction, quiet }: { cls: EventClass | "report"; direction?: "buy" | "sell" | null; quiet?: boolean }) {
  const icon = cls === "insider" && direction ? (direction === "buy" ? ICON.buy : ICON.sell) : ICON[cls];
  return <span className="stream-mark" data-direction={direction ?? undefined} data-quiet={quiet ? "" : undefined} aria-hidden="true">{icon}</span>;
}

const Icon = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
const FILE = "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8";
const ICON: Record<EventClass | "report" | "buy" | "sell", ReactNode> = {
  report: <Icon d={FILE} />,
  earnings: <Icon d={FILE} />,
  guidance: <Icon d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" />,
  executive: <Icon d="M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21a8 8 0 0 1 16 0" />,
  insider: <Icon d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8 12h8" />,
  buy: <Icon d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-12 3 6-6M10 9h5v5" />,
  sell: <Icon d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-12-3 6 6M15 10v5h-5" />,
  deal: <Icon d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4" />,
  financing: <Icon d="M3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7M12 2 3 7h18z" />,
  capital_return: <Icon d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" />,
  vote: <Icon d="m9 11 3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />,
  legal: <Icon d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1ZM2 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1ZM7 21h10M12 3v18M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />,
  other: <Icon d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />,
};

const join = (parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join(" · ");
/** A bare SEC form number ("4", "8-K") reads as the form it is; "4" alone would read as a count. */
const formName = (form: string) => /^\d+$/.test(form) ? `Form ${form}` : form;

function NoiseBlock({ row, ticker, open, focus, arrive, motion, onToggle, onFocus, tip }: {
  row: NoiseRow; ticker: string; open: boolean; focus: string | null; arrive?: number; motion: RowMotion;
  onToggle: () => void; onFocus: (item: RailItem | null) => void; tip: RowProps["tip"];
}) {
  if (row.kind === "item") {
    const pick = () => onFocus(focus === row.item.id ? null : row.item);
    const props = { checked: focus === row.item.id, onClick: pick, arrive, motion, tip };
    return row.item.kind === "report" ? <ReportRow report={row.item.report} ticker={ticker} {...props} /> : <EventRow event={row.item.event} {...props} />;
  }
  const locale = getLocale();
  const title = row.kind === "plan" ? (row.direction === "sell" ? m.sold : m.bought)(row.items.length, insiderCompactMoney(row.amount)) : m.routine(row.items.length);
  const meta = row.kind === "plan" ? join([shortDate(row.date), eventClassLabel("insider", locale), row.planned && m.plan, row.espp && m.espp, m.forms(row.items.length)])
    : join([shortDate(row.date), eventClassLabel("other", locale)]);
  const panelId = `${row.id}-panel`;
  return <div className="event-fold" data-class={row.kind === "plan" ? "insider" : "other"}>
    <Button variant="unstyled" type="button" className="stream-row event-fold-row" aria-expanded={open} aria-controls={panelId} data-arrived={arrive != null ? "" : undefined} style={arrivalStyle(arrive)}
      onClick={onToggle}>
      {row.kind === "plan" ? <Mark cls="insider" direction={row.direction} quiet={row.planned || row.espp} /> : <Mark cls="other" quiet />}
      <span className="stream-body">
        <span className="stream-title event-fold-text">{row.kind === "plan" && <><span lang="en">{row.name}</span> · </>}{title}</span>
        <span className="stream-meta"><svg className="fold-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.2 2.2 8 6 4.2 9.8" /></svg>{meta}</span>
      </span>
    </Button>
    <div className="event-fold-panel" id={panelId} data-open={open ? "" : undefined} inert={open ? undefined : true}>
      <div className="event-fold-inner">
        {row.kind === "plan" ? row.items.map(item => item.kind === "event" ? <InsiderDetail key={item.id} item={item} direction={row.direction} checked={focus === item.id} onClick={() => onFocus(focus === item.id ? null : item)} /> : null)
          : row.items.map(item => item.kind === "event" ? <EventRow key={item.id} event={item.event} checked={focus === item.id} onClick={() => onFocus(focus === item.id ? null : item)} arrive={undefined} motion={motion} tip={tip} /> : null)}
      </div>
    </div>
  </div>;
}

function ReportRow({ report, ticker, checked, onClick, arrive, motion, tip }: RowProps & { report: PublicFilingDigest; ticker: string }) {
  const forms = report.sources.length ? report.sources.map(s => s.form).join(" + ") : report.form;
  const title = reportTitle(report, ticker);
  const meta = join([shortDate(report.date), m.report, filingQuarterLabel(ticker, report), forms]);
  return <RailRow variant="unstyled" type="button" role="radio" aria-checked={checked} className="stream-row report-row" data-class="report" onClick={onClick}
    {...motion} data-arrived={arrive != null ? "" : undefined} style={arrivalStyle(arrive)}
    {...tip(title, reportTitleLang(report), meta)} aria-label={`${m.report} ${shortDate(report.date)} ${title}`}>
    <Mark cls="report" />
    <span className="stream-body">
      <span className="stream-title" lang={reportTitleLang(report)}>{title}</span>
      <span className="stream-meta">{meta}</span>
    </span>
  </RailRow>;
}

function EventRow({ event, checked, onClick, arrive, motion, tip }: RowProps & { event: CompanyEvent }) {
  const locale = getLocale();
  const insider = event.insider;
  const direction = insider?.bought ? "buy" : insider?.sold ? "sell" : null;
  const planned = isPlannedInsiderTrade(event), espp = isEsppTransaction(event);
  const role = insider ? insider.title ?? (insider.isDirector ? m.director : insider.isTenPercentOwner ? m.tenPercent : null) : null;
  const meta = join([shortDate(event.filedAt), eventClassLabel(event.class, locale), role, planned && m.plan, espp && m.espp, formName(event.form)]);
  const title = eventTitle(event);
  return <RailRow variant="unstyled" type="button" role="radio" aria-checked={checked} className="stream-row" data-class={event.class} onClick={onClick}
    {...motion} data-arrived={arrive != null ? "" : undefined} style={arrivalStyle(arrive)}
    {...tip(title, eventTitleLang(event), meta)} aria-label={`${eventClassLabel(event.class, locale)} ${shortDate(event.filedAt)} ${title}`}>
    <Mark cls={event.class} direction={direction} quiet={planned || espp} />
    <span className="stream-body">
      <span className="stream-title" lang={eventTitleLang(event)}>{title}</span>
      <span className="stream-meta">{meta}</span>
    </span>
  </RailRow>;
}

function FindingRow({ finding, date, verdict, checked, onClick, arrive, motion, tip }: RowProps & { finding: VerifiedFinding; date: string; verdict?: "pass" | "fail" }) {
  const title = normalizeDisplayText(finding.title);
  const severity = m.severity(KIND_LABEL[finding.kind], finding.severity);
  const meta = join([date && shortDate(date), KIND_LABEL[finding.kind], VIEW_LABEL[finding.anchors.view]]);
  return <RailRow variant="unstyled" type="button" role="radio" aria-checked={checked} className="stream-row finding-row" data-kind={finding.kind} onClick={onClick}
    {...motion} data-arrived={arrive != null ? "" : undefined} style={arrivalStyle(arrive)}
    {...tip(title, langOf(finding.title), severity)}>
    <span className="stream-mark"><i className="finding-mark" aria-label={severity}>{finding.severity}</i></span>
    <span className="stream-body">
      <span className="stream-title"><span lang={langOf(finding.title)}>{title}</span>{finding.watchOutcome && <i className="finding-settled" data-verdict={verdict} title={m.watchOutcome} aria-label={m.watchOutcome}>{verdict === "pass" ? "✓" : verdict === "fail" ? "✗" : "↻"}</i>}</span>
      <span className="stream-meta">{meta}</span>
    </span>
  </RailRow>;
}

function InsiderDetail({ item, direction, checked, onClick }: { item: RailItem & { kind: "event" }; direction: "buy" | "sell"; checked: boolean; onClick: () => void }) {
  const event = item.event;
  const trade = direction === "sell" ? event.insider!.sold! : event.insider!.bought!;
  const amount = direction === "sell" ? event.insider!.sold!.proceeds : event.insider!.bought!.cost;
  return <div className="event-fold-detail">
    <Button variant="unstyled" type="button" aria-pressed={checked} onClick={onClick}>
      <time dateTime={event.filedAt}>{event.filedAt}</time>
      <span>{direction === "sell" ? m.sale : m.purchase}</span>
      <span>{m.detail(exactShares(trade.shares), perShare(trade.averagePrice, "USD", getLocale()), insiderCompactMoney(amount))}</span>
    </Button>
    <a href={event.documentUrl || event.edgarUrl} target="_blank" rel="noopener noreferrer">{m.sec}</a>
  </div>;
}
