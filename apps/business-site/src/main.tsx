import { StrictMode, useCallback, useEffect, useState, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { selectFlow } from "@/lib/earning-report/web/business-flow-model";
import { resolveCompanyBusiness } from "@/lib/earning-report/web/company-business-content";
import type { CompleteFlowPublication } from "@/shared/analysis-contract/complete-business-flow";
import type { PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { BusinessExplainer } from "@/shared/analysis-contract/business-explainer";
import type { GuidancePublication } from "@/shared/analysis-contract/guidance";
import "@/app/analysis/stocks/[ticker]/business-flow.css";
import "./style.css";
import { withBusinessDescriptions } from "./business-description";
import { BusinessMap } from "./BusinessMap";
import { Rail, RailActions } from "./Sidebar";
import { SearchDialog } from "./SearchDialog";

const RECENT_KEY = "business-map-recent";
function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string" && /^[A-Z][A-Z0-9.-]{0,11}$/.test(t)).slice(0, 6) : [];
  } catch {
    return [];
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
    [publication, setPublication] = useState<(CompleteFlowPublication & { explainer?: BusinessExplainer | null; guidance?: GuidancePublication | null }) | null>(null),
    [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/business/v1/companies/${encodeURIComponent(ticker)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        const data = (await response.json()) as CompleteFlowPublication & { explainer?: BusinessExplainer | null; guidance?: GuidancePublication | null };
        if (!controller.signal.aborted) {
          onSeen(ticker);
          setPublication(data);
          setFlow(data.status === "ready" && data.flow ? selectFlow(data.flow, null, ticker) : null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [ticker, retry, onSeen]);
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
        <header className="stage-head"><div className="stage-title"><span className="eyebrow">正在读取公开财报…</span><h1>收入如何变成利润</h1></div></header>
        <div className="chart"><div className="ghost-chart" /></div>
      </section>
    </div>
  );
}
function App() {
  const [ticker, setTicker] = useState(() => tickerFromUrl() ?? "ORCL"),
    [searching, setSearching] = useState(false),
    [recent, setRecent] = useState(readRecent),
    [collapsed, setCollapsed] = useState(() => {
      try {
        return localStorage.getItem("business-map-rail") === "collapsed";
      } catch {
        return false;
      }
    }),
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
    const changed = () => setTicker(tickerFromUrl() ?? "ORCL");
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
      if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing)) {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => {
    document.title = `${ticker} · 业务地图`;
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
  function navigate(next: string) {
    if (next !== ticker) history.pushState(null, "", `/companies/${next}`);
    setTicker(next);
  }
  const actions = (
    <RailActions
      light={light}
      onToggleTheme={() => setLight((v) => !v)}
      onSearch={() => setSearching(true)}
      collapsed={collapsed}
      onToggleRail={() => setCollapsed((v) => !v)}
    />
  );
  return (
    <>
      <main data-rail={collapsed ? "collapsed" : undefined}>
        <Company key={ticker} ticker={ticker} tools={actions} onSeen={remember} />
      </main>
      <SearchDialog open={searching} current={ticker} recent={recent} onClose={() => setSearching(false)} onPick={navigate} />
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
