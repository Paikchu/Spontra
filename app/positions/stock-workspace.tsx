"use client";
import { useDataRevision } from "@/packages/client/src/refresh";

import { apiFetch } from "@/packages/client/src/platform";

import { useEffect, useState } from "react";
import { StockDetail } from "./[ticker]/StockDetail";
import type { HoldingPlanRecord } from "@/lib/holding-plan-store";
import type { StockContext } from "@/packages/client/src/contracts";

export function StockWorkspace({ stock }: { stock: StockContext }) {
  const revision = useDataRevision();
  const [plan, setPlan] = useState<HoldingPlanRecord | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  useEffect(() => {
    const controller = new AbortController();
    apiFetch(`/api/plans/${encodeURIComponent(stock.ticker)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Plan unavailable");
        const payload = await response.json() as { plan: HoldingPlanRecord | null };
        if (!controller.signal.aborted) { setPlan(payload.plan); setStatus("ready"); }
      }).catch(() => { if (!controller.signal.aborted) setStatus("unavailable"); });
    return () => controller.abort();
  }, [stock.ticker, revision]);
  return <StockDetail {...stock} plan={plan} planStatus={status} />;
}
