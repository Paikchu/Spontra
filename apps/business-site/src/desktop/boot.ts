import "./reopen";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getLocale } from "@/packages/web/src/i18n/core";
import { CONTENT_MARK } from "../vitals";
import { companyPath } from "../company-opening";
import { companyOfLink, isExternal, proxiedUrl, proxyBase, themeAtLaunch, viewForDigit, type Theme, type ViewName } from "./desktop-model";
import { showScrollThumbs } from "./scroll-thumb";
import "./desktop.css";

const THEME_KEY = "business-map-theme";
const SYSTEM_KEY = "business-map-desktop-system";
const PREFETCH_DELAY_MS = 150;

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Storage may be disabled. */ } };

function installTransport() {
  const proxy = proxyBase(navigator.userAgent);
  const native = window.fetch.bind(window);
  window.fetch = (input, init) => native(typeof input === "string" ? proxiedUrl(input, proxy) : input, init);
  const beacon = navigator.sendBeacon?.bind(navigator);
  navigator.sendBeacon = (url, data) => {
    if (!String(url).endsWith("/telemetry")) return beacon?.(url, data) ?? false;
    if (data instanceof Blob) void data.text().then(body => { if ((JSON.parse(body) as { name?: string }).name === "web_vitals") void invoke("record_vitals", { sample: body }); });
    return true;
  };
}

function followSystemTheme() {
  const scheme = matchMedia("(prefers-color-scheme: light)");
  const system = (): Theme => scheme.matches ? "light" : "dark";
  write(THEME_KEY, themeAtLaunch(read(THEME_KEY), read(SYSTEM_KEY), system()));
  write(SYSTEM_KEY, system());
  scheme.addEventListener("change", () => {
    const previous = read(SYSTEM_KEY), shown = document.documentElement.classList.contains("light") ? "light" : "dark";
    write(SYSTEM_KEY, system());
    if (shown === previous && shown !== system()) document.querySelector<HTMLElement>("[data-theme-toggle]")?.click();
  });
}

function openLinksInBrowser() {
  document.addEventListener("click", event => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!link || event.defaultPrevented || !isExternal(link.href)) return;
    event.preventDefault();
    void invoke("open_external", { url: link.href });
  });
  window.open = (url => { if (url && isExternal(String(url))) void invoke("open_external", { url: String(url) }); return null; }) as typeof window.open;
}

/** The company page's code comes from disk here, so it is compiled while the first screen is being read, not on the first click. */
const prepareCompanyPage = () => { void import("../CompanyPage").catch(() => {}); };

/** Records when the main content first reached the screen, and only then starts on the work the next page needs. */
function reportContent() {
  let reported = false;
  const report = (entries: PerformanceEntryList) => {
    const mark = entries.find(entry => entry.name === CONTENT_MARK);
    if (!mark || reported) return;
    reported = true;
    void invoke("content_ready", { contentMs: mark.startTime, page: location.pathname });
    setTimeout(prepareCompanyPage, 300);
  };
  try {
    report(performance.getEntriesByName(CONTENT_MARK, "mark"));
    new PerformanceObserver(list => report(list.getEntries())).observe({ type: "mark", buffered: true });
  } catch { void invoke("content_ready", { contentMs: performance.now(), page: location.pathname }); }
}

function readAheadOfClick() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  document.addEventListener("pointerover", event => {
    const company = companyOfLink((event.target instanceof Element ? event.target.closest("a[href]")?.getAttribute("href") : null) ?? "");
    clearTimeout(timer);
    if (!company) return;
    timer = setTimeout(() => { void fetch(companyPath(company, getLocale(), "/opening")).catch(() => {}); }, PREFETCH_DELAY_MS);
  });
}

/** With no title bar, the sidebar head and the empty page background move the window. */
function markDragRegions() {
  const mark = () => {
    for (const element of document.querySelectorAll(".rail-top, .home-nav")) if (element.getAttribute("data-tauri-drag-region") !== "deep") element.setAttribute("data-tauri-drag-region", "deep");
    for (const element of document.querySelectorAll("main, .map, .stage, .home")) if (!element.hasAttribute("data-tauri-drag-region")) element.setAttribute("data-tauri-drag-region", "");
  };
  new MutationObserver(mark).observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });
  mark();
}

function goTo(path: string) {
  if (path === location.pathname + location.search) return;
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

const showView = (view: ViewName) => document.querySelector<HTMLElement>(`[data-view-choice="${view}"]`)?.click();

function listenToShell() {
  void listen<string>("deep-link", event => goTo(event.payload));
  void listen<string>("menu", event => {
    const view = viewForDigit(event.payload);
    if (view) showView(view);
    else if (event.payload === "home") goTo("/");
    else if (event.payload === "reload") location.reload();
    else if (event.payload === "search") (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  });
  addEventListener("keydown", event => {
    const view = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey ? viewForDigit(event.key) : null;
    if (!view) return;
    event.preventDefault();
    showView(view);
  });
  // The links and the menu wait for the page to mount, which the first frames guarantee.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    void invoke<string | null>("take_deep_link").then(path => { if (path) goTo(path); });
    void invoke("install_menu", { locale: getLocale() });
  }));
}

document.documentElement.dataset.desktop = /Mac/.test(navigator.platform) ? "mac" : "windows";
installTransport();
followSystemTheme();
openLinksInBrowser();
reportContent();
readAheadOfClick();
listenToShell();
showScrollThumbs();
document.addEventListener("DOMContentLoaded", markDragRegions);
if (document.readyState !== "loading") markDragRegions();
