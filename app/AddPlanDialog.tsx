"use client";

import { apiFetch } from "@/packages/client/src/platform";

import { useLanguage } from "@/app/language-provider";

import { useEffect, useState } from "react";
import { useAppNavigation } from "@/packages/ui/src/navigation";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import { Command, CommandInput, CommandList, CommandGroup, CommandItem } from "@/components/ui/command";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyHeader, EmptyDescription } from "@/components/ui/empty";
import { PlusIcon } from "lucide-react";
import { CompanyLogo } from "./company-logo";

type SearchResult = { symbol: string; name: string; exchange: string; type: "stock" | "etf"; isHeld: boolean };

export function AddPlanDialog() {
  const { t } = useLanguage();
  const { navigate } = useAppNavigation();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [directoryUpdatedAt, setDirectoryUpdatedAt] = useState("");

  useEffect(() => {
    const text = query.trim();
    if (!text || !isOpen) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setMessage("");
      setDirectoryUpdatedAt("");
      try {
        const response = await apiFetch(`/api/symbols?q=${encodeURIComponent(text)}`, { signal: controller.signal });
        if (!response.ok) throw new Error();
        const body = await response.json() as { results: SearchResult[]; directoryUpdatedAt: string };
        setResults(body.results);
        setDirectoryUpdatedAt(body.directoryUpdatedAt);
        if (body.results.length === 0) setMessage("没有找到匹配的标的，请检查 ticker 或公司名称。");
      } catch (error) {
        if ((error as Error).name !== "AbortError") setMessage("搜索暂时不可用，请稍后重试。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, isOpen]);

  const changeOpen = (nextOpen: boolean) => {
    setIsOpen(nextOpen);
    if (!nextOpen) return;
    setQuery(""); setResults([]); setMessage(""); setDirectoryUpdatedAt(""); setLoading(false);
  };
  const updateQuery = (value: string) => {
    setQuery(value); setResults([]); setMessage(""); setDirectoryUpdatedAt(""); setLoading(Boolean(value.trim()));
  };

  return (
    <Dialog open={isOpen} onOpenChange={changeOpen}>
      <DialogTrigger asChild><Button type="button"><PlusIcon data-icon="inline-start" />{t("添加持仓计划")}</Button></DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("添加持仓计划")}</DialogTitle>
          <DialogDescription>{t("输入美股 ticker 或公司名称，选择后进入独立详情页。")}</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false}>
          <CommandInput aria-label={t("搜索 ticker 或公司")} value={query} onValueChange={updateQuery} placeholder="AAPL / Apple" autoFocus />
          <CommandList aria-busy={loading}>
            {loading && <div role="status" aria-label={t("正在搜索")} className="flex flex-col gap-3 p-3">{[0,1,2].map((row) => <Skeleton key={row} className="h-12 w-full" />)}</div>}
            {!loading && (!query.trim() || message) && <Empty><EmptyHeader><EmptyDescription>{t(message || "搜索 ticker 或公司名称")}</EmptyDescription></EmptyHeader></Empty>}
            {!loading && results.length > 0 && <CommandGroup heading={t("搜索结果")}>
              {results.map((result) => <CommandItem key={result.symbol} value={result.symbol} onSelect={() => {
                setIsOpen(false);
                navigate(`/positions/${encodeURIComponent(result.symbol)}`);
              }}>
                <CompanyLogo symbol={result.symbol} />
                <span className="flex min-w-0 flex-1 flex-col"><strong>{result.symbol}</strong><span className="truncate text-muted-foreground">{result.name}</span></span>
                <span className="text-muted-foreground">{result.isHeld ? t("当前持仓") : result.type === "etf" ? "ETF" : t("股票")} · {result.exchange}</span>
              </CommandItem>)}
            </CommandGroup>}
          </CommandList>
        </Command>
        {!loading && directoryUpdatedAt && <p className="text-xs text-muted-foreground">{t("证券目录更新于 ")}{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(directoryUpdatedAt))}</p>}
      </DialogContent>
    </Dialog>
  );
}
