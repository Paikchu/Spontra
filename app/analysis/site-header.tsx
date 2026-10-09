"use client";

import { apiFetch } from "@/packages/client/src/platform";

import { useEffect, useState } from "react";
import { Search, ArrowRight, LoaderCircle } from "lucide-react";
import { Button } from "@/packages/web/src/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupButton } from "@/components/ui/input-group";
import { useDelayedBusy } from "@/app/use-delayed-busy";
import { useAppNavigation } from "@/packages/web/src/navigation";

import type { SecurityType } from "@/lib/earning-report/web/symbol-directory.ts";

type SearchResult = { symbol: string; name: string; exchange: string; type: SecurityType };

export function SiteHeader({ initialQuery = "", compact = true, loading = false, onSelect }: { initialQuery?: string; compact?: boolean; loading?: boolean; onSelect?: (ticker: string) => void }) {
  const { navigate, pendingPath } = useAppNavigation();
  const delayedBusy = useDelayedBusy(loading);
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchActive, setSearchActive] = useState(false);

  useEffect(() => {
    const value = query.trim();
    if (!value || !searchActive) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await apiFetch(`/api/analysis/v1/search?q=${encodeURIComponent(value)}`, { signal: controller.signal });
        if (response.ok) setResults((await response.json() as { results?: SearchResult[] }).results ?? []);
      } catch { if (!controller.signal.aborted) setResults([]); }
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchActive]);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const match = results.find((result) => result.symbol === query.trim().toUpperCase()) ?? results[0];
    const ticker = (match?.symbol ?? query.trim()).toUpperCase().replace(/[^A-Z0-9.-]/g, "");
    if (ticker) {
      setResults([]);
      setSearchActive(false);
      if (onSelect) onSelect(ticker);
      else navigate(`/positions/${encodeURIComponent(ticker)}`);
    }
  }

  const busy = delayedBusy || Boolean(pendingPath?.startsWith("/positions/"));

  return (
    <header className="analysis-toolbar">
      {!compact && <span className="analysis-toolbar-title">财报 AI 分析</span>}
      <form className="analysis-search" onSubmit={submit} role="search">
        <FieldGroup><Field><FieldLabel className="sr-only" htmlFor="sec-company-search">搜索股票代码或公司名称</FieldLabel>
        <InputGroup><InputGroupInput
          id="sec-company-search"
          autoComplete="off"
          value={query}
          onChange={(event) => {
            const nextQuery = event.target.value;
            setQuery(nextQuery);
            setSearchActive(true);
            setResults([]);
          }}
          placeholder="搜索股票代码或公司名称"
        />
        <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
        <InputGroupAddon align="inline-end"><InputGroupButton type="submit" aria-label="搜索公司">{busy ? <LoaderCircle className="content-spinner" aria-label="正在加载个股" /> : <ArrowRight />}</InputGroupButton></InputGroupAddon>
        </InputGroup></Field></FieldGroup>
        {searchActive && results.length > 0 && (
          <div className="analysis-search-results" aria-label="搜索结果">
            {results.map((result) => (
              <Button variant="ghost" className="w-full justify-start gap-3" type="button" key={result.symbol} onClick={() => {
                setQuery(result.symbol);
                setResults([]);
                setSearchActive(false);
                if (onSelect) onSelect(result.symbol);
                else navigate(`/positions/${encodeURIComponent(result.symbol)}`);
              }}>
                <strong>{result.symbol}</strong><span className="truncate">{result.name}</span>
              </Button>
            ))}
          </div>
        )}
      </form>
    </header>
  );
}
