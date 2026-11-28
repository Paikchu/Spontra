import { useCallback, useEffect, useState, type ReactNode } from "react";
import { SidebarInset, SidebarProvider } from "@/web/shared/ui/sidebar";
import { AppSidebar, AdminMobileNavigation } from "./app-sidebar";
import { BusinessMapCompanies } from "./business-map-companies";
import { BusinessSegments } from "./business-segments";
import { AiKindPanel } from "./ai-runs";
import { AiModels } from "./ai-models";
import { FinancialMaintenance } from "./financial-maintenance";
import { AdminInbox, useInbox } from "./admin-messages";
import { FilingMaterials } from "./filing-materials";
import { ReportBenchmark } from "./report-benchmark";
import { TranslationsPanel } from "./translations";
import { CompanyReports } from "./company-reports";
import { AppBusiness, AppStatements, AppStream, AppValuation } from "./app-publications";
import { addressTicker } from "./address-ticker";

export type Section = "valuation" | "stream" | "business" | "financials" | "company" | "l1" | "l2" | "benchmark" | "directory" | "models" | "messages";
type Page = { path: string; title: string; global?: true };
const PAGES: Record<Section, Page> = {
  valuation: { path: "/admin/valuation", title: "估值" },
  stream: { path: "/admin/stream", title: "动态" },
  business: { path: "/admin/business", title: "业务地图" },
  financials: { path: "/admin/financials", title: "财务报表" },
  company: { path: "/admin/company", title: "公司" },
  l1: { path: "/admin/l1", title: "L1 原始文件" },
  l2: { path: "/admin/l2", title: "L2 原始文件" },
  benchmark: { path: "/admin/benchmark", title: "报告评测" },
  directory: { path: "/admin/directory", title: "数据与生成控制", global: true },
  models: { path: "/admin/models", title: "模型配置", global: true },
  messages: { path: "/admin/messages", title: "消息与运维", global: true },
};
export const THEME_KEY = "businessview-admin-theme";
const legacy: Record<string, Section> = { "/admin/business-map": "company", "/admin/whitelist": "directory", "/admin/companies": "company", "/admin/library": "l1", "/admin/filings": "l1", "/admin/findings": "valuation" };

function fromLocation() {
  const { pathname, search } = window.location;
  const path = pathname.replace(/\/$/, "");
  const ticker = addressTicker(search);
  const match = (Object.keys(PAGES) as Section[]).find(key => PAGES[key].path === path);
  const section: Section = match ?? (path === "/admin/ai" ? new URLSearchParams(search).get("kind") === "valuation" ? "valuation" : "business" : legacy[path] ?? "valuation");
  return { section, ticker, search };
}

export function BusinessViewAdmin() {
  const [address, setAddress] = useState(fromLocation), [error, setError] = useState("");
  const [light, setLight] = useState(() => !document.documentElement.classList.contains("dark"));
  const { section, ticker, search } = address, page = PAGES[section];
  const { inbox, read } = useInbox(true);
  useEffect(() => {
    const loadAddress = () => { setAddress(fromLocation()); setError(""); };
    const initial = fromLocation();
    if (window.location.pathname !== PAGES[initial.section].path) window.history.replaceState(null, "", PAGES[initial.section].path + initial.search);
    window.addEventListener("popstate", loadAddress);
    return () => window.removeEventListener("popstate", loadAddress);
  }, []);
  function go(next: Section, symbol = ticker, params = new URLSearchParams()) {
    if (symbol) params.set("ticker", symbol);
    const query = params.size ? `?${params}` : "";
    const url = PAGES[next].path + query;
    if (url === window.location.pathname + window.location.search) return;
    window.history.pushState(null, "", url);
    setAddress({ section: next, ticker: symbol, search: query });
    setError("");
    window.scrollTo(0, 0);
  }
  function toggleTheme() {
    const next = !light;
    setLight(next);
    document.documentElement.classList.toggle("dark", !next);
    document.documentElement.classList.toggle("light", next);
    try { localStorage.setItem(THEME_KEY, next ? "light" : "dark"); } catch { /* private storage */ }
  }
  const onUnauthorized = useCallback(() => setError("管理接口拒绝访问"), []);
  const onAuthenticated = useCallback(() => setError(""), []);
  const auth = { onUnauthorized, onAuthenticated };
  let content: ReactNode = null;
  if (page.global || ticker) {
    const params = new URLSearchParams(search);
    content = section === "valuation" ? <AppValuation ticker={ticker}><AiKindPanel ticker={ticker} kind="valuation" onUnauthorized={onUnauthorized}/><details><summary className="cursor-pointer py-2 font-medium">中文译文</summary><TranslationsPanel ticker={ticker} onUnauthorized={onUnauthorized}/></details></AppValuation>
      : section === "stream" ? <AppStream ticker={ticker}><details><summary className="cursor-pointer py-2 font-medium">财报发布管理</summary><CompanyReports ticker={ticker} onUnauthorized={onUnauthorized}/></details></AppStream>
      : section === "business" ? <AppBusiness ticker={ticker}><BusinessSegments {...auth} companyTicker={ticker}/></AppBusiness>
      : section === "financials" ? <AppStatements ticker={ticker}><FinancialMaintenance {...auth} companyTicker={ticker}/></AppStatements>
      : section === "company" ? <BusinessMapCompanies {...auth} companyTicker={ticker}/>
      : section === "l1" || section === "l2" ? <FilingMaterials {...auth} ticker={ticker} layer={section} accession={params.get("accession") ?? ""} source={params.get("source") ?? undefined} onOpenL1={(accession, source) => go("l1", ticker, new URLSearchParams({ accession, source }))}/>
      : section === "benchmark" ? <ReportBenchmark ticker={ticker}/>
      : section === "directory" ? <BusinessMapCompanies {...auth} onOpenCompany={symbol => go("company", symbol)}/>
      : section === "models" ? <AiModels {...auth}/>
      : <AdminInbox inbox={inbox} read={read} onOpen={symbol => go("company", symbol)}/>;
  }
  return <SidebarProvider className="report-admin bg-background text-foreground" mobileBreakpoint={767} persistState={false} keyboardShortcut={null}>
    <AppSidebar section={section} ticker={ticker} pages={PAGES} navigate={next => { if (section !== next) go(next); }} selectTicker={symbol => { if (symbol !== ticker) go(section, symbol); }} unread={inbox?.unread ?? 0} light={light} toggleTheme={toggleTheme}/>
    <SidebarInset className="min-w-0 bg-background" aria-label={page.title}>
      <div className="min-w-0 px-4 py-6 md:px-8 md:py-8 xl:px-12">
        <header className="mb-6 flex min-w-0 items-center gap-3"><AdminMobileNavigation/><h1 className="text-lg! leading-7! font-semibold! tracking-normal!">{page.global || !ticker ? page.title : `${ticker} · ${page.title}`}</h1></header>
        {error && <p role="alert" className="mb-4 text-sm">{error}</p>}
        <div key={`${section}:${page.global ? "" : ticker}:${section === "l1" || section === "l2" ? search : ""}`} className="ra-main" data-section={section}>
          {content ?? <p className="text-sm text-muted-foreground">请选择公司</p>}
        </div>
      </div>
    </SidebarInset>
  </SidebarProvider>;
}
