import { StrictMode, useEffect, useState, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { selectFlow } from "@/lib/earning-report/web/business-flow-model";
import { resolveCompanyBusiness } from "@/lib/earning-report/web/company-business-content";
import type { CompleteFlowPublication } from "@/shared/analysis-contract/complete-business-flow";
import type { PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import "@/app/analysis/stocks/[ticker]/business-flow.css";
import "./style.css";
import { withBusinessDescriptions } from "./business-description";
import { BusinessMap } from "./BusinessMap";

function tickerFromUrl() {
  const match = location.pathname.match(
    /^\/companies\/([A-Za-z0-9.-]{1,12})\/?$/,
  );
  return match ? match[1].toUpperCase() : null;
}
class ChartBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="state" role="alert">
        <h2>图表暂时无法显示</h2>
        <p>请重新加载；不会以示例数据替代真实披露。</p>
      </div>
    ) : (
      this.props.children
    );
  }
}
function Company({ ticker }: { ticker: string }) {
  const [flow, setFlow] = useState<PublicBusinessFlow | null>(null),
    [publication, setPublication] = useState<CompleteFlowPublication | null>(null),
    [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/business/v1/companies/${encodeURIComponent(ticker)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        const data = (await response.json()) as CompleteFlowPublication;
        if (!controller.signal.aborted) {
          setPublication(data);
          setFlow(data.status === "ready" && data.flow ? selectFlow(data.flow, null, ticker) : null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [ticker, retry]);
  const business = resolveCompanyBusiness(ticker);
  if (flow)
    return (
      <ChartBoundary>
        <BusinessMap
          ticker={ticker}
          flow={withBusinessDescriptions(flow, business)}
          business={business}
          revenueHistory={publication?.history ?? null}
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
      <div className="state" role="alert">
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
      </div>
    );
  if (publication)
    return (
      <div className="state" role="status">
        <h2>{publication.status === "unavailable" ? "当前披露无法完整绘图" : "完整财务图准备中"}</h2>
        <p>不会以缺失值或半图替代完整披露。</p>
        <p className="state-reasons">{publication.reasons.join(" · ")}</p>
      </div>
    );
  return <Skeleton />;
}
function Skeleton() {
  return (
    <div className="map map--loading" role="status" aria-label="正在读取公开财报">
      <aside className="rail">
        <div className="rail-head"><h2>业务</h2></div>
        <div className="rail-list">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="row row--ghost" style={{ animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
      </aside>
      <section className="stage">
        <header className="stage-head"><div className="stage-title"><span className="eyebrow">正在读取公开财报…</span><h1>收入如何变成利润</h1></div></header>
        <div className="chart"><div className="ghost-chart" /></div>
      </section>
    </div>
  );
}
function App() {
  const [ticker, setTicker] = useState(() => tickerFromUrl() ?? "ORCL"),
    [input, setInput] = useState(""),
    [invalid, setInvalid] = useState(false),
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
    const changed = () => {
      setTicker(tickerFromUrl() ?? "ORCL");
      setInput("");
      setInvalid(false);
    };
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  useEffect(() => {
    document.title = `${ticker} · 业务地图`;
  }, [ticker]);
  function navigate(next: string) {
    if (next !== ticker) history.pushState(null, "", `/companies/${next}`);
    setTicker(next);
    setInput("");
    setInvalid(false);
  }
  return (
    <>
      <header className="site-header">
        <a className="brand" href={`/companies/${ticker}`} aria-label={`${ticker} 业务地图`}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 5h3c5 0 5 7 10 7h5" />
            <path d="M3 12h3c5 0 5 7 10 7h5" opacity=".55" />
            <path d="M3 19h3" opacity=".3" />
          </svg>
          <span className="ticker">{ticker}</span>
          <span className="brand-sub">业务地图</span>
        </a>
        <form
          className="company-picker"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            const value = input.trim().toUpperCase();
            if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(value)) {
              setInvalid(true);
              return;
            }
            navigate(value);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m16 16 4 4" />
          </svg>
          <input
            aria-label="搜索公司股票代码"
            aria-invalid={invalid}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setInvalid(false);
            }}
            placeholder="搜索公司代码"
            maxLength={12}
            autoCapitalize="characters"
            autoComplete="off"
          />
          {invalid && (
            <span className="search-error" role="alert">
              请输入有效的股票代码
            </span>
          )}
        </form>
        <button
          className="theme-toggle"
          aria-label={light ? "切换深色主题" : "切换浅色主题"}
          aria-pressed={light}
          onClick={() => setLight((v) => !v)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {light ? (
              <path d="M20 15a8 8 0 0 1-11-11A8.5 8.5 0 1 0 20 15Z" />
            ) : (
              <>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
              </>
            )}
          </svg>
        </button>
      </header>
      <main>
        <Company key={ticker} ticker={ticker} />
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
