import { SidebarProvider } from "@/packages/web/src/ui/sidebar";
import { Component, Fragment, StrictMode, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { messages, useLocale } from "@/packages/web/src/i18n";
import { createRoot } from "react-dom/client";
import { canonicalTicker, TICKER_PATTERN } from "@/shared/analysis-runtime/financial-data/policy";
import "./style.css";
import { CompanySkeleton } from "./CompanySkeleton";
import { RailActions } from "./Sidebar";
import { SearchDialog } from "./SearchDialog";
import { ErrorState } from "./ErrorState";
import { featuredCompanies, isHomePath } from "./error-model";
import { Home } from "./Home";
import { track } from "./track";
import { useHomeDigest } from "./home-data";
import { turnPage } from "./page-turn";
import { createCompanyOpening } from "./company-opening";

const m = messages({
  title: "Business View", description: "Business map · Businesses, revenue, costs and net income from SEC filings",
}, {
  title: "Business View", description: "业务地图 · 从 SEC 文件看公司的业务、营收、成本费用与净利润",
});

const loadCompanyPage = () => import("./CompanyPage");
const Company = lazy(loadCompanyPage);
// Speculative loading must not surface an error before the reader opens the route.
const preloadCompanyPage = () => { void loadCompanyPage().catch(() => {}); };

/** The route chunk can fail before the company's own render boundary has loaded. */
class CompanyRouteBoundary extends Component<{
  ticker: string;
  companies: Array<{ ticker: string; name: string }>;
  onHome: () => void;
  onSearch: () => void;
  children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <ErrorState kind="server" code="LOAD" ticker={this.props.ticker} companies={this.props.companies} onHome={this.props.onHome} onSearch={this.props.onSearch} onRetry={() => location.reload()} restoredTitle={`${this.props.ticker} · ${m.title}`} />
      : this.props.children;
  }
}

const RECENT_KEY = "business-map-recent";
function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string" && TICKER_PATTERN.test(t)).slice(0, 6) : [];
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
  if (next) preloadCompanyPage();
  if ((document.querySelector("main.home") !== null) === (next === null)) set(next);
  else turnPage(() => set(next));
}
function App() {
  const locale = useLocale();
  const home = useHomeDigest(locale);
  const [ticker, setTicker] = useState(() => {
      const initialTicker = tickerFromUrl();
      if (initialTicker) preloadCompanyPage();
      return initialTicker;
    }),
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
  // The route owns the read even while its lazy component is still downloading.
  const opening = useMemo(() => ticker ? createCompanyOpening(ticker, locale) : null, [ticker, locale]);
  useEffect(() => {
    const request = opening?.start();
    return () => request?.abort();
  }, [opening]);
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
    const warm = (e: Event) => {
      const link = (e.target instanceof Element ? e.target : null)?.closest<HTMLAnchorElement>("a[data-nav]");
      if (link?.getAttribute("href")?.startsWith("/companies/")) preloadCompanyPage();
    };
    const follow = (e: MouseEvent) => {
      const link = (e.target instanceof Element ? e.target : e.target instanceof Node ? e.target.parentElement : null)?.closest<HTMLAnchorElement>("a[data-nav]");
      if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(link.getAttribute("href")!);
    };
    document.addEventListener("pointerover", warm);
    document.addEventListener("focusin", warm);
    document.addEventListener("click", follow);
    return () => {
      document.removeEventListener("pointerover", warm);
      document.removeEventListener("focusin", warm);
      document.removeEventListener("click", follow);
    };
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
  const picks = featuredCompanies(home.digest?.companies ?? [], home.digest?.popular ?? [], locale);
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
          <CompanyRouteBoundary key={ticker} ticker={ticker} companies={picks} onHome={goHome} onSearch={searchFromError}>
            <Suspense fallback={<CompanySkeleton ticker={ticker} tools={actions} />}>
              <Company key={ticker} ticker={ticker} opening={opening!} tools={actions} onSeen={remember} catalog={home.digest?.companies.find(company => company.ticker === ticker) ?? null} covered={home.status === "ready" ? covered.has(ticker) : null} companies={picks} onHome={goHome} onSearch={searchFromError} />
            </Suspense>
          </CompanyRouteBoundary>
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
