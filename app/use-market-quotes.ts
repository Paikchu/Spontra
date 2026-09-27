"use client";
import { useDataRevision } from "@/packages/client/src/refresh";

import { useEffect, useState } from "react";

import { apiFetch, persistQuotes } from "@/packages/client/src/platform";

import type { MarketQuoteMap } from "@/lib/yahoo-quotes";

export type QuoteLoadStatus = "loading" | "ready" | "unavailable";

export function useMarketQuotes(symbols: string, enabled = true) {
  const revision = useDataRevision();
  const [quotes, setQuotes] = useState<MarketQuoteMap>({});
  const [status, setStatus] = useState<QuoteLoadStatus>("loading");

  useEffect(() => {
    if (!enabled || !symbols) return;
    const controller = new AbortController();
    const cacheKey = "market-quotes-v1";
    let retained: MarketQuoteMap = {};
    try {
      const saved = JSON.parse(persistQuotes() ? localStorage.getItem(cacheKey) || "{}" : "{}") as MarketQuoteMap;
      retained = Object.fromEntries(symbols.split(",").flatMap((symbol) => {
        const quote = saved[symbol];
        return quote && Number.isFinite(quote.price) && Number.isFinite(quote.changePercent)
          && Date.now() - Date.parse(quote.marketTime) < 7 * 24 * 60 * 60_000 ? [[symbol, quote]] : [];
      }));
      if (Object.keys(retained).length) queueMicrotask(() => {
        if (!controller.signal.aborted) setQuotes(retained);
      });
    } catch { /* Storage may be unavailable; live quotes still work. */ }

    void (async () => {
      try {
        const response = await apiFetch(`/api/quotes?symbols=${encodeURIComponent(symbols)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error();
        const body = await response.json() as { quotes: MarketQuoteMap };
        if (controller.signal.aborted) return;
        const merged = { ...retained, ...body.quotes };
        setQuotes(merged);
        try {
          const saved = JSON.parse(persistQuotes() ? localStorage.getItem(cacheKey) || "{}" : "{}") as MarketQuoteMap;
          if (persistQuotes()) localStorage.setItem(cacheKey, JSON.stringify({ ...saved, ...merged }));
        } catch { /* Storage is optional. */ }
        setStatus("ready");
      } catch (error) {
        if ((error as Error).name !== "AbortError") setStatus("unavailable");
      }
    })();

    return () => controller.abort();
  }, [enabled, symbols, revision]);

  return { quotes, status };
}
