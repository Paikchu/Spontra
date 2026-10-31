import { useEffect, useRef, useState } from "react";
import { MomentumTag } from "./MomentumTag";
import { momentumOf } from "./momentum";
import { getLocale, messages, useLocale } from "@/packages/web/src/i18n";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { compactMoney, normalizeDisplayText } from "@/shared/analysis-runtime/locale";
import type { HomeCompany, HomeDigest } from "../../../shared/analysis-contract/home.ts";
import { CompanyLogo } from "./CompanyMark";
import { KIND_LABEL } from "./findings-labels";
import type { DigestStatus } from "./home-data";
import { stripBandPath, stripOf } from "./home-strip";
import { PeriodMark } from "./PeriodMark";
import { PrivacyNote } from "./PrivacyNote";
import { SearchPanel } from "./SearchDialog";
import { LanguageToggle, ThemeToggle } from "./Sidebar";
import { worthWatching, type SignalTab, type WorthWatchingCard } from "./worth-watching";
import { FRESH_DAYS, freshResults, type FreshResult } from "./fresh-results";

const m = messages({
  title: "See how a company makes money, and spot the risks early",
  trust: (count: number, time: string) => `${count} US companies, read from SEC EDGAR · Updated ${time}`,
  trustStatic: (count: number) => `${count} US companies, read from SEC EDGAR`,
  search: "Search companies",
  recent: "Recently viewed",
  popular: "Popular",
  freshTitle: "Fresh results",
  freshSub: (days: number) => `Reported in the last ${days} days`,
  freshFiled: (date: string) => `Filed ${date}`,
  freshRevenue: "Revenue",
  freshMargin: "Operating margin",
  freshMarginChange: (pp: string) => `${pp} pts YoY`,
  freshOpen: (ticker: string, period: string) => `Open ${ticker} at its ${period} report`,
  signalsTitle: "Worth watching",
  tabAll: "All",
  tabRisks: "Risks",
  tabStrengths: "Strengths",
  tabShifts: "Shifts",
  signalsEmpty: "Nothing new in this category",
  moreFindings: (n: number) => `${n} more`,
  companiesTitle: "Companies covered",
  sortLabel: "Sort",
  sortLatest: "Latest report",
  sortYoy: "Revenue YoY",
  sortRisk: "Risk count",
  sortTicker: "Ticker order",
  colCompany: "Company",
  colStatement: "Latest quarter",
  colRevenue: "Revenue",
  colYoy: "YoY",
  colReport: "Report",
  colFindings: "Findings",
  stripLabel: (revenue: string, net: string) => `Revenue ${revenue}, net income ${net}`,
  counts: (r: number, s: number) => `${r} risks · ${s} strengths`,
  findingsPending: "Findings still generating",
  noFindings: "No findings yet",
  updating: "Updating",
  disclaimer: "Generated from public SEC filings for research only. Not investment advice.",
  notDisclosed: "Not disclosed this quarter",
  missingYoy: "Fewer than two quarters, so the year-over-year rate is unavailable",
  error: "Couldn't load data",
  retry: "Retry",
  offline: "You are offline",
  justNow: "just now",
  minutesAgo: (n: number) => `${n} minutes ago`,
  hoursAgo: (n: number) => `${n} hours ago`,
  daysAgo: (n: number) => `${n} days ago`,
}, {
  title: "看懂一家公司怎么赚钱，提前发现风险",
  trust: (count: number, time: string) => `已覆盖 ${count} 家美股公司，数据来自 SEC EDGAR · 最近更新 ${time}`,
  trustStatic: (count: number) => `已覆盖 ${count} 家美股公司，数据来自 SEC EDGAR`,
  search: "搜索公司",
  recent: "最近查看",
  popular: "热门",
  freshTitle: "最新财报",
  freshSub: (days: number) => `近 ${days} 天发布业绩`,
  freshFiled: (date: string) => `${date} 发布`,
  freshRevenue: "营收",
  freshMargin: "营业利润率",
  freshMarginChange: (pp: string) => `同比 ${pp} 个百分点`,
  freshOpen: (ticker: string, period: string) => `打开 ${ticker} ${period} 财报`,
  signalsTitle: "值得关注",
  tabAll: "全部",
  tabRisks: "风险",
  tabStrengths: "优势",
  tabShifts: "变化",
  signalsEmpty: "这一类暂时没有新要点",
  moreFindings: (n: number) => `另有 ${n} 条`,
  companiesTitle: "已覆盖公司",
  sortLabel: "排序",
  sortLatest: "最近财报",
  sortYoy: "营收同比",
  sortRisk: "风险数量",
  sortTicker: "代码字母序",
  colCompany: "公司",
  colStatement: "最新季度",
  colRevenue: "营收",
  colYoy: "同比",
  colReport: "财报",
  colFindings: "要点",
  stripLabel: (revenue: string, net: string) => `营收 ${revenue}，净利润 ${net}`,
  counts: (r: number, s: number) => `风险 ${r} · 优势 ${s}`,
  findingsPending: "要点生成中",
  noFindings: "暂无要点",
  updating: "更新中",
  disclaimer: "本站内容基于公开 SEC 申报自动生成，仅供研究参考，不构成投资建议。",
  notDisclosed: "该季度财报未披露此项",
  missingYoy: "历史不足两个季度，无法计算同比",
  error: "数据暂时加载失败",
  retry: "重试",
  offline: "网络已断开",
  justNow: "刚刚",
  minutesAgo: (n: number) => `${n} 分钟前`,
  hoursAgo: (n: number) => `${n} 小时前`,
  daysAgo: (n: number) => `${n} 天前`,
});

type SortKey = "latest" | "yoy" | "risk" | "ticker";

function money(value: string, currency: string): string {
  const amount = Number(value);
  return Number.isFinite(amount) ? compactMoney(amount, currency, getLocale()) : "—";
}

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return m.justNow;
  if (minutes < 60) return m.minutesAgo(minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return m.hoursAgo(hours);
  return m.daysAgo(Math.round(hours / 24));
}

function sorted(companies: HomeCompany[], sort: SortKey): HomeCompany[] {
  const list = [...companies];
  const ticker = (a: HomeCompany, b: HomeCompany) => a.ticker.localeCompare(b.ticker);
  if (sort === "ticker") return list.sort(ticker);
  if (sort === "yoy") return list.sort((a, b) => (b.revenue?.yoyPct ?? -Infinity) - (a.revenue?.yoyPct ?? -Infinity) || ticker(a, b));
  if (sort === "risk") return list.sort((a, b) => b.findingCounts.risk - a.findingCounts.risk || ticker(a, b));
  return list.sort((a, b) => (b.latestPeriod?.periodEnd ?? "").localeCompare(a.latestPeriod?.periodEnd ?? "") || ticker(a, b));
}

/** Cards in rank order, gathered under the company each belongs to; a company's group stands where its first card ranked. */
function grouped(cards: WorthWatchingCard[]): Array<{ company: HomeCompany; findings: WorthWatchingCard["finding"][]; extra: number }> {
  const groups = new Map<string, { company: HomeCompany; findings: WorthWatchingCard["finding"][]; extra: number }>();
  for (const card of cards) {
    const group = groups.get(card.company.ticker) ?? { company: card.company, findings: [], extra: 0 };
    group.findings.push(card.finding);
    group.extra = card.extra;
    groups.set(card.company.ticker, group);
  }
  return [...groups.values()];
}

function Delta({ pct, title }: { pct: number | null; title?: string }) {
  if (pct == null) return <span className="home-delta" title={title}>—</span>;
  const dir = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "";
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return <span className="home-delta" data-dir={dir}>{arrow}{sign}{Math.abs(pct).toFixed(1)}%</span>;
}

/** Eight quarters of revenue as bars: the row's picture when the quarter's statement is not in the digest. */
function Bars({ trend }: { trend: Array<{ value: string }> }) {
  const values = trend.map(point => Number(point.value)).filter(value => Number.isFinite(value) && value >= 0);
  const max = Math.max(1, ...values);
  return <span className="home-bars" aria-hidden="true">{values.map((value, index) =>
    <i key={index} style={{ ["--h" as string]: `${Math.max(8, (value / max) * 100)}%` }} />)}</span>;
}

/** The quarter's revenue flowing into its costs and its profit: the statement the company page draws, at row size. */
function StatementStrip({ company }: { company: HomeCompany }) {
  const statement = company.statement ?? null;
  const strip = statement ? stripOf(statement) : null;
  if (!statement || !strip) return <Bars trend={company.revenueTrend} />;
  const { width, height, bar } = strip;
  return <svg className="home-strip" viewBox={`0 0 ${width} ${height + (strip.loss ? strip.loss.h + 2 : 0)}`} width={width} height={height + (strip.loss ? strip.loss.h + 2 : 0)} role="img"
    aria-label={m.stripLabel(money(statement.revenue, statement.currency), money(statement.net, statement.currency))}>
    {strip.bands.map(band => <path key={band.kind} className="home-strip-band" data-kind={band.kind} d={stripBandPath(band, strip)} />)}
    <rect className="home-strip-bar" data-kind="revenue" x={0} y={0} width={bar} height={height} />
    {strip.bands.map(band => <rect key={band.kind} className="home-strip-bar" data-kind={band.kind} x={width - bar} y={band.ty} width={bar} height={band.th} />)}
    {strip.loss && <rect className="home-strip-loss" x={width - bar - 0.5} y={strip.loss.y + 1.5} width={bar - 1} height={strip.loss.h - 1} />}
  </svg>;
}

const filedDate = (date: string) => getLocale() === "zh-CN" ? `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`
  : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
const signedPp = (pp: number) => `${pp > 0 ? "+" : pp < 0 ? "−" : ""}${Math.abs(pp).toFixed(1)}`;

/** One fresh report: the company, when it filed, revenue with its year-over-year growth and the operating margin's move; the card opens the quarter. */
function FreshCard({ result, name }: { result: FreshResult; name: { text: string; lang: string } }) {
  const { company } = result, period = company.latestPeriod!;
  const fiscal = period.labelSource && period.labelSource !== "unknown" && period.fiscalYear && period.fiscalQuarter ? period : null;
  const label = fiscal ? getLocale() === "zh-CN" ? `${fiscal.fiscalYear} 财年 Q${fiscal.fiscalQuarter}` : `FY${String(fiscal.fiscalYear).slice(-2)} Q${fiscal.fiscalQuarter}` : period.calendarLabel;
  const pp = result.marginChangePp;
  return <li className="home-fresh-card">
    <a href={result.href} data-nav aria-label={m.freshOpen(company.ticker, label)}>
      <span className="home-fresh-head">
        <CompanyLogo ticker={company.ticker} small /><b lang="en">{company.ticker}</b><span lang={name.lang}>{name.text}</span>
      </span>
      <span className="home-fresh-when"><time dateTime={result.filedAt}>{m.freshFiled(filedDate(result.filedAt))}</time><span aria-hidden="true">·</span><span>{label}</span></span>
      <span className="home-fresh-figure">
        <small>{m.freshRevenue}</small>
        <strong>{company.revenue ? money(company.revenue.value, company.revenue.currency) : "—"}</strong>
        <Delta pct={company.revenue?.yoyPct ?? null} />
      </span>
      {result.marginPct != null && <span className="home-fresh-figure">
        <small>{m.freshMargin}</small>
        <strong>{result.marginPct.toFixed(1)}%</strong>
        {pp != null && <span className="home-delta" data-dir={pp > 0 ? "up" : pp < 0 ? "down" : "flat"}>{m.freshMarginChange(signedPp(pp))}</span>}
      </span>}
    </a>
  </li>;
}

/** Homepage: the covered catalog, the latest findings, and a search that only opens a covered company. */
export function Home({ light, onToggleTheme, recent, onPick, digest = null, digestStatus = "loading", onRetry, onSearch }: {
  light: boolean;
  onToggleTheme: () => void;
  recent: string[];
  onPick: (ticker: string) => void;
  digest?: HomeDigest | null;
  digestStatus?: DigestStatus;
  onRetry?: () => void;
  onSearch?: () => void;
}) {
  const locale = useLocale();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stuck, setStuck] = useState(false);
  const [fieldHidden, setFieldHidden] = useState(false);
  const [offline, setOffline] = useState(false);
  const [sort, setSort] = useState<SortKey>("latest");
  const [tab, setTab] = useState<SignalTab>("all");
  const companies = digest?.companies ?? [];
  const catalog = companies.map(company => ({ ticker: company.ticker, name: company.name, nameZh: company.nameZh, aliases: company.aliases }));
  const catalogStatus = digestStatus === "ready" ? "ready" : digestStatus === "error" ? "error" : "loading";
  const chips = recent.length > 0
    ? recent.slice(0, 5).map(ticker => ({ ticker, popular: false }))
    : (digest?.popular ?? []).slice(0, 5).map(ticker => ({ ticker, popular: true }));
  const shown = sorted(companies, sort);
  const groups = grouped(worthWatching(companies, tab, 8));
  const showSignals = digestStatus === "loading" || worthWatching(companies, "all").length > 0;
  const [now] = useState(() => new Date());
  const fresh = digestStatus === "loading" ? [] : freshResults(companies, now);
  const updated = digest ? relativeTime(digest.coverage.lastUpdatedAt) : null;
  const count = digest?.coverage.count ?? 0;

  useEffect(() => { if (matchMedia("(pointer: fine)").matches) inputRef.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const home = document.querySelector<HTMLElement>("main.home");
    const scroller: HTMLElement | Window = home && home.scrollHeight > home.clientHeight + 1 ? home : window;
    const onScroll = () => setStuck((scroller === window ? window.scrollY : (scroller as HTMLElement).scrollTop) >= 8);
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [digestStatus]);
  useEffect(() => {
    const field = inputRef.current;
    if (!field || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setFieldHidden(!entry?.isIntersecting), { threshold: 0.15 });
    observer.observe(field);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const down = () => setOffline(true);
    const up = () => setOffline(false);
    window.addEventListener("offline", down);
    window.addEventListener("online", up);
    return () => { window.removeEventListener("offline", down); window.removeEventListener("online", up); };
  }, []);

  function nameOf(company: HomeCompany) {
    if (locale === "zh-CN" && company.nameZh) return { text: company.nameZh, lang: "zh-CN" as const };
    return { text: company.name, lang: langOf(company.name) };
  }

  return <main className="home">
    <header className="home-nav" data-stuck={stuck || undefined}>
      <a className="home-brand" href="/" data-nav>
        <span className="home-mark" lang="en">BV</span>
        <span lang="en">Business View</span>
      </a>
      <div className="home-nav-tools">
        {fieldHidden && <button type="button" className="home-nav-search" onClick={onSearch}>
          <span>{m.search}</span><kbd aria-hidden="true">/</kbd>
        </button>}
        <ThemeToggle light={light} onToggle={onToggleTheme} />
        <LanguageToggle />
      </div>
    </header>
    <div className="home-wrap">
      <section className="home-hero" aria-labelledby="home-title">
        <h1 id="home-title">{m.title}</h1>
        <SearchPanel inline current={null} recent={recent} onPick={onPick} inputRef={inputRef} catalog={catalog} popular={digest?.popular ?? []} catalogStatus={catalogStatus} />
        {digestStatus !== "loading" && <p className="home-trust">{updated ? m.trust(count, updated) : m.trustStatic(count)}</p>}
      </section>
      {chips.length > 0 && <nav className="home-quick" aria-label={chips[0].popular ? m.popular : m.recent}>
        <span>{chips[0].popular ? m.popular : m.recent}</span>
        {chips.map(chip => <a key={chip.ticker} href={`/companies/${chip.ticker}`} data-nav><CompanyLogo ticker={chip.ticker} small /><span lang="en">{chip.ticker}</span></a>)}
      </nav>}
      {fresh.length > 0 && <section className="home-fresh" aria-labelledby="home-fresh-title">
        <div className="home-section-head">
          <h2 id="home-fresh-title">{m.freshTitle}</h2>
          <span className="home-fresh-sub">{m.freshSub(FRESH_DAYS)}</span>
        </div>
        <ol className="home-fresh-row">{fresh.map(result => <FreshCard key={result.company.ticker} result={result} name={nameOf(result.company)} />)}</ol>
      </section>}
      {showSignals && <section className="home-watch" id="home-signals" aria-labelledby="home-signals-title" aria-busy={digestStatus === "loading"}>
        <div className="home-section-head">
          <h2 id="home-signals-title">{m.signalsTitle}</h2>
          <div className="home-tabs" role="tablist" aria-label={m.signalsTitle}>
            {(["all", "risk", "strength", "shift"] as const).map(key => <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
              {key === "all" ? m.tabAll : key === "risk" ? m.tabRisks : key === "strength" ? m.tabStrengths : m.tabShifts}
            </button>)}
          </div>
        </div>
        {digestStatus === "loading" ? <ol className="home-watch-list" aria-hidden="true">{Array.from({ length: 4 }, (_, i) => <li key={i} className="home-watch-group home-ghost" />)}</ol>
          : groups.length === 0 ? <p className="home-signals-empty">{m.signalsEmpty}</p>
          : <ol className="home-watch-list">
            {groups.map(group => {
              const name = nameOf(group.company);
              const period = group.company.latestPeriod;
              return <li key={group.company.ticker} className="home-watch-group">
                <header>
                  <a href={`/companies/${group.company.ticker}`} data-nav className="home-watch-company">
                    <CompanyLogo ticker={group.company.ticker} small /><b lang="en">{group.company.ticker}</b><span lang={name.lang}>{name.text}</span>
                  </a>
                  {period && <PeriodMark variant="signal" ticker={group.company.ticker} companyName={group.company.name} periodEnd={group.findings[0]!.periodEnd} periodStart={period.periodEnd === group.findings[0]!.periodEnd ? period.periodStart : null} fiscalYear={period.periodEnd === group.findings[0]!.periodEnd ? period.fiscalYear : undefined} fiscalQuarter={period.periodEnd === group.findings[0]!.periodEnd ? period.fiscalQuarter : undefined} fiscalYearEndMonth={period.fiscalYearEndMonth} labelSource={period.periodEnd === group.findings[0]!.periodEnd ? period.labelSource : undefined} />}
                </header>
                <ul>
                  {group.findings.map(finding => <li key={finding.id} className="home-watch-item" data-kind={finding.kind}>
                    <a href={`/companies/${group.company.ticker}?finding=${encodeURIComponent(finding.id)}`} data-nav>
                      <i className="finding-mark" aria-label={`${KIND_LABEL[finding.kind]} ${finding.severity}`}>{finding.severity}</i>
                      <span lang={langOf(finding.title)}>{normalizeDisplayText(finding.title)}</span>
                    </a>
                  </li>)}
                  {group.extra > 0 && <li className="home-watch-more"><a href={`/companies/${group.company.ticker}`} data-nav>{m.moreFindings(group.extra)}</a></li>}
                </ul>
              </li>;
            })}
          </ol>}
      </section>}
      <section className="home-companies" id="home-companies" aria-labelledby="home-companies-title" aria-busy={digestStatus === "loading"}>
        <div className="home-section-head">
          <h2 id="home-companies-title">{m.companiesTitle}{digestStatus !== "loading" && <b>{locale === "zh-CN" ? `（${count}）` : ` (${count})`}</b>}</h2>
          {digestStatus === "ready" && <select aria-label={m.sortLabel} value={sort} onChange={e => setSort(e.target.value as SortKey)}>
            <option value="latest">{m.sortLatest}</option>
            <option value="yoy">{m.sortYoy}</option>
            <option value="risk">{m.sortRisk}</option>
            <option value="ticker">{m.sortTicker}</option>
          </select>}
        </div>
        {digestStatus === "error" ? <div className="home-error" role="alert"><p>{m.error}</p><button type="button" onClick={onRetry}>{m.retry}</button></div>
          : <table className="home-table">
            <thead><tr><th scope="col">{m.colCompany}</th><th scope="col">{m.colStatement}</th><th scope="col" className="num">{m.colRevenue}</th><th scope="col" className="num">{m.colYoy}</th><th scope="col">{m.colReport}</th><th scope="col">{m.colFindings}</th></tr></thead>
            <tbody>
              {digestStatus === "loading" ? Array.from({ length: 8 }, (_, i) => <tr key={i} className="home-ghost" aria-hidden="true"><td colSpan={6} /></tr>)
                : shown.map(company => {
                  const name = nameOf(company);
                  const missing = company.revenueReason === "NOT_DISCLOSED" ? m.notDisclosed : company.revenueReason === "MISSING_TWO_QUARTERS" ? m.missingYoy : undefined;
                  const counts = company.findingCounts.risk + company.findingCounts.strength + company.findingCounts.shift + company.findingCounts.watch;
                  const period = company.latestPeriod;
                  return <tr key={company.ticker}>
                    <td className="home-co">
                      <a href={`/companies/${company.ticker}`} data-nav className="home-row-link">
                        <CompanyLogo ticker={company.ticker} />
                        <span><b lang="en">{company.ticker}</b><small lang={name.lang}>{name.text}</small></span>
                        {company.status === "preparing" && <em className="home-badge">{m.updating}</em>}
                      </a>
                    </td>
                    <td className="home-pic"><StatementStrip company={company} /></td>
                    <td className="num"><strong title={company.revenue ? undefined : missing}>{company.revenue ? money(company.revenue.value, company.revenue.currency) : "—"}</strong></td>
                    <td className="num"><span className="home-yoy"><MomentumTag momentum={momentumOf(company.revenueTrend.map(p => ({ periodEnd: p.periodEnd, value: Number(p.value) })))} subject={m.colRevenue} size="small" /><Delta pct={company.revenue?.yoyPct ?? null} title={company.revenue?.yoyPct == null ? missing : undefined} /></span></td>
                    <td className="home-period">{period ? <PeriodMark variant="footer" ticker={company.ticker} companyName={name.text} periodEnd={period.periodEnd} periodStart={period.periodStart} fiscalYear={period.fiscalYear} fiscalQuarter={period.fiscalQuarter} fiscalYearEndMonth={period.fiscalYearEndMonth} labelSource={period.labelSource} /> : null}</td>
                    <td className="home-counts">{counts > 0 ? m.counts(company.findingCounts.risk, company.findingCounts.strength) : company.status !== "ready" ? m.findingsPending : m.noFindings}</td>
                  </tr>;
                })}
            </tbody>
          </table>}
      </section>
      <footer className="home-foot">
        <p>{m.disclaimer}</p>
        <PrivacyNote />
      </footer>
    </div>
    {offline && <p className="home-toast" role="status">{m.offline}</p>}
  </main>;
}
