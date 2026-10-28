import { SidebarProvider } from "@/packages/web/src/ui/sidebar";
import { Fragment, StrictMode, useCallback, useEffect, useRef, useState, Component, type ReactNode } from "react";
import { getLocale, messages, useLocale } from "@/packages/web/src/i18n";
import { createRoot } from "react-dom/client";
import { canonicalTicker } from "@/shared/analysis-runtime/financial-data/policy";
import "@/packages/web/src/business-flow/business-flow.css";
import "./style.css";
import { BusinessMap } from "./BusinessMap";
import { Rail, RailActions } from "./Sidebar";
import { SearchDialog } from "./SearchDialog";
import { ErrorState } from "./ErrorState";
import { companyFault, featuredCompanies, isHomePath } from "./error-model";
import { openingFace, useLiveCompany } from "./live-company";
import { qoqLabel, yoyLabel } from "@/shared/analysis-runtime/locale";
import { VIEW_LABEL } from "./findings-model";
import { UpdateNotice } from "./UpdateNotice";
import { Home } from "./Home";
import { track } from "./track";
import { useHomeDigest } from "./home-data";
import { useStageHost } from "./stage/StageHost";
import { turnPage, usePageTurning } from "./page-turn";

const m = messages({
  companyBusinesses: "Company businesses", lastSnapshot: "Last complete snapshot", loading: "Loading",
  allBusinesses: "All businesses", findings: "Findings", events: "Filings and events",
  summary: "Summary", detail: "Detail", revenue: "Revenue", businessRevenue: "Business revenue", profit: "Profit", costs: "Costs and expenses",
  title: "Business View", description: "Business map · Businesses, revenue, costs and net income from SEC filings",
}, {
  companyBusinesses: "公司业务", lastSnapshot: "最近一次完整快照", loading: "加载中",
  allBusinesses: "全部业务", findings: "要点", events: "文件与事件",
  summary: "概要", detail: "明细", revenue: "营收", businessRevenue: "业务营收", profit: "利润", costs: "成本与费用",
  title: "Business View", description: "业务地图 · 从 SEC 文件看公司的业务、营收、成本费用与净利润",
});

const RECENT_KEY = "business-map-recent";
function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string" && /^[A-Z][A-Z0-9.-]{0,11}$/.test(t)).slice(0, 6) : [];
  } catch {
    return [];
  }
}

/** Between the stacked layout and a comfortable two-pane width, the rail yields first so the chart keeps its room. */
const RAIL_YIELDS = "(min-width: 961px) and (max-width: 1279px)";
function railYields() {
  try {
    return matchMedia(RAIL_YIELDS).matches;
  } catch {
    return false;
  }
}

function tickerFromUrl() {
  const match = location.pathname.match(
    /^\/companies\/([A-Za-z0-9.-]{1,12})\/?$/,
  );
  if (!match) return null;
  const ticker = canonicalTicker(match[1]);
  // The address shows the class the data is kept under.
  if (ticker !== match[1]) history.replaceState(history.state, "", `/companies/${ticker}${location.search}${location.hash}`);
  return ticker;
}
/** Only crossing between home and a company turns the page; one company to another swaps in place. */
function showTicker(next: string | null, set: (ticker: string | null) => void) {
  if ((document.querySelector("main.home") !== null) === (next === null)) set(next);
  else turnPage(() => set(next));
}
class ChartBoundary extends Component<
  { ticker: string; companies: Array<{ ticker: string; name: string }>; onHome: () => void; onSearch: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <ErrorState kind="server" code="RENDER" ticker={this.props.ticker} companies={this.props.companies} onHome={this.props.onHome} onSearch={this.props.onSearch} onRetry={() => this.setState({ failed: false })} restoredTitle={`${this.props.ticker} · ${m.title}`} />
    ) : (
      this.props.children
    );
  }
}
function Company({ ticker, tools, onSeen, covered, companies, onHome, onSearch }: {
  ticker: string;
  tools: ReactNode;
  onSeen: (ticker: string) => void;
  covered: boolean | null;
  companies: Array<{ ticker: string; name: string }>;
  onHome: () => void;
  onSearch: () => void;
}) {
  const { data, updates, failed, httpStatus, ready, eventsPhase, retry, retryEvents, update, apply, dismiss } = useLiveCompany(ticker, onSeen);
  const { flow, publication, capital, peers, findings, fundamentals, events, filings, valuation } = data;
  const stage = useStageHost(ticker, data);
  // The page keeps the face it turned in with until the turn lands, since replacing its rail mid-flight cuts the turn short.
  const face = openingFace({ ready, failed, flow: Boolean(flow), publication: Boolean(publication) });
  const [arrival] = useState(face);
  const shown = usePageTurning() ? arrival : face;
  const fault = shown === "failed" || shown === "state" ? companyFault({
    httpStatus: shown === "failed" ? httpStatus : null,
    reasons: publication?.reasons ?? [],
    covered,
    attempted: Boolean(publication?.lastAttemptAt),
  }) : null;
  if (fault)
    return <ErrorState kind={fault.kind} code={fault.code} ticker={ticker} companies={companies} onHome={onHome} onRetry={retry} onSearch={onSearch} restoredTitle={`${ticker} · ${m.title}`} />;
  if (shown === "map" && flow)
    return (
      <ChartBoundary ticker={ticker} companies={companies} onHome={onHome} onSearch={onSearch}>
        <BusinessMap
          ticker={ticker}
          tools={tools}
          flow={flow}
          revenueHistory={publication?.history ?? null}
          explainer={publication?.explainer ?? null}
          tree={publication?.tree ?? null}
          guidance={publication?.guidance ?? null}
          capital={capital}
          findings={findings?.findings ?? null} peers={findings?.peers ?? null} rankPeers={peers} passages={findings?.passages ?? null}
          fundamentals={fundamentals}
          events={events}
          filings={filings}
          valuation={valuation}
          eventsPhase={eventsPhase}
          onRetryEvents={retryEvents}
          notice={publication?.outdated ? m.lastSnapshot : null}
          updates={updates}
          stageOverride={stage.stageOverride}
          onNavigate={stage.onNavigate}
          onView={stage.onView}
          railFoot={stage.railFoot}
          focusRequest={stage.focusRequest}
        />
        <UpdateNotice update={update} onApply={apply} onDismiss={dismiss} />
        {stage.layer}
      </ChartBoundary>
    );
  return <Skeleton ticker={ticker} tools={tools} />;
}
/** Same boxes as the loaded map: closed rail digest, head, chart, timeline, trend and footer. Text is a shimmer in the real line metrics. */
function Skeleton({ ticker, tools }: { ticker: string; tools: ReactNode }) {
  return (
    <div className="map map--loading" role="status" aria-label={m.loading} aria-busy="true">
      <Rail ticker={ticker} actions={tools} label={m.companyBusinesses}>
        <section className="findings" data-section="business" aria-hidden="true">
          <div className="rail-list section-body">
            <div className="row row--all"><i className="row-chip row-chip--all" aria-hidden="true" /><span className="row-name ghost-text">{m.allBusinesses}</span></div>
            {[0, 1, 2].map(i => <div key={i} className="row" data-depth="0" data-extra=""><i className="row-chip" aria-hidden="true" /><span className="row-name ghost-text">{m.allBusinesses}</span></div>)}
          </div>
        </section>
        <section className="findings" data-section="findings" aria-hidden="true">
          <header className="findings-head"><span className="findings-title ghost-text">{m.findings}</span></header>
          <div className="findings-rows section-body">
            {[0, 1, 2].map(i => <div key={i} className="finding-row"><i className="finding-mark" aria-hidden="true" /><span className="finding-title ghost-text">{m.findings}</span></div>)}
          </div>
        </section>
        <section className="findings" data-section="events" aria-hidden="true">
          <header className="findings-head"><span className="findings-title ghost-text">{m.events}</span></header>
          <div className="event-filters">{[0, 1, 2, 3, 4].map(i => <span key={i} className="event-filter event-filter--ghost" />)}</div>
          <div className="findings-rows section-body">
            {[0, 1, 2, 3, 4].map(i => <div key={i} className="finding-row event-row"><time className="event-date ghost-text">00.00</time><span className="finding-title ghost-text">{m.events}</span></div>)}
          </div>
        </section>
      </Rail>
      <section className="stage" data-timeline="" data-view="profit" data-trend="" aria-hidden="true">
        <header className="stage-head stage-head--summary">
          <div className="stage-kicker"><span className="period-skeleton" /></div>
          <div className="stats">
            {[0, 1, 2].map(i => <div key={i} className="stat"><span className="stat-label ghost-text">{m.revenue}</span><strong className="stat-value ghost-text">$00.0B</strong><span className="stat-note ghost-text">+0.0%</span></div>)}
          </div>
          <div className="stage-controls">
            <span className="trend-views stage-views"><button type="button" tabIndex={-1} aria-checked="true">{yoyLabel(getLocale())}</button><button type="button" tabIndex={-1} aria-checked="false">{qoqLabel(getLocale())}</button></span>
            <span className="trend-views stage-views"><button type="button" tabIndex={-1} aria-checked="true">{m.summary}</button><button type="button" tabIndex={-1} aria-checked="false">{m.detail}</button></span>
            <span className="trend-views stage-views"><button type="button" tabIndex={-1} aria-checked="true">{VIEW_LABEL.profit}</button><button type="button" tabIndex={-1} aria-checked="false">{VIEW_LABEL.cash}</button><button type="button" tabIndex={-1} aria-checked="false">{VIEW_LABEL.balance}</button></span>
          </div>
        </header>
        <div className="chart"><div className="ghost-chart" /></div>
        <div className="timeline"><div className="timeline-track" /></div>
        <div className="trend" data-view="trend">
          <div className="trend-head"><div className="trend-title"><h2 className="ghost-text">{m.revenue}</h2><div className="trend-legend"><span className="ghost-text">{m.businessRevenue}</span><span className="ghost-text">{m.profit}</span></div></div></div>
          <div className="trend-plot" />
        </div>
        <footer className="stage-foot">
          <div className="legend"><span className="ghost-text">{m.businessRevenue}</span><span className="ghost-text">{m.profit}</span><span className="ghost-text">{m.costs}</span></div>
          <p className="provenance"><span className="ghost-text">{m.loading}</span></p>
        </footer>
      </section>
    </div>
  );
}
function App() {
  const locale = useLocale();
  const home = useHomeDigest(locale);
  const [ticker, setTicker] = useState(tickerFromUrl),
    [path, setPath] = useState(() => location.pathname),
    [searching, setSearching] = useState(false),
    [recent, setRecent] = useState(readRecent),
    [collapsed, setCollapsed] = useState(() => {
      try {
        return localStorage.getItem("business-map-rail") === "collapsed";
      } catch {
        return false;
      }
    }),
    [yields, setYields] = useState(railYields),
    [openedWhileNarrow, setOpenedWhileNarrow] = useState(false),
    [light, setLight] = useState(() => {
      try {
        return localStorage.getItem("business-map-theme") === "light";
      } catch {
        return false;
      }
    });
  useEffect(() => {
    document.documentElement.classList.toggle("light", light);
    document.documentElement.classList.toggle("dark", !light);
    try {
      localStorage.setItem("business-map-theme", light ? "light" : "dark");
    } catch {
      /* Storage may be disabled. */
    }
  }, [light]);
  useEffect(() => {
    try {
      localStorage.setItem("business-map-rail", collapsed ? "collapsed" : "open");
    } catch {
      /* Storage may be disabled. */
    }
  }, [collapsed]);
  useEffect(() => {
    const query = matchMedia(RAIL_YIELDS);
    const changed = () => {
      setYields(query.matches);
      setOpenedWhileNarrow(false);
    };
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    // A browser that already animated the swipe back or forward gets no second animation.
    const changed = (e: PopStateEvent) => {
      setPath(location.pathname);
      if ((e as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition) setTicker(tickerFromUrl());
      else showTicker(tickerFromUrl(), setTicker);
    };
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      const typing = (e.target instanceof Element ? e.target : e.target instanceof Node ? e.target.parentElement : null)?.closest("input, textarea, select, [contenteditable]");
      if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing)) {
        e.preventDefault();
        // Home keeps its own field in view; elsewhere the dialog opens.
        const field = document.querySelector<HTMLInputElement>(".home .search-field input");
        const box = field?.getBoundingClientRect();
        if (field && box && box.bottom > 64 && box.top < window.innerHeight) field.focus();
        else setSearching(true);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const focusSearch = useRef(false);
  useEffect(() => {
    if (document.documentElement.dataset.pageTitle === "error") return;
    document.title = ticker ? `${ticker} · ${m.title}` : m.title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", m.description);
  }, [ticker, locale, path]);
  useEffect(() => {
    if (!focusSearch.current || ticker || !isHomePath(path)) return;
    focusSearch.current = false;
    document.querySelector<HTMLInputElement>(".home .search-field input")?.focus();
  }, [ticker, path]);
  /** Only companies the API answered for are remembered, so typos never become suggestions. */
  const remember = useCallback((seen: string) => {
    setRecent((list) => {
      const next = [seen, ...list.filter((t) => t !== seen)].slice(0, 6);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* Storage may be disabled. */
      }
      return next;
    });
  }, []);
  /** In-app links: a company, optionally opened at a finding, or home. */
  const navigate = useCallback((href: string) => {
    if (href !== location.pathname + location.search) history.pushState(null, "", href);
    setPath(location.pathname);
    showTicker(tickerFromUrl(), setTicker);
  }, []);
  const openCompany = (next: string) => navigate(`/companies/${canonicalTicker(next)}`);
  const goHome = useCallback(() => navigate("/"), [navigate]);
  const searchFromError = useCallback(() => { focusSearch.current = true; navigate("/"); }, [navigate]);
  useEffect(() => { track("page_view", ticker ? { ticker } : {}); }, [path, ticker]);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const link = (e.target instanceof Element ? e.target : e.target instanceof Node ? e.target.parentElement : null)?.closest("a");
      if (link?.closest(".sources, .cites, figcaption")) track("source_click");
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  useEffect(() => {
    const follow = (e: MouseEvent) => {
      const link = (e.target instanceof Element ? e.target : e.target instanceof Node ? e.target.parentElement : null)?.closest<HTMLAnchorElement>("a[data-nav]");
      if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(link.getAttribute("href")!);
    };
    document.addEventListener("click", follow);
    return () => document.removeEventListener("click", follow);
  }, [navigate]);
  // A narrow window collapses the rail without overwriting the preference saved for wide windows.
  const railCollapsed = yields ? !openedWhileNarrow : collapsed;
  function setRailOpen(open: boolean) {
    if (yields) setOpenedWhileNarrow(open);
    else setCollapsed(!open);
  }
  const toggleTheme = () => { track("theme_toggle", { theme: light ? "dark" : "light" }); setLight((v) => !v); };
  const covered = new Set((home.digest?.companies ?? []).map(company => company.ticker));
  const shownRecent = home.status === "ready" ? recent.filter(item => covered.has(item)) : recent;
  const catalog = (home.digest?.companies ?? []).map(company => ({ ticker: company.ticker, name: company.name, nameZh: company.nameZh, aliases: company.aliases }));
  const catalogStatus = home.status === "ready" ? "ready" as const : home.status === "error" ? "error" as const : "loading" as const;
  const picks = featuredCompanies(home.digest?.companies ?? [], locale);
  // Home remounts so its memos pick up the new locale. The company page stays mounted and refetches in place.
  if (!ticker && !isHomePath(path))
    return <ErrorState kind="missing" code="NOT_FOUND" companies={picks} onHome={goHome} onSearch={searchFromError} restoredTitle={m.title} />;
  if (!ticker)
    return <Fragment key={locale}>
      <Home light={light} onToggleTheme={toggleTheme} recent={shownRecent} onPick={openCompany} digest={home.digest} digestStatus={home.status} onRetry={home.retry} onSearch={() => setSearching(true)} />
      <SearchDialog open={searching} current={null} recent={shownRecent} onClose={() => setSearching(false)} onPick={openCompany} catalog={catalog} popular={home.digest?.popular ?? []} catalogStatus={catalogStatus} />
    </Fragment>;
  const actions = (
    <RailActions
      light={light}
      onToggleTheme={toggleTheme}
      onSearch={() => setSearching(true)}
      collapsed={railCollapsed}
    />
  );
  return (
    <>
      <SidebarProvider asChild open={!railCollapsed} onOpenChange={setRailOpen} keyboardShortcut={null} persistState={false}>
        <main data-rail={railCollapsed ? "collapsed" : undefined}>
          <Company key={ticker} ticker={ticker} tools={actions} onSeen={remember} covered={home.status === "ready" ? covered.has(ticker) : null} companies={picks} onHome={goHome} onSearch={searchFromError} />
        </main>
      </SidebarProvider>
      <SearchDialog open={searching} current={ticker} recent={shownRecent} onClose={() => setSearching(false)} onPick={openCompany} catalog={catalog} popular={home.digest?.popular ?? []} catalogStatus={catalogStatus} />
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
