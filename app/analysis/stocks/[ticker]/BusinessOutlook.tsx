"use client";

import { useEffect, useState } from "react";
import { useDataRevision } from "@/packages/client/src/refresh";
import { apiFetch } from "@/packages/client/src/platform";
import { Button } from "@/packages/web/src/ui/button";
import { Skeleton } from "@/packages/web/src/ui/skeleton";
import type { PublicCompanyAnalysisResponse } from "@/shared/analysis-contract/company-analysis";
import type { PublicFundamentalsResponse } from "@/shared/analysis-contract/fundamentals";
import { companyAnalysisNotice, shouldPollCompanyAnalysis } from "@/lib/earning-report/web/company-analysis-display-state";
import { selectFlow } from "@/packages/web/src/model/business-flow-model";
import { resolveCompanyBusiness } from "@/packages/web/src/model/company-business-content";
import { BusinessFlow } from "./BusinessFlow";

export function BusinessOutlook({ ticker }: { ticker: string }) {
  return <BusinessOutlookContent key={ticker} ticker={ticker} />;
}

function BusinessOutlookContent({ ticker }: { ticker: string }) {
  const revision = useDataRevision();
  const [analysis, setAnalysis] = useState<PublicCompanyAnalysisResponse | null>(null);
  const [fundamentals, setFundamentals] = useState<PublicFundamentalsResponse | null>(null);
  const [analysisLoaded, setAnalysisLoaded] = useState(false);
  const [financialsLoaded, setFinancialsLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    async function loadAnalysis() {
      try {
        const response = await apiFetch(`/api/analysis/v1/companies/${encodeURIComponent(ticker)}/analysis`, { signal: controller.signal });
        if (!response.ok) throw new Error("Company analysis unavailable");
        const value = await response.json() as PublicCompanyAnalysisResponse;
        if (controller.signal.aborted) return;
        setAnalysis(value);
        if (shouldPollCompanyAnalysis(value.latestRun) && polls++ < 20) timer = setTimeout(() => void loadAnalysis(), 60_000);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        if (!controller.signal.aborted) setAnalysisLoaded(true);
      }
    }
    void loadAnalysis();
    void apiFetch(`/api/analysis/v1/companies/${encodeURIComponent(ticker)}/fundamentals?periodCount=8`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Fundamentals unavailable");
        const value = await response.json() as PublicFundamentalsResponse;
        if (!controller.signal.aborted) setFundamentals(value);
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setFinancialsLoaded(true); });
    return () => { controller.abort(); clearTimeout(timer); };
  }, [ticker, refresh, revision]);

  const flow = selectFlow(analysis?.businessFlow, fundamentals, ticker);
  const loading = !analysisLoaded || !financialsLoaded;
  if (loading && !flow.quarters.length && !analysis?.overview) return <section className="business-flow" aria-label="业务前瞻加载中"><h2>业务前瞻</h2><div role="status" className="flex flex-col gap-3 py-4"><span className="sr-only">正在读取公司业务与季度财务数据…</span><Skeleton className="h-16 w-full" /><Skeleton className="h-96 w-full" /></div></section>;
  const business = resolveCompanyBusiness(ticker, analysis?.overview);
  const notice = failed ? "部分数据暂时无法读取；已加载的披露保留，缺失项不会按零计算。" : (business && !analysis?.overview ? "自动业务分析尚未发布；业务归属依据下方公开披露，财务使用独立季度数据。" : companyAnalysisNotice(analysis?.latestRun, Boolean(analysis?.overview))) || (fundamentals?.stale ? "当前财务数据待更新，请核对下方数据时间与原始披露。" : null);
  return <><BusinessFlow publicationLabel={analysis?.overview ? `已发布报告 ${analysis.generatedAt?.slice(0, 10) ?? "日期未知"} · ${analysis.period?.label ?? "期间未知"} · ${analysis.coverageStatus === "partial" ? "部分覆盖" : "覆盖范围见原报告"} · 版本 ${analysis.versions.contentRevision?.slice(0, 12) ?? "未知"}；此旧版解读的证据可能包含 Yahoo 指标，不等同于 SEC 原文核验。` : undefined} business={business} flow={flow} overview={analysis?.overview} notice={notice} />{failed && <Button variant="outline" size="sm" onClick={() => { setFailed(false); setRefresh(value => value + 1); }}>重新读取</Button>}</>;
}
