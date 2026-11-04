import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { SidebarInset, SidebarProvider } from "@/packages/web/src/ui/sidebar";
import { AppSidebar, AdminMobileNavigation } from "./app-sidebar";
import { BusinessMapCompanies } from "./business-map-companies";
import { FilingLibrary } from "./filing-library";
import { BusinessSegments } from "./business-segments";
import { AiRuns } from "./ai-runs";
import { AiModels } from "./ai-models";
import { FinancialMaintenance } from "./financial-maintenance";
import { AdminInbox, useInbox } from "./admin-messages";
import { PageActive } from "./admin-page";
import { AnalyticsPanel } from "./analytics";

export type Section = "whitelist" | "analytics" | "financials" | "filings" | "business" | "findings" | "models" | "messages";
type Page = { path: string; title: string; nav?: Section };

/** Every page of the BusinessView admin. Financials is a drill-down from the companies page, so it has no entry of its own. */
const PAGES: Record<Section, Page> = {
  whitelist: { path: "/admin/companies", title: "公司" },
  analytics: { path: "/admin/analytics", title: "使用情况" },
  financials: { path: "/admin/financials", title: "财务报表", nav: "whitelist" },
  filings: { path: "/admin/filings", title: "财报" },
  business: { path: "/admin/business", title: "公司业务" },
  findings: { path: "/admin/findings", title: "要点" },
  models: { path: "/admin/models", title: "模型配置" },
  messages: { path: "/admin/messages", title: "消息" },
};
/** Ink is the default, as on BusinessView; paper is a per-viewer choice. main.tsx applies it before the first paint. */
export const THEME_KEY = "businessview-admin-theme";
/** Pages that read what they show from the address on mount: opened with a new address, they start again from it. */
const FROM_ADDRESS = new Set<Section>(["whitelist", "financials", "filings", "business", "findings"]);
/** Paths of the earlier admin, kept so bookmarks land on the page that replaced them. */
const LEGACY: Record<string, Section> = { "/admin/business-map": "whitelist", "/admin/whitelist": "whitelist", "/admin/library": "filings" };

function initialSection(): Section {
  if (typeof window === "undefined") return "whitelist";
  const { pathname, search } = window.location;
  const found = (Object.keys(PAGES) as Section[]).find(key => PAGES[key].path === pathname);
  if (found) return found;
  if (pathname === "/admin/ai") return new URLSearchParams(search).get("kind") === "findings" ? "findings" : "business";
  return LEGACY[pathname] ?? "whitelist";
}

/**
 * The admin shell. A page opened once stays mounted behind the others (one that reads its address, until back or forward
 * leaves it), so switching back shows it as it was, its data, place and scroll included, and brings it up to date behind
 * what it shows (admin-page.ts).
 */
export function BusinessViewAdmin({ mapOrigin = "" }: { mapOrigin?: string }) {
  const [section, setSection] = useState<Section>(initialSection);
  const [opened, setOpened] = useState<Section[]>(() => [initialSection()]);
  const [generation, setGeneration] = useState<Partial<Record<Section, number>>>({});
  // Each page's own address and scroll, kept when it is left and given back when it is shown again.
  const kept = useRef<Partial<Record<Section, { search: string; scroll: number }>>>({});
  const [error, setError] = useState("");
  const page = PAGES[section];
  const { inbox, read } = useInbox(true);
  const [light, setLight] = useState(() => typeof document !== "undefined" && !document.documentElement.classList.contains("dark"));
  function toggleTheme() {
    const next = !light;
    setLight(next); document.documentElement.classList.toggle("dark", !next);
    try { localStorage.setItem(THEME_KEY, next ? "light" : "dark"); } catch { /* Private window. */ }
  }
  useEffect(() => {
    // An old path is replaced by its page's own, keeping the company it named.
    const { pathname, search } = window.location;
    if (pathname === PAGES[section].path) return;
    const ticker = new URLSearchParams(search).get("ticker");
    try { window.history.replaceState(null, "", `${PAGES[section].path}${ticker ? `?${new URLSearchParams({ ticker })}` : ""}`); } catch { /* Sandboxed preview. */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Page switches and pages' own levels are pushed into history, so back and forward also move between pages. A page
  // that reads its address starts again from the one moved to; left this way, it no longer knows its address, so it
  // is closed and opens afresh when next opened. Moves within the shown page are that page's to follow.
  useEffect(() => {
    const onPop = () => {
      const next = initialSection();
      if (next === section) return;
      if (FROM_ADDRESS.has(section)) { delete kept.current[section]; setOpened(list => list.filter(key => key !== section)); }
      if (FROM_ADDRESS.has(next)) { delete kept.current[next]; setGeneration(g => ({ ...g, [next]: (g[next] ?? 0) + 1 })); }
      show(next); setError("");
    };
    window.addEventListener("popstate", onPop); return () => window.removeEventListener("popstate", onPop);
  });
  // The page shown again goes back to where it was scrolled.
  useLayoutEffect(() => { window.scrollTo({ top: kept.current[section]?.scroll ?? 0, behavior: "instant" }); }, [section]);

  function show(next: Section) {
    setSection(next);
    setOpened(list => list.includes(next) ? list : [...list, next]);
  }
  /** Opens a page: with `search`, at that address (a page that reads it starts again); without, where it was left. */
  function navigate(next: Section, search?: string) {
    kept.current[section] = { search: window.location.search, scroll: window.scrollY };
    const address = search ?? kept.current[next]?.search ?? "";
    if (search !== undefined && FROM_ADDRESS.has(next) && opened.includes(next)) setGeneration(g => ({ ...g, [next]: (g[next] ?? 0) + 1 }));
    if (search !== undefined && kept.current[next]) kept.current[next]!.scroll = 0;
    // A new address is a new history entry; opening the address already shown replaces it.
    const url = `${PAGES[next].path}${address}`;
    try { window.history[url === `${window.location.pathname}${window.location.search}` ? "replaceState" : "pushState"](null, "", url); } catch { /* Sandboxed preview. */ }
    show(next); setError("");
  }
  // The admin site has no sign-in: a 401 means Spontra Analysis refused the binding, which only a banner can report.
  const auth = { onUnauthorized: () => setError("管理接口拒绝访问"), onAuthenticated: () => setError("") };
  const openSection = (ticker: string, documentId: string, sectionId: string) => navigate("filings", `?${new URLSearchParams({ ticker, document: documentId, section: sectionId })}`);

  return <SidebarProvider className="report-admin" mobileBreakpoint={769} persistState={false} keyboardShortcut={null}>
    <AppSidebar section={section} activeSection={page.nav ?? section} pages={PAGES} navigate={navigate} unread={inbox?.unread ?? 0} light={light} toggleTheme={toggleTheme} mapOrigin={mapOrigin} />
    <SidebarInset className="min-w-0" aria-label={page.title}>
      <AdminMobileNavigation />
      <div className="ra-main" data-section={section}>
      {error && <div className="ra-error ra-error-banner" role="alert">{error}</div>}
      {opened.map(key => {
        const content: ReactNode = key === "whitelist" ? <BusinessMapCompanies {...auth} />
          : key === "analytics" ? <AnalyticsPanel />
          : key === "financials" ? <FinancialMaintenance {...auth} />
          : key === "filings" ? <FilingLibrary {...auth} />
          : key === "business" ? <BusinessSegments {...auth} onOpenSection={openSection} />
          : key === "models" ? <AiModels {...auth} />
          : key === "messages" ? <AdminInbox inbox={inbox} read={read} onOpen={ticker => navigate("whitelist", `?${new URLSearchParams({ ticker })}`)} />
          : <AiRuns {...auth} kinds={["findings", "analyst", "checkup", "valuation"]} translations />;
        return <div key={`${key}:${generation[key] ?? 0}`} className="ra-page" hidden={key !== section}><PageActive.Provider value={key === section}>{content}</PageActive.Provider></div>;
      })}
      </div>
    </SidebarInset>
  </SidebarProvider>;
}
