import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/packages/web/src/ui/breadcrumb";
import { Separator } from "@/packages/web/src/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/packages/web/src/ui/sidebar";
import { AppSidebar, adminNavGroup } from "./app-sidebar";
import { BusinessMapCompanies } from "./business-map-companies";
import { FilingLibrary } from "./filing-library";
import { BusinessSegments } from "./business-segments";
import { AiRuns } from "./ai-runs";
import { AiModels } from "./ai-models";
import { StageAdminPanel } from "./stage-admin";
import { FinancialMaintenance } from "./financial-maintenance";
import { AdminInbox, useInbox } from "./admin-messages";
import { PageActive } from "./admin-page";
import { AnalyticsPanel } from "./analytics";

export type Section = "whitelist" | "analytics" | "financials" | "filings" | "business" | "findings" | "models" | "messages";
type Page = { path: string; title: string; nav?: Section };

/** Every page of the BusinessView admin. Financials is a drill-down from the whitelist, so it has no entry of its own. */
const PAGES: Record<Section, Page> = {
  whitelist: { path: "/admin/whitelist", title: "白名单管理" },
  analytics: { path: "/admin/analytics", title: "使用情况" },
  financials: { path: "/admin/financials", title: "财报与更新记录", nav: "whitelist" },
  filings: { path: "/admin/filings", title: "SEC 文件拆分" },
  business: { path: "/admin/business", title: "公司业务板块" },
  findings: { path: "/admin/findings", title: "公司要点" },
  models: { path: "/admin/models", title: "模型配置" },
  messages: { path: "/admin/messages", title: "消息" },
};
/** Ink is the default, as on BusinessView; paper is a per-viewer choice. main.tsx applies it before the first paint. */
export const THEME_KEY = "businessview-admin-theme";
/** Pages that read what they show from the address on mount: opened with a new address, they start again from it. */
const FROM_ADDRESS = new Set<Section>(["financials", "filings", "business", "findings"]);
/** Paths of the earlier admin, kept so bookmarks land on the page that replaced them. */
const LEGACY: Record<string, Section> = { "/admin/business-map": "whitelist", "/admin/library": "filings" };

function initialSection(): Section {
  if (typeof window === "undefined") return "whitelist";
  const { pathname, search } = window.location;
  const found = (Object.keys(PAGES) as Section[]).find(key => PAGES[key].path === pathname);
  if (found) return found;
  if (pathname === "/admin/ai") return new URLSearchParams(search).get("kind") === "findings" ? "findings" : "business";
  return LEGACY[pathname] ?? "whitelist";
}

/**
 * The admin shell. A page opened once stays mounted behind the others, so switching back shows it as it was, its data,
 * place and scroll included, and brings it up to date behind what it shows (admin-page.ts).
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
  // Pages push their own levels into history; back and forward also move between pages.
  useEffect(() => { const onPop = () => show(initialSection()); window.addEventListener("popstate", onPop); return () => window.removeEventListener("popstate", onPop); });
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
    try { window.history.replaceState(null, "", `${PAGES[next].path}${address}`); } catch { /* Sandboxed preview. */ }
    show(next); setError("");
  }
  // The admin site has no sign-in: a 401 means Spontra Analysis refused the binding, which only a banner can report.
  const auth = { onUnauthorized: () => setError("管理接口拒绝访问"), onAuthenticated: () => setError("") };
  const openSection = (ticker: string, documentId: string, sectionId: string) => navigate("filings", `?${new URLSearchParams({ ticker, document: documentId, section: sectionId })}`);

  return <SidebarProvider className="report-admin" mobileBreakpoint={769} persistState={false}>
    <AppSidebar section={section} activeSection={page.nav ?? section} pages={PAGES} navigate={navigate} unread={inbox?.unread ?? 0} light={light} toggleTheme={toggleTheme} mapOrigin={mapOrigin} />
    <SidebarInset className="min-w-0">
      <header className="ra-shell-header flex min-h-16 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger aria-label="切换侧边栏" />
        <Separator orientation="vertical" className="mr-2 max-h-4 self-center" />
        <Breadcrumb aria-label="页面位置">
          <BreadcrumbList>
            <BreadcrumbItem>BusinessView 后台</BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>{adminNavGroup(page.nav ?? section)}</BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem><BreadcrumbPage>{page.title}</BreadcrumbPage></BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </header>
      <div className="ra-main">
      {error && <div className="ra-error ra-error-banner" role="alert">{error}</div>}
      {opened.map(key => {
        const content: ReactNode = key === "whitelist" ? <BusinessMapCompanies {...auth} onOpenFinancials={ticker => navigate("financials", `?${new URLSearchParams({ ticker })}`)} />
          : key === "analytics" ? <AnalyticsPanel />
          : key === "financials" ? <FinancialMaintenance {...auth} />
          : key === "filings" ? <FilingLibrary {...auth} />
          : key === "business" ? <BusinessSegments {...auth} onOpenSection={openSection} />
          : key === "models" ? <><StageAdminPanel onUnauthorized={auth.onUnauthorized} /><AiModels {...auth} /></>
          : key === "messages" ? <AdminInbox inbox={inbox} read={read} onOpen={ticker => navigate("whitelist", `?${new URLSearchParams({ ticker })}`)} />
          : <AiRuns {...auth} kinds={["findings", "analyst", "checkup"]} translations />;
        return <div key={`${key}:${generation[key] ?? 0}`} className="ra-page" hidden={key !== section}><PageActive.Provider value={key === section}>{content}</PageActive.Provider></div>;
      })}
      </div>
    </SidebarInset>
  </SidebarProvider>;
}
