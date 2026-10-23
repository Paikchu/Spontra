import { useEffect, useRef, useState, type ReactNode, type UIEvent } from "react";
import { Button } from "@/packages/web/src/ui/button";
import { Sidebar, SidebarHeader, SidebarContent, SidebarTrigger } from "@/packages/web/src/ui/sidebar";
import { messages, setLocale, useLocale } from "@/packages/web/src/i18n";
import { CompanyMark } from "./CompanyMark";
import { crossfade } from "./page-turn";

const m = messages({
  lightTheme: "Light theme", home: "Home", search: "Search companies", searchShortcut: "Search companies (⌘K)",
  expand: "Expand sidebar", collapse: "Collapse sidebar", switchTo: "切换到中文", other: "中",
}, {
  lightTheme: "浅色主题", home: "首页", search: "搜索公司", searchShortcut: "搜索公司（⌘K）",
  expand: "展开侧栏", collapse: "收起侧栏", switchTo: "Switch to English", other: "EN",
});

/** Switches the interface between English and Chinese; the button names the language it switches to. */
export function LanguageToggle() {
  const locale = useLocale();
  const next = locale === "zh-CN" ? "en" : "zh-CN";
  return <Button variant="unstyled" type="button" className="icon-button lang-toggle" aria-label={m.switchTo} title={m.switchTo} lang={next} onClick={() => { if (document.querySelector(".map")) crossfade(() => setLocale(next), "map"); else setLocale(next); }}>
    <span aria-hidden="true">{m.other}</span>
  </Button>;
}

export function ThemeToggle({ light, onToggle }: { light: boolean; onToggle: () => void }) {
  return <Button variant="unstyled" type="button" className="icon-button" aria-label={m.lightTheme} aria-pressed={light} onClick={onToggle}>
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {light ? <path d="M20 15a8 8 0 0 1-11-11A8.5 8.5 0 1 0 20 15Z" /> : <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
      </>}
    </svg>
  </Button>;
}

/** Home, search, theme switch and rail toggle, beside the ticker at the top of the rail. */
export function RailActions({ light, onToggleTheme, onSearch, collapsed }: {
  light: boolean; onToggleTheme: () => void; onSearch: () => void; collapsed: boolean;
}) {
  return <div className="rail-actions">
    <a href="/" data-nav className="icon-button" aria-label={m.home} title={m.home}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1Z" />
      </svg>
    </a>
    <Button variant="unstyled" type="button" className="icon-button" aria-label={m.search} aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K /" title={m.searchShortcut} onClick={onSearch}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4 4" />
      </svg>
    </Button>
    <ThemeToggle light={light} onToggle={onToggleTheme} />
    <LanguageToggle />
    <SidebarTrigger variant="unstyled" type="button" className="icon-button rail-toggle" aria-label={collapsed ? m.expand : m.collapse} aria-expanded={!collapsed} aria-controls="rail-body"
      title={collapsed ? m.expand : m.collapse}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M9 4v16" />
        <path d={collapsed ? "m13.5 10 2 2-2 2" : "m16 10-2 2 2 2"} />
      </svg>
    </SidebarTrigger>
  </div>;
}

/**
 * Floating card: the company row stays put, everything below it scrolls inside the card.
 * Once the list moves, a blur band under the row softens what slides beneath it; the scrollbar thumb only shows while scrolling or hovered.
 */
export function Rail({ ticker, actions, label, expanded = false, children }: {
  ticker: string; actions: ReactNode; label?: string;
  /** A section has opened over the whole rail: the body stops scrolling and that section scrolls its own list. */
  expanded?: boolean;
  children?: ReactNode;
}) {
  const [scrolled, setScrolled] = useState(false);
  const idle = useRef(0);
  useEffect(() => () => clearTimeout(idle.current), []);
  // The scrollbar's gutter is always reserved and taken out of the right padding, so rows keep one width whether
  // or not the list overflows. Overlay scrollbars reserve nothing; classic ones their own width, measured here.
  const aside = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const hasBody = children != null;
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => { if (!el.hasAttribute("data-expanded") && el.clientWidth) aside.current?.style.setProperty("--rail-gutter", `${el.offsetWidth - el.clientWidth}px`); };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasBody]);
  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    setScrolled(el.scrollTop > 1);
    el.dataset.scrolling = "";
    clearTimeout(idle.current);
    idle.current = window.setTimeout(() => delete el.dataset.scrolling, 900);
  }
  return <Sidebar collapsible="none" asChild><aside className="rail" ref={aside} aria-label={label} data-scrolled={scrolled && !expanded || undefined}>
    <SidebarHeader asChild><div className="rail-top">
      <CompanyMark ticker={ticker} />
      {actions}
      {children && <div className="rail-blur" aria-hidden="true" />}
    </div></SidebarHeader>
    {children && <SidebarContent asChild><div className="rail-scroll" id="rail-body" ref={body} data-expanded={expanded || undefined} onScroll={onScroll}>{children}</div></SidebarContent>}
  </aside></Sidebar>;
}
