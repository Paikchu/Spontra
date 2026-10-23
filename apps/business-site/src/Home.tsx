import { useEffect, useRef, useState } from "react";
import { getLocale, messages, useLocale } from "@/packages/web/src/i18n";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { compactMoney } from "@/shared/analysis-runtime/locale";
import type { HomeCompany, HomeDigest } from "../../../shared/analysis-contract/home.ts";
import { CompanyLogo } from "./CompanyMark";
import { KIND_LABEL } from "./findings-model";
import type { DigestStatus } from "./home-data";
import { SearchPanel } from "./SearchDialog";
import { LanguageToggle, ThemeToggle } from "./Sidebar";

const m = messages({
  eyebrowLead: "From SEC filings ·",
  eyebrowTail: "US companies covered",
  title: "See how a company makes money, and spot the risks early",
  subtitle: "Every filing turned into a business map: where revenue comes from, where money goes, and what changed this quarter.",
  trust: (time: string) => `Source: SEC EDGAR · Updated after each filing · Last update ${time}`,
  trustStatic: "Source: SEC EDGAR · Updated after each filing",
  navFindings: "Findings",
  navCompanies: "Companies",
  navHow: "How it works",
  search: "Search companies",
  recent: "Recently viewed",
  popular: "Popular",
  signalsTitle: "Worth watching",
  signalsSub: "Key changes and risks from the latest filings",
  tabAll: "All",
  tabRisks: "Risks",
  tabStrengths: "Strengths",
  tabShifts: "Shifts",
  seeEvidence: "See evidence",
  companiesTitle: "Companies covered",
  sortLabel: "Sort",
  sortLatest: "Latest report",
  sortYoy: "Revenue YoY",
  sortRisk: "Risk count",
  sortTicker: "Ticker order",
  latestRevenue: "Latest quarterly revenue",
  yoy: "YoY",
  counts: (r: number, s: number) => `${r} risks · ${s} strengths`,
  findingsPending: "Findings still generating",
  open: "Open",
  updating: "Updating",
  how1: "Find a company",
  how1d: "Type a ticker or name and pick a covered company.",
  how2: "Read the business map",
  how2d: "Revenue, costs and profit in one picture.",
  how3: "Check the findings",
  how3d: "Risks, strengths and shifts, each traced to the SEC text.",
  disclaimer: "Generated from public SEC filings for research only. Not investment advice.",
  notDisclosed: "Not disclosed this quarter",
  missingYoy: "Fewer than two quarters, so the year-over-year rate is unavailable",
  error: "Couldn't load data",
  retry: "Retry",
  offline: "You are offline",
  justNow: "Just now",
  minutesAgo: (n: number) => `${n} minutes ago`,
  hoursAgo: (n: number) => `${n} hours ago`,
  daysAgo: (n: number) => `${n} days ago`,
}, {
  eyebrowLead: "基于 SEC 原始财报 · 已覆盖",
  eyebrowTail: "家美股公司",
  title: "看懂一家公司怎么赚钱，提前发现风险",
  subtitle: "把财报变成一张业务地图：收入从哪来、钱花在哪、最新一季变了什么。",
  trust: (time: string) => `数据来源 SEC EDGAR · 财报发布后自动更新 · 最近更新 ${time}`,
  trustStatic: "数据来源 SEC EDGAR · 财报发布后自动更新",
  navFindings: "要点",
  navCompanies: "公司",
  navHow: "怎么用",
  search: "搜索公司",
  recent: "最近查看",
  popular: "热门",
  signalsTitle: "值得关注",
  signalsSub: "最新财报中的重要变化与风险",
  tabAll: "全部",
  tabRisks: "风险",
  tabStrengths: "优势",
  tabShifts: "变化",
  seeEvidence: "查看依据",
  companiesTitle: "已覆盖公司",
  sortLabel: "排序",
  sortLatest: "最近财报",
  sortYoy: "营收同比",
  sortRisk: "风险数量",
  sortTicker: "代码字母序",
  latestRevenue: "最新季度营收",
  yoy: "同比",
  counts: (r: number, s: number) => `风险 ${r} · 优势 ${s}`,
  findingsPending: "要点生成中",
  open: "打开",
  updating: "更新中",
  how1: "搜索公司",
  how1d: "输入代码或名称，从已覆盖的公司中选择。",
  how2: "看业务地图",
  how2d: "收入、成本和利润，一张图看清。",
  how3: "看要点",
  how3d: "风险、优势与变化，每条都能追溯到 SEC 原文。",
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
type SignalTab = "all" | "risk" | "strength" | "shift";

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

function signalsOf(companies: HomeCompany[], tab: SignalTab) {
  const items = companies.flatMap(company => company.topFindings.map(finding => ({ company, finding })));
  return items
    .filter(item => tab === "all" || item.finding.kind === tab)
    .sort((a, b) => b.finding.periodEnd.localeCompare(a.finding.periodEnd) || b.finding.severity - a.finding.severity || a.company.ticker.localeCompare(b.company.ticker))
    .slice(0, 6);
}

function Delta({ pct, title }: { pct: number | null; title?: string }) {
  if (pct == null) return <span className="home-delta" title={title}>—</span>;
  const dir = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "";
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return <span className="home-delta" data-dir={dir}>{arrow}{sign}{Math.abs(pct).toFixed(1)}%</span>;
}

function Bars({ trend }: { trend: Array<{ value: string }> }) {
  const values = trend.map(point => Number(point.value)).filter(value => Number.isFinite(value) && value >= 0);
  const max = Math.max(1, ...values);
  return <span className="home-bars" aria-hidden="true">{values.map((value, index) =>
    <i key={index} style={{ ["--h" as string]: `${Math.max(8, (value / max) * 100)}%`, animationDelay: `${index * 20}ms` }} />)}</span>;
}

function scrollToSection(id: string) {
  const target = document.getElementById(id);
  const home = document.querySelector<HTMLElement>("main.home");
  if (!target || !home) return;
  const behavior: ScrollBehavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  if (home.scrollHeight > home.clientHeight + 1) {
    const top = target.getBoundingClientRect().top - home.getBoundingClientRect().top + home.scrollTop - 64;
    home.scrollTo({ top, behavior });
  } else target.scrollIntoView({ behavior, block: "start" });
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
  const signals = signalsOf(companies, tab);
  const showSignals = digestStatus === "loading" || signalsOf(companies, "all").length > 0;
  const updated = digest ? relativeTime(digest.coverage.lastUpdatedAt) : null;

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
      <nav className="home-anchors" aria-label={m.navHow}>
        {showSignals && <button type="button" onClick={() => scrollToSection("home-signals")}>{m.navFindings}</button>}
        <button type="button" onClick={() => scrollToSection("home-companies")}>{m.navCompanies}</button>
        <button type="button" onClick={() => scrollToSection("home-how")}>{m.navHow}</button>
      </nav>
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
        <p className="home-eyebrow">
          <span>{m.eyebrowLead}</span>
          {digestStatus === "loading" ? <i className="home-count" /> : <b>{digest?.coverage.count ?? 0}</b>}
          <span>{m.eyebrowTail}</span>
        </p>
        <h1 id="home-title">{m.title}</h1>
        <p className="home-sub">{m.subtitle}</p>
        <SearchPanel inline current={null} recent={recent} onPick={onPick} inputRef={inputRef} catalog={catalog} popular={digest?.popular ?? []} catalogStatus={catalogStatus} />
        <p className="home-trust">{updated ? m.trust(updated) : m.trustStatic}</p>
      </section>
      {chips.length > 0 && <nav className="home-quick" aria-label={chips[0].popular ? m.popular : m.recent}>
        <span>{chips[0].popular ? m.popular : m.recent}</span>
        {chips.map(chip => <a key={chip.ticker} href={`/companies/${chip.ticker}`} data-nav><CompanyLogo ticker={chip.ticker} small /><span lang="en">{chip.ticker}</span></a>)}
      </nav>}
      {showSignals && <section className="home-signals" id="home-signals" aria-labelledby="home-signals-title" aria-busy={digestStatus === "loading"}>
        <div className="home-section-head">
          <div>
            <h2 id="home-signals-title">{m.signalsTitle}</h2>
            <p>{m.signalsSub}</p>
          </div>
          <div className="home-tabs" role="tablist" aria-label={m.signalsTitle}>
            {(["all", "risk", "strength", "shift"] as const).map(key => <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
              {key === "all" ? m.tabAll : key === "risk" ? m.tabRisks : key === "strength" ? m.tabStrengths : m.tabShifts}
            </button>)}
          </div>
        </div>
        <div className="home-signals-grid">
          {digestStatus === "loading" ? Array.from({ length: 6 }, (_, i) => <div key={i} className="home-signal home-ghost" />)
            : signals.map(item => <a key={`${item.company.ticker}-${item.finding.id}`} className="home-signal" data-kind={item.finding.kind} data-nav
              href={`/companies/${item.company.ticker}?finding=${encodeURIComponent(item.finding.id)}`}>
              <header>
                <CompanyLogo ticker={item.company.ticker} small />
                <b lang="en">{item.company.ticker}</b>
                <span>{item.company.latestPeriod?.periodEnd === item.finding.periodEnd ? item.company.latestPeriod.fiscalLabel : item.finding.periodEnd}</span>
              </header>
              <p className="home-kind"><i data-kind={item.finding.kind} />{KIND_LABEL[item.finding.kind]}
                <span className="home-severity" aria-hidden="true">{[1, 2, 3].map(n => <i key={n} data-on={n <= item.finding.severity || undefined} />)}</span>
              </p>
              <p className="home-signal-title" lang={langOf(item.finding.title)}>{item.finding.title}</p>
              <span className="home-more">{m.seeEvidence}</span>
            </a>)}
        </div>
      </section>}
      <section className="home-companies" id="home-companies" aria-labelledby="home-companies-title" aria-busy={digestStatus === "loading"}>
        <div className="home-section-head">
          <h2 id="home-companies-title">{m.companiesTitle}{digestStatus === "loading" ? <i className="home-count" /> : <b>{locale === "zh-CN" ? `（${digest?.coverage.count ?? 0}）` : ` (${digest?.coverage.count ?? 0})`}</b>}</h2>
          {digestStatus === "ready" && <select aria-label={m.sortLabel} value={sort} onChange={e => setSort(e.target.value as SortKey)}>
            <option value="latest">{m.sortLatest}</option>
            <option value="yoy">{m.sortYoy}</option>
            <option value="risk">{m.sortRisk}</option>
            <option value="ticker">{m.sortTicker}</option>
          </select>}
        </div>
        {digestStatus === "error" ? <div className="home-error" role="alert"><p>{m.error}</p><button type="button" onClick={onRetry}>{m.retry}</button></div>
          : <div className="home-grid">
            {digestStatus === "loading" ? Array.from({ length: 8 }, (_, i) => <div key={i} className="home-card home-ghost" />)
              : shown.map(company => {
                const name = nameOf(company);
                const missing = company.revenueReason === "NOT_DISCLOSED" ? m.notDisclosed : company.revenueReason === "MISSING_TWO_QUARTERS" ? m.missingYoy : undefined;
                const counts = company.findingCounts.risk + company.findingCounts.strength + company.findingCounts.shift + company.findingCounts.watch;
                return <a key={company.ticker} className="home-card" href={`/companies/${company.ticker}`} data-nav>
                  <header>
                    <CompanyLogo ticker={company.ticker} />
                    <span><b lang="en">{company.ticker}</b><small lang={name.lang}>{name.text}</small></span>
                    {company.status === "preparing" && <em className="home-badge">{m.updating}</em>}
                    <span className="home-open">{m.open}</span>
                  </header>
                  <p className="home-metric"><span>{m.latestRevenue}</span>
                    <strong title={company.revenue ? undefined : missing}>{company.revenue ? money(company.revenue.value, company.revenue.currency) : "—"}</strong>
                  </p>
                  <p className="home-metric-row"><span>{m.yoy}</span><Delta pct={company.revenue?.yoyPct ?? null} title={company.revenue?.yoyPct == null ? missing : undefined} /><Bars trend={company.revenueTrend} /></p>
                  <footer>
                    <span>{counts > 0 ? m.counts(company.findingCounts.risk, company.findingCounts.strength) : company.status !== "ready" ? m.findingsPending : "—"}</span>
                    <span>{company.latestPeriod?.fiscalLabel ?? "—"}</span>
                  </footer>
                </a>;
              })}
          </div>}
      </section>
      <section className="home-how" id="home-how" aria-labelledby="home-how-title">
        <h2 id="home-how-title" className="home-sr">{m.navHow}</h2>
        <ol>
          <li><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg><h3>{m.how1}</h3><p>{m.how1d}</p></li>
          <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16V8m6 8V5m6 11v-6m4 6V9" /></svg><h3>{m.how2}</h3><p>{m.how2d}</p></li>
          <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v6c0 4.5 3 6.5 7 8 4-1.5 7-3.5 7-8V6Z" /></svg><h3>{m.how3}</h3><p>{m.how3d}</p></li>
        </ol>
      </section>
      <footer className="home-foot">
        <p>{m.disclaimer}</p>
        <p>{m.trustStatic}</p>
      </footer>
    </div>
    {offline && <p className="home-toast" role="status">{m.offline}</p>}
  </main>;
}
