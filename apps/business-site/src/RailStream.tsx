import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "@/packages/web/src/ui/button";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CompanyEvent, EventClass } from "@/shared/analysis-contract/events";
import type { PublicFilingDigest } from "@/shared/analysis-contract/filings";
import { getLocale, messages, useLocale } from "@/packages/web/src/i18n";
import { eventClassLabel, isEsppTransaction, isPlannedInsiderTrade } from "@/shared/analysis-runtime/events";
import { normalizeDisplayText, perShare } from "@/shared/analysis-runtime/locale";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";
import type { InsiderPersonSummary, InsidersPublication } from "@/shared/analysis-contract/insiders";
import { eventTitle, insiderTitleParts, eventTitleLang, insiderTotalDollars, shortDate } from "./events-model";
import { exactShares, insiderCompactMoney, railLayout, rowLeaves, streamRows, type EventFilter, type InsiderFiling, type NoiseRow, type StreamRow as Row } from "./event-noise";
import { CODE_LABEL, fallbackInsiders, netValueUnknown, roleLabel, useInsiderHistory, useInsiders, type InsiderHistory } from "./insiders-model";
import { filingQuarterLabel, reportTitle, reportTitleLang, type RailItem, type RailItems } from "./reports-model";
import { KIND_LABEL, VIEW_LABEL, type VerifiedFinding } from "./findings-model";
import { SeverityIcon, severityLabel } from "./SeverityIcon";
import { arrivalStyle, RailRow, rowExit, useArrivals } from "./arrivals";
import { useRailTip } from "./RailTip";

const m = messages({
  title: "Findings, reports and events",
  report: "Report",
  plan: "10b5-1 plan", espp: "ESPP purchase", sec: "SEC filing ↗",
  routine: (n: number) => `Routine 6-K filings × ${n}`, forms: (n: number) => `Form 4 ×${n}`,
  fallback: "No key events in the last 90 days — showing all",
  empty: "Nothing in this category yet",
  loadFailed: "Couldn't load this data", retry: "Retry",
  director: "Director", tenPercent: "10% owner",
  watchOutcome: "Watch outcome",
  newTag: "New",
  trade: (what: string, shares: string) => `${what} ${shares} shares`, shares: (n: string) => `${n} shares`,
  netSold: (amount: string, shares: string) => `Net sold ${amount} · ${shares} shares`, netBought: (amount: string, shares: string) => `Net bought ${amount} · ${shares} shares`,
  noTrades: "No open-market trades", sales: (n: number) => `${n} ${n === 1 ? "sale" : "sales"}`, purchases: (n: number) => `${n} ${n === 1 ? "purchase" : "purchases"}`,
  history: (name: string) => `${name}: every Form 4 transaction`, ownedAfter: (shares: string) => `Owned after ${shares}`, indirect: "Indirect", derivative: "Derivative",
  loadMore: "Load more", loadingHistory: "Loading…", historyFailed: "Couldn't load the history",
}, {
  title: "要点、财报与事件",
  report: "财报",
  plan: "计划内", espp: "员工持股计划代买", sec: "SEC 文件 ↗",
  routine: (n: number) => `6-K 例行文件 × ${n}`, forms: (n: number) => `Form 4 ×${n}`,
  fallback: "近 90 天没有重要事件，已显示全部",
  empty: "这一类暂时没有内容",
  loadFailed: "数据暂时加载失败", retry: "重试",
  director: "董事", tenPercent: "10% 股东",
  watchOutcome: "跟踪结果",
  newTag: "新",
  trade: (what: string, shares: string) => `${what} ${shares} 股`, shares: (n: string) => `${n} 股`,
  netSold: (amount: string, shares: string) => `净卖出 ${amount} · ${shares} 股`, netBought: (amount: string, shares: string) => `净买入 ${amount} · ${shares} 股`,
  noTrades: "无公开市场交易", sales: (n: number) => `卖出 ${n} 笔`, purchases: (n: number) => `买入 ${n} 笔`,
  history: (name: string) => `${name}：全部 Form 4 交易`, ownedAfter: (shares: string) => `交易后持股 ${shares}`, indirect: "间接持有", derivative: "衍生品",
  loadMore: "加载更多", loadingHistory: "加载中…", historyFailed: "交易历史暂时加载失败",
});

/** Older rows join this many at a time. */
const PAGE = 12;

type StreamRow = Row<VerifiedFinding>;
const leavesOf = (r: StreamRow) => r.kind === "noise" ? rowLeaves(r.row) : r.kind === "person" ? r.items : [];

/**
 * One stream for the rail: the report's findings, the filings and the events, newest first, in one shape per row: a
 * mark (the event's class, or the finding's severity icon), a title, and a line of particulars that
 * starts with the date. Insider trades list by person, at the date of their latest trade; routine 6-Ks fold by month.
 * The recent rows show first; older ones load as the reader scrolls to the end.
 */
export function RailStream({ rail, findings, findingsPeriodEnd, verdicts, ticker, updates, focus, phase = "ready", filter, fallback = false, onFocusItem, onFocusFinding, onRetry }: {
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
  fallback?: boolean;
  onFocusItem: (item: RailItem | null) => void;
  onFocusFinding: (id: string | null) => void;
  onRetry?: () => void;
}) {
  useLocale();
  const all = rail ? [...rail.recent, ...rail.earlier] : [];
  const [now] = useState(() => new Date());
  const layout = railLayout(all, filter);
  // The people come from Spontra Analysis's ledger, which reaches back past the rail, and from the rail's own filings until it answers.
  const filings = layout.insiders;
  const events = filings.map(item => item.event);
  const insiders = useInsiders(ticker, updates, filings.length > 0, () => fallbackInsiders(ticker, events, now));
  const rows = streamRows(layout, findings, findingsPeriodEnd, filter, insiders.persons);
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set());
  const hosts = (id: string | null) => id ? rows.find(r => r.id === id || leavesOf(r).some(item => item.id === id)) ?? null : null;
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
  const ids = shown.flatMap(r => [r.id, ...leavesOf(r).map(item => item.id)]);
  const arrived = useArrivals(ids, updates);
  const still = useReducedMotion();
  const tip = useRailTip();
  const rowMotion: RowMotion = { layout: still ? false : "position", layoutDependency: ids.join(), exit: rowExit };
  const [previousFocus, setPreviousFocus] = useState<string | null>(null);
  if (previousFocus !== focus) {
    setPreviousFocus(focus);
    if (focusedRow?.kind === "noise" && focusedRow.row.kind !== "item" && !openRows.has(focusedRow.id)) setOpenRows(new Set(openRows).add(focusedRow.id));
    // A trade in focus opens the row of the person who filed it.
    if (focusedRow?.kind === "person" && !openRows.has(focusedRow.id)) setOpenRows(new Set(openRows).add(focusedRow.id));
  }
  const toggleRow = (id: string) => setOpenRows(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return <section className="stream" data-section="stream" data-focus={focus != null ? "" : undefined} aria-label={m.title}>
    {phase === "loading" ? <StreamSkeleton /> : phase === "error" ? <div className="event-state">
      <p>{m.loadFailed}</p>
      <Button variant="unstyled" type="button" onClick={onRetry}>{m.retry}</Button>
    </div> : <>
    {fallback && <p className="event-empty" role="status">{m.fallback}</p>}
    <div className="stream-rows" id="rail-stream">
      <AnimatePresence initial={false} mode="popLayout">
      {rows.length === 0 ? <motion.p key="empty" className="event-empty" initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={still ? undefined : { opacity: 0 }} transition={{ duration: .16 }}>{m.empty}</motion.p>
        : <motion.div key={filter} className="event-rows" initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={still ? undefined : { opacity: 0 }} transition={{ duration: .16, ease: [0.22, 1, 0.36, 1] }}>
        {shown.map(r => r.kind === "finding"
          ? <FindingRow key={r.id} finding={r.finding} date={r.date} verdict={verdicts?.[r.id]} checked={focus === r.id} arrive={arrived.get(r.id)} motion={rowMotion} tip={tip.bind} onClick={() => onFocusFinding(focus === r.id ? null : r.id)} />
          : r.kind === "person" ? <PersonRow key={r.id} person={r.person} source={insiders.source} ticker={ticker} events={events} items={filings} now={now}
            open={openRows.has(r.id)} focus={focus} arrive={arrived.get(r.id)} onToggle={() => toggleRow(r.id)} onFocus={onFocusItem} />
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
  const title = m.routine(row.items.length);
  const meta = join([shortDate(row.date), eventClassLabel("other", getLocale())]);
  const panelId = `${row.id}-panel`;
  return <div className="event-fold" data-class="other">
    <Button variant="unstyled" type="button" className="stream-row event-fold-row" aria-expanded={open} aria-controls={panelId} data-arrived={arrive != null ? "" : undefined} style={arrivalStyle(arrive)}
      onClick={onToggle}>
      <Mark cls="other" quiet />
      <span className="stream-body">
        <span className="stream-title event-fold-text" title={title}>{title}</span>
        <span className="stream-meta"><Chevron />{meta}</span>
      </span>
    </Button>
    <div className="event-fold-panel" id={panelId} data-open={open ? "" : undefined} inert={open ? undefined : true}>
      <div className="event-fold-inner">
        {row.items.map(item => item.kind === "event" ? <EventRow key={item.id} event={item.event} checked={focus === item.id} onClick={() => onFocus(focus === item.id ? null : item)} arrive={undefined} motion={motion} tip={tip} /> : null)}
      </div>
    </div>
  </div>;
}

const Chevron = () => <svg className="fold-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.2 2.2 8 6 4.2 9.8" /></svg>;
const ARROW = { sell: "M6 2.5v7M3 6.5l3 3 3-3", buy: "M6 9.5v-7M3 5.5l3-3 3 3" } as const;
const Arrow = ({ direction }: { direction: "buy" | "sell" }) => <svg className="insider-arrow" data-direction={direction} viewBox="0 0 12 12" aria-hidden="true"><path d={ARROW[direction]} /></svg>;
/** The mark of a trade the reader has not seen before: filed and recorded within the last two weeks. */
const NewTag = () => <span className="insider-new"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5 7.3 4.7 10.5 6 7.3 7.3 6 10.5 4.7 7.3 1.5 6l3.2-1.3Z" /></svg>{m.newTag}</span>;

const domId = (key: string) => `insider-${key.replace(/[^a-z0-9]/gi, "-")}-panel`;

/**
 * One person who filed a Form 4 of the company: the latest trade with its amount, the role, the net position over their
 * whole history and the counts. Open, the row lists that history a page at a time.
 */
function PersonRow({ person, source, ticker, events, items, now, open, focus, arrive, onToggle, onFocus }: {
  person: InsiderPersonSummary; source: InsidersPublication["source"]; ticker: string; events: readonly CompanyEvent[]; items: readonly InsiderFiling[]; now: Date;
  open: boolean; focus: string | null; arrive?: number; onToggle: () => void; onFocus: (item: RailItem | null) => void;
}) {
  const latest = person.latest;
  const direction = latest?.side === "buy" ? "buy" : latest?.side === "sell" ? "sell" : null;
  const history = useInsiderHistory(ticker, person.key, open, source, events, now);
  const traded = person.sold.count + person.bought.count > 0;
  // A net that leaves unpriced lines out is no net value: the amount reads "—" and the shares say which way it went.
  const netValue = netValueUnknown(person, events) ? null : person.net.value;
  const netSold = netValue == null ? person.net.shares < 0 : netValue < 0 || (netValue === 0 && person.net.shares < 0);
  const net = traded ? (netSold ? m.netSold : m.netBought)(netValue == null ? "—" : insiderCompactMoney(Math.abs(netValue)), exactShares(Math.abs(person.net.shares))) : m.noTrades;
  const meta = join([roleLabel(person.role), net, person.sold.count > 0 && `${m.sales(person.sold.count)} ${insiderTotalDollars(person.sold)}`, person.bought.count > 0 && `${m.purchases(person.bought.count)} ${insiderTotalDollars(person.bought)}`, m.forms(person.filings)]);
  const panelId = domId(person.key);
  return <div className="insider-person" data-class="insider" data-new={person.newCount > 0 ? "" : undefined}>
    <Button variant="unstyled" type="button" className="stream-row insider-person-row" aria-expanded={open} aria-controls={panelId} data-arrived={arrive != null ? "" : undefined} style={arrivalStyle(arrive)} onClick={onToggle}>
      <Mark cls="insider" direction={direction} quiet={!direction || latest?.planned} />
      <span className="stream-body">
        <span className="stream-title insider-title">
          <span className="insider-person-name"><span className="insider-name" lang="en">{person.name}</span>{person.newCount > 0 && <NewTag />}</span>
          {latest && <span className="insider-transaction">
            <span className="insider-content">{shortDate(latest.date)} · {m.trade(CODE_LABEL[latest.code], exactShares(latest.shares))}{latest.planned ? ` · ${m.plan}` : ""}</span>
            {latest.value != null && latest.value > 0 && <span className="insider-amount">{latest.side === "sell" ? <Arrow direction="sell" /> : latest.side === "buy" ? <Arrow direction="buy" /> : null}{insiderCompactMoney(latest.value)}</span>}
          </span>}
        </span>
        <span className="stream-meta" title={meta}><Chevron />{traded && <Arrow direction={netSold ? "sell" : "buy"} />}{meta}</span>
      </span>
    </Button>
    <div className="event-fold-panel" id={panelId} data-open={open ? "" : undefined} inert={open ? undefined : true}>
      <div className="event-fold-inner">
        {open && <PersonHistory name={person.name} history={history} items={items} focus={focus} onFocus={onFocus} />}
      </div>
    </div>
  </div>;
}

/** The person's lines, newest first: date, what, shares, price, amount, what they held after, and the filing. A line on the rail is a link to its event. */
function PersonHistory({ name, history, items, focus, onFocus }: { name: string; history: InsiderHistory; items: readonly RailItem[]; focus: string | null; onFocus: (item: RailItem | null) => void }) {
  return <>
    <ol className="insider-history" aria-label={m.history(name)}>
      {history.items.map(row => {
        const item = items.find(i => i.id === row.accession);
        const tags = join([row.planned && m.plan, row.ownership === "I" && m.indirect, row.derivative && m.derivative]);
        const cells = <>
          <time dateTime={row.date}>{row.date}</time>
          <span className="insider-history-code" data-side={row.side}><b lang="en">{row.code}</b>{CODE_LABEL[row.code]}</span>
          <span>{m.shares(exactShares(row.shares))}</span>
          <span>{row.price != null ? perShare(row.price, "USD", getLocale()) : "—"}</span>
          <span className="insider-amount">{row.value != null && row.value > 0 ? insiderCompactMoney(row.value) : "—"}</span>
          {row.ownedAfter != null && <span className="insider-history-after">{m.ownedAfter(exactShares(row.ownedAfter))}</span>}
          {tags && <span className="insider-history-tags">{tags}</span>}
          {row.isNew && <NewTag />}
        </>;
        return <li key={row.id} data-new={row.isNew ? "" : undefined}>
          {item ? <Button variant="unstyled" type="button" className="insider-history-row" aria-pressed={focus === row.accession} onClick={() => onFocus(focus === row.accession ? null : item)}>{cells}</Button>
            : <span className="insider-history-row">{cells}</span>}
          <a href={row.filingUrl} target="_blank" rel="noopener noreferrer">{m.sec}</a>
        </li>;
      })}
    </ol>
    {history.phase === "loading" && <p className="insider-history-state" aria-busy="true">{m.loadingHistory}</p>}
    {history.phase === "error" && <p className="insider-history-state">{m.historyFailed} <Button variant="unstyled" type="button" onClick={history.more}>{m.retry}</Button></p>}
    {history.phase === "ready" && history.nextCursor && <Button variant="unstyled" type="button" className="insider-history-more" onClick={history.more}>{m.loadMore}</Button>}
  </>;
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

function InsiderTitle({ name, content, amount, tags, full }: { name: string; content: string; amount: string | null; tags: string; full: string }) {
  return <span className="stream-title insider-title" title={full}>
    <span className="insider-name" lang="en">{name}</span>
    <span className="insider-transaction">
      <span className="insider-content">{content}</span>
      {amount && <span className="insider-amount">{amount}</span>}
    </span>
    {tags && <span className="insider-tags">{tags}</span>}
  </span>;
}

function EventRow({ event, checked, onClick, arrive, motion, tip }: RowProps & { event: CompanyEvent }) {
  const locale = getLocale();
  const insider = event.insider;
  const direction = insider?.bought ? "buy" : insider?.sold ? "sell" : null;
  const planned = isPlannedInsiderTrade(event), espp = isEsppTransaction(event);
  const role = insider ? insider.title ?? (insider.isDirector ? m.director : insider.isTenPercentOwner ? m.tenPercent : null) : null;
  const meta = join([shortDate(event.filedAt), eventClassLabel(event.class, locale), role, formName(event.form)]);
  const title = eventTitle(event);
  const parts = insiderTitleParts(event);
  return <RailRow variant="unstyled" type="button" role="radio" aria-checked={checked} className="stream-row" data-class={event.class} onClick={onClick}
    {...motion} data-arrived={arrive != null ? "" : undefined} style={arrivalStyle(arrive)}
    {...tip(title, eventTitleLang(event), meta)} aria-label={`${eventClassLabel(event.class, locale)} ${shortDate(event.filedAt)} ${title}`}>
    <Mark cls={event.class} direction={direction} quiet={planned || espp} />
    <span className="stream-body">
      {parts ? <InsiderTitle {...parts} tags={join([planned && m.plan, espp && m.espp])} full={join([title, planned && m.plan, espp && m.espp])} />
        : <span className="stream-title" lang={eventTitleLang(event)} title={title}>{title}</span>}
      <span className="stream-meta" title={meta}>{meta}</span>
    </span>
  </RailRow>;
}

function FindingRow({ finding, date, verdict, checked, onClick, arrive, motion, tip }: RowProps & { finding: VerifiedFinding; date: string; verdict?: "pass" | "fail" }) {
  const title = normalizeDisplayText(finding.title);
  const severity = `${KIND_LABEL[finding.kind]} · ${severityLabel(finding.severity)}`;
  const meta = join([date && shortDate(date), KIND_LABEL[finding.kind], VIEW_LABEL[finding.anchors.view]]);
  return <RailRow variant="unstyled" type="button" role="radio" aria-checked={checked} className="stream-row finding-row" data-kind={finding.kind} onClick={onClick}
    {...motion} data-arrived={arrive != null ? "" : undefined} style={arrivalStyle(arrive)}
    {...tip(title, langOf(finding.title), severity)}>
    <span className="stream-mark"><SeverityIcon severity={finding.severity} /></span>
    <span className="stream-body">
      <span className="stream-title"><span lang={langOf(finding.title)}>{title}</span>{finding.watchOutcome && <i className="finding-settled" data-verdict={verdict} title={m.watchOutcome} aria-label={m.watchOutcome}>{verdict === "pass" ? "✓" : verdict === "fail" ? "✗" : "↻"}</i>}</span>
      <span className="stream-meta">{meta}</span>
    </span>
  </RailRow>;
}
