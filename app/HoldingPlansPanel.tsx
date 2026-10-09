"use client";
import { useDataRevision } from "@/packages/client/src/refresh";

import { apiFetch } from "@/packages/client/src/platform";

import { useLanguage } from "@/app/language-provider";

import { useEffect, useState } from "react";
import Link from "@/packages/web/src/navigation";
import { AddPlanDialog } from "./AddPlanDialog";
import { Button } from "@/packages/web/src/ui/button";
import { Empty } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { HoldingPlanSummary } from "@/lib/holding-plan-store";

export function HoldingPlansPanel() {
  const revision = useDataRevision();
  const { t } = useLanguage();
  const [plans, setPlans] = useState<HoldingPlanSummary[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setError("");
      try {
        const response = await apiFetch("/api/plans", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error();
        const body = await response.json() as { plans: HoldingPlanSummary[] };
        if (!controller.signal.aborted) setPlans(body.plans);
      } catch {
        if (!controller.signal.aborted) setError("计划暂时无法读取，请稍后重试。");
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt, revision]);

  if (error && !plans?.length) return <Empty className="min-h-64"><p role="alert">{t(error)}</p><Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>{t("重试")}</Button></Empty>;
  if (plans === null || plans.length === 0) return <Empty className="min-h-64" aria-busy={plans === null}><AddPlanDialog /></Empty>;

  return (
    <div className="flex flex-col gap-4 py-4">
      {error && <p role="alert">{t(error)}<Button onClick={() => setAttempt(value => value + 1)}>{t("重试")}</Button></p>}
      <Table>
        <TableHeader><TableRow><TableHead>{t("标的")}</TableHead><TableHead>{t("持仓原因")}</TableHead></TableRow></TableHeader>
        <TableBody>
          {plans.map((plan) => <TableRow key={plan.id}>
            <TableCell><Link href={`/positions/${encodeURIComponent(plan.ticker)}`} className="inline-flex flex-col"><strong>{plan.ticker}</strong><span className="text-muted-foreground">{plan.companyName}</span></Link></TableCell>
            <TableCell className="max-w-md whitespace-normal"><p className="line-clamp-2">{plan.holdingReason}</p></TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
      <div className="flex justify-center py-4"><AddPlanDialog /></div>
    </div>
  );
}
