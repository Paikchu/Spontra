import { useEffect, useRef, useState, type ReactNode, type UIEvent } from "react";
import { Button } from "@/packages/web/src/ui/button";
import { Sidebar, SidebarHeader, SidebarContent, SidebarTrigger } from "@/packages/web/src/ui/sidebar";
import { CompanyMark } from "./CompanyMark";

export function ThemeToggle({ light, onToggle }: { light: boolean; onToggle: () => void }) {
  return <Button variant="unstyled" type="button" className="icon-button" aria-label={light ? "切换深色主题" : "切换浅色主题"} aria-pressed={light} onClick={onToggle}>
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
    <a href="/" data-nav className="icon-button" aria-label="首页" title="首页">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1Z" />
      </svg>
    </a>
    <Button variant="unstyled" type="button" className="icon-button" aria-label="搜索公司" aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K /" title="搜索公司 (⌘K)" onClick={onSearch}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4 4" />
      </svg>
    </Button>
    <ThemeToggle light={light} onToggle={onToggleTheme} />
    <SidebarTrigger variant="unstyled" type="button" className="icon-button rail-toggle" aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"} aria-expanded={!collapsed} aria-controls="rail-body"
      title={collapsed ? "展开侧边栏" : "收起侧边栏"}>
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
  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    setScrolled(el.scrollTop > 1);
    el.dataset.scrolling = "";
    clearTimeout(idle.current);
    idle.current = window.setTimeout(() => delete el.dataset.scrolling, 900);
  }
  return <Sidebar collapsible="none" asChild><aside className="rail" aria-label={label} data-scrolled={scrolled && !expanded || undefined}>
    <SidebarHeader asChild><div className="rail-top">
      <CompanyMark ticker={ticker} />
      {actions}
      {children && <div className="rail-blur" aria-hidden="true" />}
    </div></SidebarHeader>
    {children && <SidebarContent asChild><div className="rail-scroll" id="rail-body" data-expanded={expanded || undefined} onScroll={onScroll}>{children}</div></SidebarContent>}
  </aside></Sidebar>;
}
