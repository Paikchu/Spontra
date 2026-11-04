import { ArrowUpRightIcon as ArrowUpRight, BellIcon as Bell, ChartBarIcon as ChartColumn, CpuIcon as Cpu, FilesIcon as FileStack, ArchiveIcon as GalleryVerticalEnd, ListChecksIcon as ListChecks, FunnelSimpleIcon as ListFilter, MoonIcon as Moon, TreeStructureIcon as Network, SunIcon as Sun, type Icon } from "@phosphor-icons/react";
import Link from "@/packages/web/src/navigation";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub,
  SidebarMenuSubButton, SidebarMenuSubItem, SidebarSeparator, useSidebar,
} from "@/packages/web/src/ui/sidebar";
import type { Section } from "./business-view-admin";

const NAV_GROUPS: Array<{ title: string; items: Array<[Section, Icon]> }> = [
  { title: "数据", items: [["whitelist", ListChecks], ["analytics", ChartColumn]] },
  { title: "内容", items: [["filings", FileStack], ["business", Network], ["findings", ListFilter]] },
  { title: "系统", items: [["models", Cpu], ["messages", Bell]] },
];

export function AdminMobileNavigation() {
  const { setOpenMobile } = useSidebar();
  return <div className="ra-mobile-navigation"><button type="button" className="fm-button" aria-label="打开导航" onClick={() => setOpenMobile(true)}>导航</button></div>;
}

type AppSidebarProps = {
  section: Section;
  activeSection: Section;
  pages: Record<Section, { path: string; title: string }>;
  navigate: (section: Section) => void;
  unread: number;
  light: boolean;
  toggleTheme: () => void;
  mapOrigin: string;
};

/** sidebar-03 presentation; the shell owns every page, address and theme transition. */
export function AppSidebar({ section, activeSection, pages, navigate, unread, light, toggleTheme, mapOrigin }: AppSidebarProps) {
  const { setOpenMobile } = useSidebar();
  function select(next: Section) {
    navigate(next);
    setOpenMobile(false);
  }

  return <Sidebar>
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" asChild>
            <a href={pages.whitelist.path} className="ra-brand">
              <div className="ra-brand-mark">
                <GalleryVerticalEnd aria-hidden="true" />
              </div>
              <div className="ra-brand-name">
                <strong>BusinessView</strong>
                <small>后台</small>
              </div>
            </a>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
    <SidebarContent asChild>
      <nav aria-label="后台导航" className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
        {NAV_GROUPS.map(group => <SidebarGroup key={group.title}>
          <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
          <SidebarMenu>
            {group.items.map(([key, Icon]) => <SidebarMenuItem key={key}>
              <SidebarMenuButton isActive={activeSection === key} aria-current={activeSection === key ? "page" : undefined} aria-describedby={key === "messages" && unread > 0 ? "admin-unread-count" : undefined} onClick={() => select(key)}>
                <Icon aria-hidden="true" />
                <span>{pages[key].title}</span>
              </SidebarMenuButton>
              {key === "messages" && unread > 0 && <SidebarMenuBadge id="admin-unread-count" aria-label={`${unread} 条未读`}>{unread > 99 ? "99+" : unread}</SidebarMenuBadge>}
              {key === "whitelist" && section === "financials" && <SidebarMenuSub>
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton asChild isActive aria-current="page">
                    <button type="button" onClick={() => select("financials")}><span>{pages.financials.title}</span></button>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              </SidebarMenuSub>}
            </SidebarMenuItem>)}
          </SidebarMenu>
        </SidebarGroup>)}
      </nav>
    </SidebarContent>
    <SidebarSeparator />
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={toggleTheme} aria-pressed={light}>
            {light ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}<span>{light ? "深色主题" : "浅色主题"}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton asChild>
            <Link href={`${mapOrigin}/`}><ArrowUpRight aria-hidden="true" /><span>打开 BusinessView</span></Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  </Sidebar>;
}
