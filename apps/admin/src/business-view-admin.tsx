import { useEffect, useState } from "react";
import { ArrowUpRight, Bell, Cpu, FileStack, ListChecks, Moon, Network, Sparkles, Sun } from "lucide-react";
import Link from "@/packages/web/src/navigation";
import { BusinessMapCompanies } from "./business-map-companies";
import { FilingLibrary } from "./filing-library";
import { BusinessSegments } from "./business-segments";
import { AiRuns } from "./ai-runs";
import { AiModels } from "./ai-models";
import { StageAdminPanel } from "./stage-admin";
import { FinancialMaintenance } from "./financial-maintenance";
import { AdminInbox, useInbox } from "./admin-messages";

type Section = "whitelist" | "financials" | "filings" | "business" | "findings" | "models" | "messages";
type Page = { path: string; title: string; nav?: Section };

/** Every page of the BusinessView admin. Financials is a drill-down from the whitelist, so it has no entry of its own. */
const PAGES: Record<Section, Page> = {
  whitelist: { path: "/admin/whitelist", title: "白名单管理" },
  financials: { path: "/admin/financials", title: "财报与更新记录", nav: "whitelist" },
  filings: { path: "/admin/filings", title: "SEC 文件拆分" },
  business: { path: "/admin/business", title: "公司业务板块" },
  findings: { path: "/admin/findings", title: "公司要点" },
  models: { path: "/admin/models", title: "模型配置" },
  messages: { path: "/admin/messages", title: "消息" },
};
const NAV: Array<[Section, typeof ListChecks]> = [["whitelist", ListChecks], ["filings", FileStack], ["business", Network], ["findings", Sparkles], ["models", Cpu], ["messages", Bell]];
/** Ink is the default, as on BusinessView; paper is a per-viewer choice. main.tsx applies it before the first paint. */
export const THEME_KEY = "businessview-admin-theme";
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

export function BusinessViewAdmin({ mapOrigin = "" }: { mapOrigin?: string }) {
  const [section, setSection] = useState<Section>(initialSection);
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
  useEffect(() => { const onPop = () => setSection(initialSection()); window.addEventListener("popstate", onPop); return () => window.removeEventListener("popstate", onPop); }, []);

  function navigate(next: Section, search = "") {
    setSection(next); setError("");
    try { window.history.replaceState(null, "", `${PAGES[next].path}${search}`); } catch { /* Sandboxed preview. */ }
  }
  // The admin site has no sign-in: a 401 means Spontra Analysis refused the binding, which only a banner can report.
  const auth = { onUnauthorized: () => setError("管理接口拒绝访问"), onAuthenticated: () => setError("") };
  const openSection = (ticker: string, documentId: string, sectionId: string) => navigate("filings", `?${new URLSearchParams({ ticker, document: documentId, section: sectionId })}`);

  return <div className="report-admin">
    <aside className="ra-sidebar">
      <a className="ra-brand" href={PAGES.whitelist.path}><span className="ra-brand-dot" aria-hidden="true" />BusinessView<small>后台</small></a>
      <nav aria-label="后台导航">{NAV.map(([key, Icon]) => <button key={key} aria-current={(page.nav ?? section) === key ? "page" : undefined} onClick={() => navigate(key)}><Icon size={19} />{PAGES[key].title}{key === "messages" && !!inbox?.unread && <span className="ra-nav-count" aria-label={`${inbox.unread} 条未读`}>{inbox.unread > 99 ? "99+" : inbox.unread}</span>}</button>)}</nav>
      <div className="ra-sidebar-bottom">
        <button onClick={toggleTheme} aria-pressed={light}>{light ? <Moon size={16} /> : <Sun size={16} />}{light ? "深色" : "浅色"}</button>
        <Link href={`${mapOrigin}/`}><ArrowUpRight size={16} />打开 BusinessView</Link>
      </div>
    </aside>
    <main className="ra-main">
      {error && <div className="ra-error ra-error-banner" role="alert">{error}</div>}
      {section === "whitelist" ? <BusinessMapCompanies {...auth} />
        : section === "financials" ? <FinancialMaintenance {...auth} />
        : section === "filings" ? <FilingLibrary {...auth} />
        : section === "business" ? <BusinessSegments {...auth} onOpenSection={openSection} />
        : section === "models" ? <><StageAdminPanel onUnauthorized={auth.onUnauthorized} /><AiModels {...auth} /></>
        : section === "messages" ? <AdminInbox inbox={inbox} read={read} onOpen={ticker => navigate("whitelist", `?${new URLSearchParams({ ticker })}`)} />
        : <AiRuns {...auth} kinds={["findings", "analyst", "checkup"]} translations />}
    </main>
  </div>;
}
