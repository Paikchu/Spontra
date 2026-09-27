"use client";

import { apiFetch } from "@/packages/client/src/platform";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { revealContent } from "@/app/content-motion";
import { useDelayedBusy } from "@/app/use-delayed-busy";
import { Skeleton } from "@/components/ui/skeleton";
import { SiteHeader } from "./site-header";
import { StockDetail } from "@/app/positions/[ticker]/StockDetail";
import type { HoldingPlanRecord } from "@/lib/holding-plan-store";
import { apiJson } from "@/packages/client/src/platform";
import type { StockContext } from "@/packages/client/src/contracts";

type Stock = StockContext & {
  plan: HoldingPlanRecord | null;
  planStatus: "ready" | "unavailable";
};

export function AnalysisWorkspace({ children }: { children: ReactNode }) {
  const [stock, setStock] = useState<Stock | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);

  const content = useRef<HTMLDivElement>(null);
  const showSkeleton = useDelayedBusy(loading) && !stock;
  useLayoutEffect(() => {
    if (!stock) return;
    const animation = revealContent(content.current, "stock");
    return () => animation?.cancel();
  }, [stock]);

  async function select(ticker: string) {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      const [detail, planResponse] = await Promise.all([
        apiJson<StockContext>(`/api/stocks/${encodeURIComponent(ticker)}`, { signal: controller.signal }),
        apiFetch(`/api/plans/${encodeURIComponent(ticker)}`, { cache: "no-store", signal: controller.signal }).catch(() => null),
      ]);
      const plan = planResponse?.ok ? (await planResponse.json() as { plan: HoldingPlanRecord | null }).plan : null;
      if (id === request.current) setStock({ ...detail, plan, planStatus: planResponse?.ok ? "ready" : "unavailable" });
    } catch {
      if (id === request.current) setError("个股详情暂时无法加载，请重新搜索重试。");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }

  return <div className="sec-app-shell analysis-workspace">
    <SiteHeader onSelect={select} loading={loading} />
    <span role="status" className="sr-only">{loading ? "正在加载个股详情" : ""}</span>
    {error && <p role="alert" className="py-3 text-sm text-destructive">{error}</p>}
    <div ref={content} aria-busy={loading}>
      {stock ? <StockDetail key={stock.ticker} {...stock} embedded /> : showSkeleton ? <div className="stock-loading-placeholder" aria-label="正在加载个股详情">
        <div className="flex items-center gap-4"><Skeleton className="size-12 rounded-lg" /><div className="grid gap-2"><Skeleton className="h-7 w-24" /><Skeleton className="h-4 w-48" /></div></div>
        <Skeleton className="mt-8 h-10 w-full" /><Skeleton className="mt-6 h-7 w-3/4" />
        <Skeleton className="mt-4 h-4 w-full" /><Skeleton className="mt-3 h-4 w-5/6" />
      </div> : children}
    </div>
  </div>;
}
