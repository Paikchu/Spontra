import { useEffect, useState, type FormEvent } from "react";
import { ArrowUpRight, Cpu, FileStack, ListChecks, LoaderCircle, LogOut, Moon, Network, ShieldCheck, Sparkles, Sun } from "lucide-react";
import Link from "@/packages/web/src/navigation";
import { adminApi } from "./admin-api";
import { BusinessMapCompanies } from "./business-map-companies";
import { FilingLibrary } from "./filing-library";
import { BusinessSegments } from "./business-segments";
import { AiRuns } from "./ai-runs";
import { AiModels } from "./ai-models";
import { FinancialMaintenance } from "./financial-maintenance";

type Section = "whitelist" | "financials" | "filings" | "business" | "findings" | "models";
type Page = { path: string; title: string; nav?: Section };

/** Every page of the BusinessView admin. Financials is a drill-down from the whitelist, so it has no entry of its own. */
const PAGES: Record<Section, Page> = {
  whitelist: { path: "/admin/whitelist", title: "白名单管理" },
  financials: { path: "/admin/financials", title: "财报与更新记录", nav: "whitelist" },
  filings: { path: "/admin/filings", title: "SEC 文件拆分" },
  business: { path: "/admin/business", title: "公司业务板块" },
  findings: { path: "/admin/findings", title: "公司要点" },
  models: { path: "/admin/models", title: "模型配置" },
};
const NAV: Array<[Section, typeof ListChecks]> = [["whitelist", ListChecks], ["filings", FileStack], ["business", Network], ["findings", Sparkles], ["models", Cpu]];
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
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [section, setSection] = useState<Section>(initialSection);
  const [key, setKey] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [error, setError] = useState("");
  const page = PAGES[section];
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
  async function login(event: FormEvent) {
    event.preventDefault(); setLoginBusy(true); setError("");
    try { await adminApi("session", { method: "POST", body: JSON.stringify({ key }) }); setKey(""); setAuthenticated(true); }
    catch (e) { setError((e as Error).message); }
    finally { setLoginBusy(false); }
  }
  async function logout() {
    try { await adminApi("session", { method: "DELETE" }); setAuthenticated(false); }
    catch (e) { setError((e as Error).message); }
  }
  const auth = { onUnauthorized: () => setAuthenticated(false), onAuthenticated: () => setAuthenticated(true) };
  const openSection = (ticker: string, documentId: string, sectionId: string) => navigate("filings", `?${new URLSearchParams({ ticker, document: documentId, section: sectionId })}`);

  return <div className="report-admin">
    <aside className="ra-sidebar">
      <a className="ra-brand" href={PAGES.whitelist.path}><span className="ra-brand-dot" aria-hidden="true" />BusinessView<small>后台</small></a>
      <nav aria-label="后台导航">{NAV.map(([key, Icon]) => <button key={key} aria-current={(page.nav ?? section) === key ? "page" : undefined} onClick={() => navigate(key)}><Icon size={19} />{PAGES[key].title}</button>)}</nav>
      <div className="ra-sidebar-bottom">
        <button onClick={toggleTheme} aria-pressed={light}>{light ? <Moon size={16} /> : <Sun size={16} />}{light ? "深色" : "浅色"}</button>
        <Link href={`${mapOrigin}/`}><ArrowUpRight size={16} />打开 BusinessView</Link>
        <div className="ra-account"><ShieldCheck size={18} /><span>管理员</span>{authenticated && <button onClick={() => void logout()} aria-label="退出登录" title="退出登录"><LogOut size={16} /></button>}</div>
      </div>
    </aside>
    <main className="ra-main">
      {authenticated === false ? <div className="ra-login"><ShieldCheck size={34} /><h2>登录</h2><form onSubmit={event => void login(event)}><label htmlFor="admin-key">管理密码</label><input id="admin-key" type="password" autoComplete="current-password" value={key} onChange={event => setKey(event.target.value)} required /><button className="ra-primary" disabled={loginBusy || !key}>{loginBusy && <LoaderCircle className="ra-spin" size={16} />}{loginBusy ? "登录中" : "登录"}</button></form>{error && <p role="alert" className="ra-error">{error}</p>}</div>
        : <>
          {error && <div className="ra-error ra-error-banner" role="alert">{error}</div>}
          {section === "whitelist" ? <BusinessMapCompanies {...auth} />
            : section === "financials" ? <FinancialMaintenance {...auth} />
            : section === "filings" ? <FilingLibrary {...auth} />
            : section === "business" ? <BusinessSegments {...auth} onOpenSection={openSection} />
            : section === "models" ? <AiModels {...auth} />
            : <AiRuns {...auth} kinds={["findings", "analyst"]} translations />}
        </>}
    </main>
  </div>;
}
