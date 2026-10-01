import {
  StrictMode,
  useEffect,
  useState,
  lazy,
  Suspense,
  Component,
  useRef,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
const BusinessFlow = lazy(() =>
  import("@/app/analysis/stocks/[ticker]/BusinessFlow").then((module) => ({
    default: module.BusinessFlow,
  })),
);
import { selectFlow } from "@/lib/earning-report/web/business-flow-model";
import { resolveCompanyBusiness } from "@/lib/earning-report/web/company-business-content";
import type { CompleteFlowPublication } from "@/shared/analysis-contract/complete-business-flow";
import type { PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import "@/app/analysis/stocks/[ticker]/business-flow.css";
import "./style.css";
import { withBusinessDescriptions } from "./business-description";

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
      <p role="alert">
        图表暂时无法显示，请重新加载；不会以示例数据替代真实披露。
      </p>
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
  return (
    <>
      {publication?.outdated && <p role="status">{publication.reasons.includes("SIGNED_LAYOUT_UNSUPPORTED") ? "新一期含负值，比例图暂不支持；当前显示上次完整快照。" : "更新尚未完成，当前显示上次完整快照。"}</p>}
      {failed && !flow ? (
        <div className="state" role="alert">
          <h2>数据暂时无法读取</h2>
          <p>请稍后重试。未披露数据不会视为零。</p>
          <button
            onClick={() => {
              setFailed(false);
              setRetry((n) => n + 1);
            }}
          >
            重试
          </button>
        </div>
      ) : flow ? (
        <ChartBoundary>
          <Suspense fallback={<p role="status">正在加载业务图…</p>}>
            <BusinessFlow
              flow={withBusinessDescriptions(
                flow,
                resolveCompanyBusiness(ticker),
              )}
              business={resolveCompanyBusiness(ticker)}
              notice={
                !flow.quarters.length
                  ? "当前公司尚无可用季度财务流；已公开业务归属仍可查看。"
                  : null
              }
            />
          </Suspense>
        </ChartBoundary>
      ) : publication ? (
        <div className="state" role="status"><h2>{publication.status === "unavailable" ? "当前披露无法完整绘图" : "完整财务图准备中"}</h2><p>不会以缺失值或半图替代完整披露。</p><p>{publication.reasons.join(" · ")}</p></div>
      ) : (
        <p className="state" role="status">
          正在读取公开财报…
        </p>
      )}
    </>
  );
}
function Canvas({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const panelScroll = useRef<{
    id: number;
    y: number;
    panel: HTMLElement;
  } | null>(null);
  const drag = useRef(false),
    ready = useRef(false);
  const fit = () => {
    const box = viewport.current,
      inner = content.current;
    if (!box || !inner) return;
    const scale = Math.min(
      1.4,
      (box.clientWidth - 32) / inner.offsetWidth,
      (box.clientHeight - 112) / inner.offsetHeight,
    );
    setView({
      scale: Math.max(0.15, scale),
      x: (box.clientWidth - inner.offsetWidth * scale) / 2,
      y: 88 + (box.clientHeight - 88 - inner.offsetHeight * scale) / 2,
    });
  };
  useEffect(() => {
    const viewportObserver = new ResizeObserver(fit);
    const contentObserver = new ResizeObserver(() => {
      if (!ready.current && content.current?.querySelector(".business-flow")) {
        ready.current = true;
        fit();
      }
    });
    if (viewport.current) viewportObserver.observe(viewport.current);
    if (content.current) contentObserver.observe(content.current);
    return () => {
      viewportObserver.disconnect();
      contentObserver.disconnect();
    };
  }, []);
  function zoom(factor: number, x: number, y: number) {
    setView((v) => {
      const scale = Math.max(0.15, Math.min(4, v.scale * factor));
      return {
        scale,
        x: x - ((x - v.x) * scale) / v.scale,
        y: y - ((y - v.y) * scale) / v.scale,
      };
    });
  }
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (e: WheelEvent) => {
      if (
        (e.target as HTMLElement).closest(
          "button,a,input,select,.business-flow__business-panel",
        )
      )
        return;
      e.preventDefault();
      zoom(Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  return (
    <div
      ref={viewport}
      className="map-viewport"
      tabIndex={0}
      aria-label="业务地图画布，方向键平移，加减键缩放，0适应窗口"
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [40, 0],
          ArrowRight: [-40, 0],
          ArrowUp: [0, 40],
          ArrowDown: [0, -40],
        };
        if (moves[e.key]) {
          e.preventDefault();
          const [x, y] = moves[e.key];
          setView((v) => ({ ...v, x: v.x + x, y: v.y + y }));
        } else if (["+", "=", "-", "0"].includes(e.key)) {
          e.preventDefault();
          if (e.key === "0") fit();
          else
            zoom(e.key === "-" ? 0.85 : 1.18, innerWidth / 2, innerHeight / 2);
        }
      }}
      onPointerDown={(e) => {
        drag.current = false;
        const target = e.target as HTMLElement;
        const panel = target.closest<HTMLElement>(
          ".business-flow__business-panel",
        );
        if (e.pointerType === "touch" && panel && !target.closest("button,a")) {
          panelScroll.current = { id: e.pointerId, y: e.clientY, panel };
          e.currentTarget.setPointerCapture(e.pointerId);
          return;
        }
        if (
          (e.target as HTMLElement).closest(
            "button,a,input,select,.business-flow__business-panel",
          )
        )
          return;
        if (e.button !== 0) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        drag.current = false;
      }}
      onPointerMove={(e) => {
        const scroll = panelScroll.current;
        if (scroll?.id === e.pointerId) {
          scroll.panel.scrollTop += (scroll.y - e.clientY) / view.scale;
          scroll.y = e.clientY;
          return;
        }
        const old = pointers.current.get(e.pointerId);
        if (!old) return;
        const next = { x: e.clientX, y: e.clientY };
        const others = [...pointers.current.entries()].filter(
          ([id]) => id !== e.pointerId,
        );
        if (others.length) {
          drag.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = others[0][1];
          const before = Math.hypot(old.x - p.x, old.y - p.y),
            after = Math.hypot(next.x - p.x, next.y - p.y);
          if (before > 0)
            zoom(after / before, (next.x + p.x) / 2, (next.y + p.y) / 2);
        } else {
          const dx = next.x - old.x,
            dy = next.y - old.y;
          if (!drag.current && Math.abs(dx) + Math.abs(dy) <= 3) return;
          if (Math.abs(dx) + Math.abs(dy) > 2) {
            drag.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          if (drag.current)
            setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
        }
        pointers.current.set(e.pointerId, next);
      }}
      onPointerUp={(e) => {
        pointers.current.delete(e.pointerId);
        if (panelScroll.current?.id === e.pointerId) panelScroll.current = null;
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        panelScroll.current = null;
      }}
      onLostPointerCapture={(e) => {
        pointers.current.delete(e.pointerId);
        panelScroll.current = null;
      }}
      onClickCapture={(e) => {
        if (drag.current) {
          e.stopPropagation();
          drag.current = false;
        }
      }}
    >
      <div
        ref={content}
        className="map-content"
        style={{
          transform: `translate(${view.x}px,${view.y}px) scale(${view.scale})`,
        }}
      >
        {children}
      </div>
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
  function navigate(next: string) {
    if (next !== ticker) history.pushState(null, "", `/companies/${next}`);
    setTicker(next);
    setInput("");
    setInvalid(false);
  }
  return (
    <>
      <header className="site-header">
        <span className="ticker">{ticker}</span>
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
        <Canvas key={ticker}>
          <Company ticker={ticker} />
        </Canvas>
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
