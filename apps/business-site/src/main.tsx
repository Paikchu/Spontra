import { SidebarProvider } from "@/components/ui/sidebar";
import { StrictMode, useCallback, useEffect, useState, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveCompanyBusiness } from "@/lib/earning-report/web/company-business-content";
import type { PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { PublicCapitalStructure } from "@/shared/analysis-contract/capital-structure";
import type { FindingsPublication } from "@/shared/analysis-contract/findings";
import type { EventsPublication } from "@/shared/analysis-contract/events";
import type { PublicFilingDigestPage } from "@/shared/analysis-contract/filings";
import type { FindingFundamentals } from "@/shared/analysis-runtime/findings";
import "@/app/analysis/stocks/[ticker]/business-flow.css";
import "./style.css";
import { withBusinessDescriptions } from "./business-description";
import { BusinessMap } from "./BusinessMap";
import { Rail, RailActions } from "./Sidebar";
import { SearchDialog } from "./SearchDialog";
import { fetchCompany, fetchSupplement, publicationFlow, type CompanyPublication } from "./company-data";
import { Home } from "./Home";

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
  return match ? match[1].toUpperCase() : null;
}
class ChartBoundary extends Component<
  { ticker: string; tools: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <StateShell ticker={this.props.ticker} tools={this.props.tools} role="alert">
        <h2>图表暂时无法显示</h2>
        <p>请重新加载；不会以示例数据替代真实披露。</p>
      </StateShell>
    ) : (
      this.props.children
    );
  }
}
/** Non-chart states keep the floating rail so search and theme stay reachable. */
function StateShell({ ticker, tools, role, children }: { ticker: string; tools: ReactNode; role: "alert" | "status"; children: ReactNode }) {
  return (
    <div className="map">
      <Rail ticker={ticker} actions={tools} label="公司业务" />
      <section className="stage stage--state">
        <div className="state" role={role}>{children}</div>
      </section>
    </div>
  );
}
function Company({ ticker, tools, onSeen }: { ticker: string; tools: ReactNode; onSeen: (ticker: string) => void }) {
  const [flow, setFlow] = useState<PublicBusinessFlow | null>(null),
    [publication, setPublication] = useState<CompanyPublication | null>(null),
    [failed, setFailed] = useState(false),
    [capital, setCapital] = useState<PublicCapitalStructure | null>(null),
    [findings, setFindings] = useState<FindingsPublication | null>(null),
    [events, setEvents] = useState<EventsPublication | null>(null),
    [filings, setFilings] = useState<PublicFilingDigestPage | null>(null),
    [fundamentals, setFundamentals] = useState<FindingFundamentals | null>(null),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetchCompany(ticker, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        onSeen(ticker);
        setPublication(data);
        setFlow(publicationFlow(data, ticker));
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [ticker, retry, onSeen]);
  // Balance sheet, cash flow, findings and the SEC series they resolve against load on their own; the map is drawn without waiting for them.
  useEffect(() => {
    const controller = new AbortController();
    const load = <T,>(resource: "capital" | "findings" | "fundamentals" | "events" | "filings", set: (value: T | null) => void) =>
      fetchSupplement<T>(ticker, resource, controller.signal)
        .then(value => { if (!controller.signal.aborted && value) set(value); })
        .catch(() => { /* Supplementary: the map stands on its own. */ });
    void load<PublicCapitalStructure>("capital", setCapital);
    void load<FindingsPublication>("findings", setFindings);
    void load<FindingFundamentals>("fundamentals", setFundamentals);
    void load<EventsPublication>("events", setEvents);
    void load<PublicFilingDigestPage>("filings", setFilings);
    return () => controller.abort();
  }, [ticker, retry]);
  const business = resolveCompanyBusiness(ticker);
  if (flow)
    return (
      <ChartBoundary ticker={ticker} tools={tools}>
        <BusinessMap
          ticker={ticker}
          tools={tools}
          flow={withBusinessDescriptions(flow, business)}
          business={business}
          revenueHistory={publication?.history ?? null}
          explainer={publication?.explainer ?? null}
          guidance={publication?.guidance ?? null}
          capital={capital}
          findings={findings}
          fundamentals={fundamentals}
          events={events}
          filings={filings}
          notice={
            publication?.outdated
              ? publication.reasons.includes("SIGNED_LAYOUT_UNSUPPORTED")
                ? "新一期含负值，比例图暂不支持；当前显示上次完整快照"
                : "更新尚未完成，当前显示上次完整快照"
              : !flow.quarters.length
                ? "尚无可用季度财务流"
                : null
          }
        />
      </ChartBoundary>
    );
  if (failed)
    return (
      <StateShell ticker={ticker} tools={tools} role="alert">
        <h2>数据暂时无法读取</h2>
        <p>请稍后重试。未披露数据不会视为零。</p>
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setRetry((n) => n + 1);
          }}
        >
          重试
        </button>
      </StateShell>
    );
  if (publication)
    return (
      <StateShell ticker={ticker} tools={tools} role="status">
        <h2>{publication.status === "unavailable" ? "当前披露无法完整绘图" : "完整财务图准备中"}</h2>
        <p>不会以缺失值或半图替代完整披露。</p>
        <p className="state-reasons">{publication.reasons.join(" · ")}</p>
      </StateShell>
    );
  return <Skeleton ticker={ticker} tools={tools} />;
}
function Skeleton({ ticker, tools }: { ticker: string; tools: ReactNode }) {
  return (
    <div className="map map--loading" role="status" aria-label="正在读取公开财报">
      <Rail ticker={ticker} actions={tools}>
        <div className="rail-list">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="row row--ghost" style={{ animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
      </Rail>
      <section className="stage">
        <div className="chart"><div className="ghost-chart" /></div>
      </section>
    </div>
  );
}
function App() {
  const [ticker, setTicker] = useState(tickerFromUrl),
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
    const changed = () => setTicker(tickerFromUrl());
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
      if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing)) {
        e.preventDefault();
        // Home keeps its own field in view; elsewhere the dialog opens.
        const field = document.querySelector<HTMLInputElement>(".home .search-field input");
        if (field) field.focus();
        else setSearching(true);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => {
    document.title = ticker ? `${ticker} · 业务地图` : "Business View";
  }, [ticker]);
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
    setTicker(tickerFromUrl());
  }, []);
  const openCompany = (next: string) => navigate(`/companies/${next}`);
  useEffect(() => {
    const follow = (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-nav]");
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
  const toggleTheme = () => setLight((v) => !v);
  if (!ticker)
    return <Home light={light} onToggleTheme={toggleTheme} recent={recent} onPick={openCompany} />;
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
          <Company key={ticker} ticker={ticker} tools={actions} onSeen={remember} />
        </main>
      </SidebarProvider>
      <SearchDialog open={searching} current={ticker} recent={recent} onClose={() => setSearching(false)} onPick={openCompany} />
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
