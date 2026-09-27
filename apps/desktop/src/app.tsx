import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { HashRouter, useLocation, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import AppLink, { NavigationContext } from "@/packages/ui/src/navigation";
import { AnalysisPage, SettingsPage, MacroPage } from "@/packages/ui/src/screens";
import { NavigationDock } from "@/components/navigation-dock";
import { ThemeProvider } from "@/app/theme-control";
import { LanguageProvider } from "@/app/language-provider";
import { SpontraEffects } from "@/components/spontra/effects";
import { refreshClientData } from "@/packages/client/src/refresh";
import { AUTH_EVENT, connectionStatus, openExternal, API_ORIGIN } from "./transport";
import { PortfolioPage, StockPage, FilingPage } from "./screens";
import { Connection, ConnectionSettings } from "./connection";
export function normalizeRoute(href: string) {
  const url = new URL(href, API_ORIGIN);
  let path = url.pathname.replace(/\/$/, "") || "/";
  if (path === "/chat" || path === "/market-close") path = "/";
  path = path.replace(/^\/analysis\/stocks\/([^/]+)$/, "/positions/$1").replace(/^\/positions\/([^/]+)\/sec\/([^/]+)$/, "/analysis/stocks/$1/sec/$2");
  return path + url.search + url.hash;
}
class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="alert">页面暂时无法显示。<button onClick={() => { this.setState({ failed: false }); refreshClientData(); }}>重新加载</button></p> : this.props.children; }
}
function RoutePage({ route, onDisconnected }: { route: string; onDisconnected: () => void }) {
  const url = new URL(route, API_ORIGIN); const path = url.pathname;
  if (path === "/") return <PortfolioPage today />;
  if (path === "/ledger") return <PortfolioPage />;
  if (path === "/analysis") return <div className="earning-report"><AnalysisPage /></div>;
  if (path === "/macro") return <MacroPage />;
  if (path === "/settings") return <><SettingsPage /><ConnectionSettings onDisconnected={onDisconnected} /></>;
  const stock = /^\/positions\/([^/]+)$/.exec(path);
  if (stock) return <StockPage ticker={decodeURIComponent(stock[1])} />;
  const report = /^\/analysis\/stocks\/([^/]+)\/sec\/([^/]+)$/.exec(path);
  if (report) return <FilingPage ticker={decodeURIComponent(report[1])} accession={decodeURIComponent(report[2])} query={url.search} />;
  return <p className="desktop-status">未找到页面。<AppLink href="/">返回今日</AppLink></p>;
}
function Workspace() {
  const location = useLocation(); const routerNavigate = useNavigate();
  const rawPath = location.pathname + location.search + location.hash;
  const path = normalizeRoute(rawPath); const key = path.split("#")[0];
  const [pages, setPages] = useState<string[]>([key]);
  const [connection, setConnection] = useState<"checking" | "connected" | "required">("checking");
  const [everConnected, setEverConnected] = useState(false);
  const [linkError, setLinkError] = useState("");
  const previous = useRef(key); const scroll = useRef(new Map<string, number>());
  const [origins, setOrigins] = useState<Record<string, string>>({});
  const navigate = useCallback((href: string, options?: { scroll?: boolean }) => {
    const next = normalizeRoute(new URL(href, API_ORIGIN + path).href);
    if (next.includes("/sec/") && !path.includes("/sec/")) setOrigins(current => ({ ...current, [next.split("#")[0]]: path }));
    routerNavigate(next, { state: { preserveScroll: options?.scroll === false } });
  }, [path, routerNavigate]);
  const connected = () => { setConnection("connected"); setEverConnected(true); refreshClientData(); };
  useEffect(() => {
    let disposed = false;
    void connectionStatus().then(saved => { if (!disposed) { setConnection(saved ? "connected" : "required"); setEverConnected(saved); } }).catch(() => { if (!disposed) setConnection("required"); });
    const unauthorized = () => setConnection("required");
    window.addEventListener(AUTH_EVENT, unauthorized);
    return () => { disposed = true; window.removeEventListener(AUTH_EVENT, unauthorized); };
  }, []);
  useEffect(() => { if (rawPath !== path) routerNavigate(path, { replace: true }); }, [rawPath, path, routerNavigate]);
  useLayoutEffect(() => {
    if (previous.current !== key) {
      setPages(current => current.includes(key) ? current : [...current, key]);
      previous.current = key;
    }
    const savedScroll = scroll.current;
    const saveScroll = () => savedScroll.set(key, window.scrollY);
    window.addEventListener("scroll", saveScroll, { passive: true });
    const frame = requestAnimationFrame(() => {
      const hash = path.split("#")[1];
      if (hash) document.querySelector(`[data-desktop-page="${CSS.escape(key)}"] #${CSS.escape(decodeURIComponent(hash))}`)?.scrollIntoView();
      else if (!location.state?.preserveScroll) window.scrollTo(0, savedScroll.get(key) ?? 0);
    });
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", saveScroll); };
  }, [key, path, location.state]);
  useEffect(() => {
    function link(event: MouseEvent) {
      const a = (event.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || event.defaultPrevented || event.button !== 0) return;
      const href = a.getAttribute("href")!;
      if (a.hasAttribute("download")) return;
      if (href.startsWith("#")) { event.preventDefault(); a.closest("[data-desktop-page]")?.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`)?.scrollIntoView(); return; }
      event.preventDefault();
      if (href.startsWith("/") && !href.startsWith("//")) navigate(href);
      else if (/^https?:\/\//.test(href)) void openExternal(href).catch(() => setLinkError("无法打开链接，请稍后重试。"));
    }
    function keyboard(event: KeyboardEvent) {
      if (event.isComposing || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      const routes = ["/", "/ledger", "/analysis", "/settings"];
      const index = Number(event.key) - 1;
      if (index >= 0 && index < routes.length) { event.preventDefault(); navigate(routes[index]); }
      if (event.key === "[") { event.preventDefault(); routerNavigate(-1); }
      if (event.key === "]") { event.preventDefault(); routerNavigate(1); }
      if (event.key.toLowerCase() === "r") { event.preventDefault(); refreshClientData(); }
    }
    const refresh = () => { if (!document.hidden) refreshClientData(); };
    document.addEventListener("click", link); document.addEventListener("keydown", keyboard);
    window.addEventListener("online", refresh); window.addEventListener("focus", refresh);
    let disposed = false; let cleanup: (() => void) | undefined;
    void listen<string>("desktop-menu", event => { if (event.payload === "refresh") refreshClientData(); else if (event.payload === "back") routerNavigate(-1); else if (event.payload === "forward") routerNavigate(1); else navigate(event.payload); }).then(unlisten => { if (disposed) unlisten(); else cleanup = unlisten; }).catch(() => {});
    return () => { disposed = true; cleanup?.(); document.removeEventListener("click", link); document.removeEventListener("keydown", keyboard); window.removeEventListener("online", refresh); window.removeEventListener("focus", refresh); };
  }, [navigate, routerNavigate]);
  const visiblePages = pages.includes(key) ? pages : [...pages, key];
  return <NavigationContext.Provider value={{ path, pendingPath: null, reportReturnPath: origins[key] ?? null, navigate }}>
    <div inert={connection !== "connected"} aria-hidden={connection !== "connected"}>
      {everConnected && <><NavigationDock />{linkError && <p role="alert">{linkError}</p>}{visiblePages.map(route => <div key={route} data-desktop-page={route} hidden={route !== key} inert={route !== key}>
        <PageBoundary><RoutePage route={route} onDisconnected={() => { setConnection("required"); setEverConnected(false); setPages([key]); }} /></PageBoundary>
      </div>)}<SpontraEffects /></>}
    </div>
    {connection === "checking" && <p className="desktop-status">正在连接…</p>}
    {connection === "required" && <Connection onConnected={connected} />}
  </NavigationContext.Provider>;
}
export function App() { return <ThemeProvider><LanguageProvider><HashRouter><Workspace /></HashRouter></LanguageProvider></ThemeProvider>; }
