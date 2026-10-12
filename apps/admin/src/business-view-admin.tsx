import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ChevronRight, FileStack, LayoutGrid, ListChecks, LoaderCircle, LogOut, Network, ShieldCheck, Sparkles } from "lucide-react";
import Link from "@/packages/web/src/navigation";
import { adminApi } from "./admin-api";
import { BusinessMapCompanies } from "./business-map-companies";
import { FilingLibrary } from "./filing-library";
import { BusinessSegments } from "./business-segments";
import { AiRuns } from "./ai-runs";
import { FinancialMaintenance } from "./financial-maintenance";

type Section = "whitelist" | "financials" | "filings" | "business" | "findings";
type Page = { path: string; title: string; summary: string; nav?: Section };

/** Every page of the BusinessView admin. Financials is a drill-down from the whitelist, so it has no entry of its own. */
const PAGES: Record<Section, Page> = {
  whitelist: { path: "/admin/whitelist", title: "白名单管理", summary: "管理 BusinessView 覆盖的公司，跟踪数据准备与采集问题" },
  financials: { path: "/admin/financials", title: "财报与更新记录", summary: "阅读已采集的报表，查看或停止数据更新任务", nav: "whitelist" },
  filings: { path: "/admin/filings", title: "SEC 文件拆分", summary: "按时间线查看每家公司的 SEC 文件，以及拆分出的章节、段落和索引卡" },
  business: { path: "/admin/business", title: "公司业务板块", summary: "查询每家公司的业务板块数据、业务脑图、业务解读与业务主线" },
  findings: { path: "/admin/findings", title: "公司要点", summary: "查看每家公司的要点版本与生成记录，必要时重新生成" },
};
const NAV: Array<[Section, typeof ListChecks]> = [["whitelist", ListChecks], ["filings", FileStack], ["business", Network], ["findings", Sparkles]];
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
  useEffect(() => {
    // An old path is replaced by its page's own, keeping the company it named.
    const { pathname, search } = window.location;
    if (pathname === PAGES[section].path) return;
    const ticker = new URLSearchParams(search).get("ticker");
    try { window.history.replaceState(null, "", `${PAGES[section].path}${ticker ? `?${new URLSearchParams({ ticker })}` : ""}`); } catch { /* Sandboxed preview. */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      <a className="ra-brand" href={PAGES.whitelist.path}><span><LayoutGrid size={21} /></span>BusinessView</a>
      <nav aria-label="BusinessView 后台导航">{NAV.map(([key, Icon]) => <button key={key} aria-current={(page.nav ?? section) === key ? "page" : undefined} onClick={() => navigate(key)}><Icon size={19} />{PAGES[key].title}</button>)}</nav>
      <div className="ra-sidebar-bottom"><Link href={`${mapOrigin}/`}><ArrowLeft size={17} />打开 BusinessView</Link><div><ShieldCheck size={23} /><span>管理员</span>{authenticated && <button onClick={() => void logout()} aria-label="退出登录" title="退出登录"><LogOut size={17} /></button>}</div></div>
    </aside>
    <main className="ra-main">
      <header className={`ra-page-header${section === "whitelist" ? " ra-business-map-header" : ""}${section === "financials" && authenticated !== false ? " ra-financial-header" : ""}`}>
        <div><p>BusinessView <ChevronRight size={13} />{page.nav && <>{PAGES[page.nav].title} <ChevronRight size={13} /></>}{page.title}</p><h1>{page.title}</h1><span>{page.summary}</span></div>
        {authenticated && <div className="ra-header-actions"><button className="ra-mobile-logout" onClick={() => void logout()} aria-label="退出登录"><LogOut size={17} /></button></div>}
      </header>
      {authenticated === false ? <div className="ra-login"><ShieldCheck size={34} /><h2>登录 BusinessView 后台</h2><p>使用专用管理密码登录。</p><form onSubmit={event => void login(event)}><label htmlFor="admin-key">管理密码</label><input id="admin-key" type="password" autoComplete="current-password" value={key} onChange={event => setKey(event.target.value)} required placeholder="输入管理密码" /><button className="ra-primary" disabled={loginBusy || !key}>{loginBusy && <LoaderCircle className="ra-spin" size={16} />}{loginBusy ? "正在登录" : "登录后台"}</button></form>{error && <p role="alert" className="ra-error">{error}</p>}<small>登录有效期 8 小时，密码不会保存在浏览器本地存储。</small></div>
        : <>
          {error && <div className="ra-error ra-error-banner" role="alert">{error}</div>}
          {section === "whitelist" ? <BusinessMapCompanies {...auth} />
            : section === "financials" ? <FinancialMaintenance {...auth} onLogout={() => void logout()} />
            : section === "filings" ? <FilingLibrary {...auth} />
            : section === "business" ? <BusinessSegments {...auth} onOpenSection={openSection} />
            : <AiRuns {...auth} kinds={["findings"]} />}
        </>}
    </main>
  </div>;
}
