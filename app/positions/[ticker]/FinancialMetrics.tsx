"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { FundamentalChartRenderer } from "@/components/earning-report/fundamentals/FundamentalChart";
import type { PublicFundamentalsResponse } from "@/shared/analysis-contract/fundamentals";

import { formatStockFundamentalValue as formatValue } from "@/lib/stock-detail-format";

export function FinancialMetrics({ ticker }: { ticker: string }) {
  const [data, setData] = useState<PublicFundamentalsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => fetch(`/api/analysis/v1/companies/${encodeURIComponent(ticker)}/fundamentals?periodCount=5`, { signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("unavailable"); return response.json() as Promise<PublicFundamentalsResponse>; })
      .then((value: PublicFundamentalsResponse) => { if (!controller.signal.aborted) { if (value.source !== "sec_xbrl") throw new Error("SEC data unavailable"); setData((previous) => value.status === "pending" && previous?.ticker === ticker && previous.status === "ready" ? previous : value); setFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [ticker, attempt]);
  if (failed && (!data || data.ticker !== ticker)) return <Alert variant="destructive"><AlertDescription>财务指标暂时无法读取。<Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>重新读取</Button></AlertDescription></Alert>;
  if (!data || data.ticker !== ticker) return <div role="status" className="flex flex-col gap-4"><span className="sr-only">正在读取财务指标…</span><Skeleton className="h-60 w-full" /></div>;
  if (data.status !== "ready" || !data.series.some((series) => series.available)) return <Empty><EmptyHeader><EmptyTitle>财务指标尚未就绪</EmptyTitle><EmptyDescription>SEC 文件中的季度数据尚未就绪，后续披露更新后会自动尝试补齐。</EmptyDescription></EmptyHeader></Empty>;
  const available = data.series.filter((series) => series.available);
  const chartKeys = new Set(["total_revenue", "net_income", "operating_cash_flow", "free_cash_flow"]);
  return <section className="stock-detail-financials"><div className="stock-detail-section-title"><h2>财务指标</h2><span>近 {data.periods.length} 个季度 · SEC 文件（XBRL）{data.stale || failed ? " · 数据待更新" : ""}{data.partial ? " · 部分指标缺失" : ""}</span></div>
    <div className="stock-detail-charts">{available.filter((series) => chartKeys.has(series.metricKey)).map((series) => <FundamentalChartRenderer key={series.metricKey} title={series.label} data={data} series={[{ metricKey: series.metricKey, mark: series.defaultMark }]} />)}</div>
    <Table aria-label="近五季度财务指标"><TableHeader><TableRow><TableHead>指标</TableHead><TableHead>单位</TableHead>{data.periods.map((period) => <TableHead key={period.periodEnd}>{period.periodEnd}</TableHead>)}</TableRow></TableHeader><TableBody>
      {available.map((series) => <TableRow key={series.metricKey}><TableCell>{series.label}</TableCell><TableCell>{series.unitFamily === "percent" ? "%" : series.unitFamily === "currency" || series.unitFamily === "per_share" ? series.currency || series.unit : series.unit}</TableCell>{data.periods.map((period) => <TableCell key={period.periodEnd}>{formatValue(series.points.find((point) => point.periodEnd === period.periodEnd)?.valueDecimal, series)}</TableCell>)}</TableRow>)}
    </TableBody></Table>
  </section>;
}
