import { useEffect, useRef, useState } from "react";
import { getLocale, messages, useLocale } from "@/packages/web/src/i18n";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { compactMoney, normalizeDisplayText } from "@/shared/analysis-runtime/locale";
import type { HomeCompany, HomeDigest } from "../../../shared/analysis-contract/home.ts";
import { CompanyLogo } from "./CompanyMark";
import { SeverityIcon } from "./SeverityIcon";
import type { DigestStatus } from "./home-data";
import { PeriodMark } from "./PeriodMark";
import { PrivacyNote } from "./PrivacyNote";
import { markContent } from "./vitals";
import { SearchPanel } from "./SearchDialog";
import { LanguageToggle, ThemeToggle } from "./Sidebar";
import { worthWatching, type SignalTab, type WorthWatchingCard } from "./worth-watching";
import { FRESH_DAYS, freshResults, type FreshResult } from "./fresh-results";
import { HomeResearch } from "./PublicResearch";

const m = messages({
  brand: "Business View",
  title: "See how a company makes money, and spot the risks early",
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
  disclaimer: "Generated from public SEC filings for research only. Not investment advice.",
  error: "Couldn't load data",
  retry: "Retry",
  offline: "You are offline",
}, {
  brand: "Business View",
  title: "看懂一家公司怎么赚钱，提前发现风险",
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
  disclaimer: "本站内容基于公开 SEC 申报自动生成，仅供研究参考，不构成投资建议。",
  error: "数据暂时加载失败",
  retry: "重试",
  offline: "网络已断开",
});

function money(value: string, currency: string): string {
  const amount = Number(value);
  return Number.isFinite(amount) ? compactMoney(amount, currency, getLocale()) : "—";
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
  const [tab, setTab] = useState<SignalTab>("all");
  const companies = digest?.companies ?? [];
  const catalog = companies.map(company => ({ ticker: company.ticker, name: company.name, nameZh: company.nameZh, aliases: company.aliases }));
  const catalogStatus = digestStatus === "ready" ? "ready" : digestStatus === "error" ? "error" : "loading";
  const chips = recent.length > 0
    ? recent.slice(0, 5).map(ticker => ({ ticker, popular: false }))
    : (digest?.popular ?? []).slice(0, 5).map(ticker => ({ ticker, popular: true }));
  useEffect(() => { if (digestStatus === "ready" && companies.length > 0) markContent("home"); }, [digestStatus, companies.length]);
  const groups = grouped(worthWatching(companies, tab, 8));
  const showSignals = digestStatus === "loading" || worthWatching(companies, "all").length > 0;
  const [now] = useState(() => new Date());
  const fresh = digestStatus === "loading" ? [] : freshResults(companies, now);

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

  return <main className="home" tabIndex={-1}>
    <header className="home-nav" data-stuck={stuck || undefined}>
      <a className="home-brand" href="/" data-nav>
        <span className="home-mark" lang="en">{m.brand.replace(/[^A-Z]/g, "")}</span>
        <span lang="en">{m.brand}</span>
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
      </section>
      {chips.length > 0 && <nav className="home-quick" aria-label={chips[0].popular ? m.popular : m.recent}>
        <span>{chips[0].popular ? m.popular : m.recent}</span>
        {chips.map(chip => <a key={chip.ticker} href={`/companies/${chip.ticker}`} data-nav><CompanyLogo ticker={chip.ticker} small /><span lang="en">{chip.ticker}</span></a>)}
      </nav>}
      <HomeResearch />
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
                      <SeverityIcon severity={finding.severity} />
                      <span lang={langOf(finding.title)}>{normalizeDisplayText(finding.title)}</span>
                    </a>
                  </li>)}
                  {group.extra > 0 && <li className="home-watch-more"><a href={`/companies/${group.company.ticker}`} data-nav>{m.moreFindings(group.extra)}</a></li>}
                </ul>
              </li>;
            })}
          </ol>}
      </section>}
      {digestStatus === "error" && <div className="home-error" role="alert"><p>{m.error}</p><button type="button" onClick={onRetry}>{m.retry}</button></div>}
      <footer className="home-foot">
        <p>{m.disclaimer}</p>
        <PrivacyNote />
      </footer>
    </div>
    {offline && <p className="home-toast" role="status">{m.offline}</p>}
  </main>;
}
