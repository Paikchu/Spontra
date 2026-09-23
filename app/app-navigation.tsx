"use client";

import { Component, createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { revealContent } from "./content-motion";
import { NavigationPlaceholder } from "./navigation-placeholder";
import { loadAppPage } from "./load-app-page";

const NavigationContext = createContext<{ path: string; pendingPath: string | null; reportReturnPath: string | null; navigate: (href: string, source?: HTMLElement) => void } | null>(null);

export function useAppNavigation() {
  const context = useContext(NavigationContext);
  if (!context) throw new Error("App navigation provider is missing");
  return context;
}

export function useReportReturnPath() {
  return useContext(NavigationContext)?.reportReturnPath ?? null;
}

function normalize(href: string, current: string) {
  const url = new URL(href, `${window.location.origin}${current}`);
  if (url.origin !== window.location.origin) return null;
  let path = url.pathname.replace(/\/$/, "") || "/";
  if (path === "/market-close") return "/";
  path = path.replace(/^\/analysis\/stocks\/([^/]+)$/, "/positions/$1");
  path = path.replace(/^\/positions\/([^/]+)\/sec\/([^/]+)$/, "/analysis/stocks/$1/sec/$2");
  if (!/^\/$|^\/(ledger|analysis|chat|macro|settings)$|^\/positions\/[^/]+(?:\/sec\/[^/]+)?$|^\/analysis\/stocks\/[^/]+\/sec\/[^/]+$/.test(path)) return null;
  // Keep the snapshot identity in both the request and the page cache key.
  return path + (path.includes("/sec/") ? url.search : "") + url.hash;
}

class PageBoundary extends Component<{ children: ReactNode; onError: () => void; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  componentDidUpdate(previous: Readonly<{ children: ReactNode }>) {
    // A fresh server response must be allowed to render after a failed page.
    if (this.state.failed && previous.children !== this.props.children) {
      this.setState({ failed: false });
    }
  }
  render() {
    return this.state.failed
      ? <div role="alert" className="page-shell py-8">页面暂时无法显示。<button type="button" className="ml-2 underline underline-offset-4" onClick={this.props.onRetry}>重新加载页面</button></div>
      : this.props.children;
  }
}

export function AppNavigation({ children, dock }: { children: ReactNode; dock: ReactNode }) {
  const routePath = usePathname();
  const searchParams = useSearchParams();
  const pinnedReport = routePath.includes("/sec/") && (searchParams.has("reportVersion") || searchParams.has("reportDate"));
  const [initialPath] = useState(routePath + (pinnedReport ? `?${searchParams.toString()}` : ""));
  const [path, setPath] = useState(initialPath);
  const [pages, setPages] = useState<Record<string, ReactNode>>({ [initialPath]: children });
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [transition, setTransition] = useState<{ key: string; kind: "page" | "report" | "return" } | null>(null);
  const [error, setError] = useState("");
  const cache = useRef(new Map<string, ReactNode>([[initialPath, children]]));
  const inflight = useRef(new Map<string, Promise<ReactNode>>());
  const active = useRef(initialPath);
  const sequence = useRef(0);
  const scroll = useRef(new Map<string, number>());
  const [reportReturnPath, setReportReturnPath] = useState<string | null>(null);
  const reportOrigins = useRef(new Map<string, string>());
  const visited = useRef(new Set([initialPath]));

  const fetchPage = useCallback((key: string) => {
    if (cache.current.has(key)) return Promise.resolve(cache.current.get(key));
    let task = inflight.current.get(key);
    if (!task) {
      let timeout: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Page request timed out")), 20_000);
      });
      task = Promise.race([loadAppPage(key), deadline])
        .then((node) => { cache.current.set(key, node); return node; })
        .finally(() => { clearTimeout(timeout); inflight.current.delete(key); });
      inflight.current.set(key, task);
    }
    return task;
  }, []);

  const navigate = useCallback(async (href: string) => {
    const next = normalize(href, active.current);
    if (!next) return;
    window.history.replaceState(window.history.state, "", "/");
    const key = next.split("#")[0];
    const id = ++sequence.current;
    const previousKey = active.current.split("#")[0];
    const returning = visited.current.has(key);
    if (key.includes("/sec/") && !previousKey.includes("/sec/")) {
      reportOrigins.current.set(key, active.current);
    }
    setReportReturnPath(reportOrigins.current.get(key) ?? null);
    if (previousKey !== key) scroll.current.set(previousKey, window.scrollY);
    // Selecting a destination is synchronous; its server content arrives separately.
    active.current = next;
    setPath(next);
    setError("");
    const cached = cache.current.has(key);
    setPendingPath(cached ? null : key);
    if (cached) setPages((current) => ({ ...current, [key]: cache.current.get(key) }));
    if (key !== previousKey) {
      setTransition({ key, kind: returning ? "return" : key.includes("/sec/") ? "report" : "page" });
    }
    const restoreScroll = () => requestAnimationFrame(() => {
      if (id !== sequence.current) return;
      const hash = next.split("#")[1];
      if (hash) document.querySelector(`[data-app-page="${CSS.escape(key)}"] #${CSS.escape(decodeURIComponent(hash))}`)?.scrollIntoView({ behavior: "instant" });
      else window.scrollTo({ top: scroll.current.get(key) ?? 0, behavior: "instant" });
    });
    restoreScroll();
    try {
      const node = await fetchPage(key);
      if (id !== sequence.current) return;
      visited.current.add(key);
      setPages((current) => ({ ...current, [key]: node }));
      restoreScroll();
    } catch {
      if (id === sequence.current) setError("页面暂时无法加载，请重试。");
    } finally {
      if (id === sequence.current) setPendingPath(null);
    }
  }, [fetchPage]);

  useEffect(() => {
    if (window.location.hash) { active.current = initialPath + window.location.hash; setPath(active.current); }
    if (!initialPath.includes("?")) window.history.replaceState(window.history.state, "", "/");
    function link(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download") || anchor.hasAttribute("data-app-local-anchor")) return;
      const href = anchor.getAttribute("href")!;
      if (!normalize(href, active.current)) return;
      event.preventDefault();
      event.stopPropagation();
      void navigate(href);
    }
    function warm(event: Event) {
      const anchor = (event.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("data-app-local-anchor")) return;
      const next = normalize(anchor.getAttribute("href")!, active.current);
      if (next) void fetchPage(next.split("#")[0]).catch(() => {});
    }
    document.addEventListener("click", link, true);
    document.addEventListener("pointerover", warm);
    document.addEventListener("focusin", warm);
    return () => { document.removeEventListener("click", link, true); document.removeEventListener("pointerover", warm); document.removeEventListener("focusin", warm); };
  }, [initialPath, navigate, fetchPage]);

  useLayoutEffect(() => {
    if (!transition) return;
    const element = document.querySelector<HTMLElement>(`[data-app-page="${CSS.escape(transition.key)}"]`);
    const animation = revealContent(element, transition.kind);
    return () => animation?.cancel();
  }, [transition]);

  return <NavigationContext.Provider value={{ path, navigate, pendingPath, reportReturnPath }}>
    {dock}
    <span role="status" className="sr-only">{pendingPath ? "正在加载页面" : ""}</span>
    {!(path.split("#")[0] in pages) && <NavigationPlaceholder path={path} error={error} onRetry={() => { void navigate(path); }} />}
    {error && path.split("#")[0] in pages && <div role="alert" className="page-shell py-4">{error}<button className="ml-2 underline" onClick={() => { void navigate(path); }}>重新加载</button></div>}
    {Object.entries(pages).map(([key, node]) => <div key={key} hidden={key !== path.split("#")[0]} inert={key !== path.split("#")[0]} data-app-page={key}><PageBoundary onError={() => { cache.current.delete(key); }} onRetry={() => { void navigate(key); }}>{node}</PageBoundary></div>)}
  </NavigationContext.Provider>;
}
