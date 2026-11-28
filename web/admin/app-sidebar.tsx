/// <reference types="vite/client" />
import spontraIcon from "./spontra-icon.png";
import { useEffect, useState } from "react";
import { Activity, Bell, Building, ChartLine, CheckListSquare, Cpu, FileContent, FileText, FolderFiles, Menu, Moon, Search, Settings, Sun, TagPrice } from "reicon-react";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/web/shared/ui/sidebar";
import { Button } from "@/web/shared/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/web/shared/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/shared/ui/popover";
import type { BusinessMapDirectory, IssuerSuggestion } from "@/src/api/admin/types/business-map-admin";
import { adminApi } from "./admin-api";
import type { Section } from "./business-view-admin";

const groups = [
  { title: "App", items: [["valuation", TagPrice], ["stream", Activity], ["business", ChartLine], ["financials", FileContent]] },
  { title: "公司工具", items: [["company", Building], ["l1", FolderFiles], ["l2", FileText], ["benchmark", CheckListSquare]] },
  { title: "全局管理", items: [["directory", Settings], ["models", Cpu], ["messages", Bell]] },
] as const;

export function AdminMobileNavigation({ title }: { title: string }) {
  const { setOpenMobile } = useSidebar();
  return <div className="flex items-center gap-3 px-4 py-2 md:hidden">
    <Button variant="ghost" size="icon" aria-label="打开管理导航" onClick={() => setOpenMobile(true)}><Menu size={18} strokeWidth={1.5}/></Button>
    <strong>{title}</strong>
  </div>;
}

type Props = {
  section: Section; ticker: string; pages: Record<Section, { title: string }>;
  navigate: (section: Section) => void; selectTicker: (ticker: string) => void;
  unread: number; light: boolean; toggleTheme: () => void;
};

export function AppSidebar({ section, ticker, pages, navigate, selectTicker, unread, light, toggleTheme }: Props) {
  const { setOpenMobile } = useSidebar();
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [result, setResult] = useState<{ query: string; rows: IssuerSuggestion[]; failed: boolean }>();
  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const options = { signal: controller.signal };
      const rows = term ? adminApi<{ issuers: IssuerSuggestion[] }>(`business-map/issuers?${new URLSearchParams({ q: term })}`, options).then(x => x.issuers)
        : adminApi<BusinessMapDirectory>("business-map/directory?filter=on&page=1", options).then(x => x.rows);
      void rows.then(rows => { if (!controller.signal.aborted) setResult({ query: term, rows, failed: false }); })
        .catch(() => { if (!controller.signal.aborted) setResult({ query: term, rows: [], failed: true }); });
    }, 160);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, query]);
  const current = result?.query === query.trim() ? result : null;
  return <Sidebar>
    <SidebarHeader className="gap-4 px-4 pt-6 pb-4">
      <div className="flex items-center gap-3"><img src={spontraIcon} width="32" height="32" alt="" className="size-8 rounded-lg"/><strong className="text-lg font-semibold">Spontra</strong></div>
      <Popover open={open} onOpenChange={value => { setOpen(value); if (!value) setQuery(""); }}>
        <PopoverTrigger asChild><Button variant="outline" className="w-full justify-start gap-2 rounded-lg" aria-label="搜索股票代码">
          <span className="grid size-6 place-items-center"><Search size={18} strokeWidth={1.5}/></span>{ticker || "搜索 Ticker"}
        </Button></PopoverTrigger>
        <PopoverContent className="w-76 max-w-[calc(100vw-2rem)] p-0 shadow-none" align="start">
          <Command shouldFilter={false}>
            <CommandInput aria-label="输入 Ticker 或公司名" placeholder="Ticker 或公司名" value={query} onValueChange={setQuery}/>
            <CommandList>
              <CommandEmpty>{!current ? "搜索中…" : current.failed ? "无法读取公司目录" : "无匹配公司"}</CommandEmpty>
              {current?.rows.map(c => <CommandItem key={c.ticker} value={c.ticker} onSelect={() => { selectTicker(c.ticker); setOpen(false); setQuery(""); setOpenMobile(false); }}>
                <span className="w-14 shrink-0 font-semibold">{c.ticker}</span><span className="truncate text-muted-foreground">{c.name}</span>
              </CommandItem>)}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </SidebarHeader>
    <SidebarContent className="gap-4 px-2" aria-label="后台导航">
      {groups.map(({ title, items }, index) => <SidebarGroup key={title} className={index === 2 ? "mt-auto" : ""}>
        <SidebarGroupLabel>{title}</SidebarGroupLabel>
        <SidebarMenu className="gap-1">
          {items.map(([key, Icon]) => <SidebarMenuItem key={key}>
            <SidebarMenuButton className="h-9 rounded-lg" isActive={section === key} aria-current={section === key ? "page" : undefined} onClick={() => { navigate(key); setOpenMobile(false); }}>
              <span className="grid size-6 shrink-0 place-items-center"><Icon size={18} strokeWidth={1.5} aria-hidden="true"/></span><span>{pages[key].title}</span>
            </SidebarMenuButton>
            {key === "messages" && unread > 0 && <SidebarMenuBadge aria-label={`${unread} 条未读`}>{unread > 99 ? "99+" : unread}</SidebarMenuBadge>}
          </SidebarMenuItem>)}
        </SidebarMenu>
      </SidebarGroup>)}
    </SidebarContent>
    <SidebarFooter className="px-4 pb-4">
      <Button variant="ghost" className="justify-start" onClick={toggleTheme}>
        <span className="grid size-6 place-items-center">{light ? <Moon size={18} strokeWidth={1.5}/> : <Sun size={18} strokeWidth={1.5}/>}</span>{light ? "深色外观" : "浅色外观"}
      </Button>
    </SidebarFooter>
  </Sidebar>;
}
