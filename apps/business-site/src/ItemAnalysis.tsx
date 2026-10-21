import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ComposedAnalysis } from "@/shared/analysis-contract/findings";
import type { ItemAnalysis } from "@/shared/analysis-contract/item-analysis";
import { verifyFindings, type FindingData, type VerifiedFinding } from "@/shared/analysis-runtime/findings";
import { getLocale } from "@/packages/web/src/i18n";
import { fetchItemAnalysis } from "./company-data";
import { LensBlocks } from "./LensPanel";

/** The analysis of the rail row in focus: undefined while it loads, null when the row has none. Read again after an update. */
export function useItemAnalysis(ticker: string, id: string, updates: number): ItemAnalysis | null | undefined {
  const [read, setRead] = useState<{ key: string; analysis: ItemAnalysis | null } | null>(null);
  const key = `${ticker}:${id}:${updates}`;
  useEffect(() => {
    const controller = new AbortController();
    fetchItemAnalysis(ticker, id, controller.signal)
      .then(analysis => { if (!controller.signal.aborted) setRead({ key, analysis }); })
      .catch(() => { if (!controller.signal.aborted) setRead({ key, analysis: null }); });
    return () => controller.abort();
  }, [ticker, id, key]);
  return read?.key === key ? read.analysis : undefined;
}

/**
 * A composed analysis verified again here the way a finding is, against the page's data and the passages it carries:
 * its judgment's numbers against its evidence, its quotes against those passages. Null when it does not verify.
 */
export function useVerifiedAnalysis(analysis: (ComposedAnalysis & { periodEnd: string; generatedAt?: string }) | null | undefined, data: FindingData, ticker: string): { finding: VerifiedFinding; facts: FindingData } | null {
  return useMemo(() => {
    if (!analysis) return null;
    const facts: FindingData = { ...data, passages: [...(data.passages ?? []), ...analysis.passages] };
    const finding = verifyFindings({ schemaVersion: "findings.v1", ticker, periodEnd: analysis.periodEnd, generatedAt: analysis.generatedAt ?? "", model: "compose", findings: [analysis.finding], sources: analysis.sources }, facts, getLocale()).verified[0];
    return finding ? { finding, facts } : null;
  }, [analysis, data, ticker]);
}

/** The analysis's lens document, drawn by the same blocks as a finding's; until it is known, `fallback` stands in once it is known to be missing. */
export function ItemAnalysisBody({ analysis, verified, ticker, nodeColor, fallback }: {
  analysis: ItemAnalysis | null | undefined;
  verified: { finding: VerifiedFinding; facts: FindingData } | null;
  ticker: string;
  nodeColor: (id: string) => string;
  fallback: ReactNode;
}) {
  if (analysis === undefined) return <div className="lens-doc" aria-busy="true"><i className="lens-loading" aria-hidden="true" /></div>;
  if (!analysis || !verified) return <>{fallback}</>;
  const layout = analysis.finding.lens.type === "document" ? analysis.finding.lens.document : undefined;
  return <LensBlocks finding={verified.finding} data={verified.facts} sources={analysis.sources} materials={analysis.materials} ticker={ticker} nodeColor={nodeColor} compact={false} layout={layout} />;
}
