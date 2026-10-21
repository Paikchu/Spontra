import { memo, useMemo, type ReactNode } from "react";
import { Button } from "@/packages/web/src/ui/button";
import { getLocale, labels } from "@/packages/web/src/i18n";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { FinancialSankey } from "@/packages/web/src/business-flow/FinancialSankey";
import type { NoticeCode, SceneBlock } from "@/shared/analysis-contract/scene";
import { compileChart } from "@/shared/analysis-runtime/lens/compile";
import { verifyScene } from "@/shared/analysis-runtime/scene/verify";
import { findingData, KIND_LABEL, verifiedFindings, type VerifiedFinding } from "../findings-model";
import type { CompanyData } from "../live-company";
import { LensBlocks } from "../LensPanel";
import { LensFrame } from "../LensFrame";
import { trendChart, type StageState } from "./stage-model";

const NOTICE: Record<NoticeCode, string> = labels({
  "stage-off": "Stage off", "quota-reached": "Daily limit reached", "global-cap-reached": "Paused for today", "turn-interrupted": "Interrupted",
  "turn-failed": "No result", "conversation-unavailable": "Conversation unavailable", "report-started": "Report started", "report-ready": "Report ready",
  "report-failed": "Report failed", retention: "Kept 30 days",
}, {
  "stage-off": "舞台已关闭", "quota-reached": "已达今日上限", "global-cap-reached": "今日已暂停", "turn-interrupted": "已中断",
  "turn-failed": "无结果", "conversation-unavailable": "对话不可用", "report-started": "报告已开始", "report-ready": "报告已完成",
  "report-failed": "报告失败", retention: "保留 30 天",
});

/**
 * The agent's scene on the stage (docs/stage-agent-design.md §5.1): verified again against the data this page holds,
 * so a block whose references the page cannot resolve is left out rather than drawn wrong. Charts go through the same
 * frame the finding page uses; a finding's lens through the same blocks.
 */
export default function SceneView({ ticker, scene, data, onOpenFinding }: { ticker: string; scene: StageState; data: CompanyData; onOpenFinding: (id: string) => void }) {
  const locale = getLocale();
  const facts = useMemo(() => data.flow ? findingData(data.flow, data.publication?.history ?? null, data.capital, data.fundamentals, data.publication?.guidance ?? null, data.findings?.peers ?? null, data.findings?.passages ?? null, data.events) : null, [data]);
  const findings = useMemo(() => facts ? verifiedFindings(data.findings?.findings ?? null, facts) : [], [facts, data.findings]);
  const verified = useMemo(() => facts ? verifyScene(scene.scene, { ticker, data: facts, findings, candidates: null, materials: data.findings?.findings.materials, options: { locale } }) : null, [facts, findings, scene.revision, scene.scene, ticker, data.findings, locale]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!verified || !facts) return null;
  const byId = new Map(findings.map(f => [f.id, f]));
  const latest = data.flow ? [...data.flow.quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)) : [];
  const block = (b: SceneBlock): ReactNode => {
    switch (b.kind) {
      case "lens": {
        const finding = byId.get(b.findingId);
        return finding ? <section className="lens scene-lens" data-kind={finding.kind}>
          <header className="lens-head"><div className="lens-title"><b className="lens-kind" data-kind={finding.kind}>{KIND_LABEL[finding.kind]}</b>
            <h2 lang={langOf(finding.title)}><Button variant="unstyled" type="button" onClick={() => onOpenFinding(finding.id)}>{finding.title}</Button></h2></div></header>
          <LensBlocks finding={finding} data={facts} sources={data.findings?.findings.sources ?? []} materials={data.findings?.findings.materials} record={data.findings?.findings.record} ticker={ticker} nodeColor={() => "var(--biz-1)"} compact={false} layout={b.document} />
        </section> : null;
      }
      case "chart": { const chart = verified.charts[b.id]; return chart ? <LensFrame chart={chart} /> : null; }
      case "metric-trend": return <Trend block={b} data={facts} periodEnd={scene.scene.scope.periodEnd} />;
      case "prose": return <div className="scene-prose">{b.paragraphs.map((p, i) => <p key={i} lang={langOf(p.text)}>{p.text}</p>)}</div>;
      case "findings": return <FindingList findings={(b.ids ?? findings.map(f => f.id)).map(id => byId.get(id)).filter((f): f is VerifiedFinding => f != null)} onOpen={onOpenFinding} />;
      case "business-flow": return latest[0] ? <div className="business-flow chart-fallback"><FinancialSankey quarter={latest[0]} previous={latest[4] ?? null} onSegment={() => {}} /></div> : null;
      case "notice": return <p className="scene-notice">{NOTICE[b.code]}</p>;
    }
  };
  return <div className="scene-grid">
    {verified.rows.map((row, i) => <div key={row.cells.flat().map(b => b.id).join("-") || i} className="scene-row" data-cells={row.cells.length}>
      {row.title && <h3 className="lens-row-title" lang={langOf(row.title)}>{row.title}</h3>}
      {row.cells.map((cell, j) => <div key={cell.map(b => b.id).join("-") || j} className="scene-cell">{cell.map(b => <div key={b.id} className="scene-block" data-kind={b.kind}>{block(b)}</div>)}</div>)}
    </div>)}
  </div>;
}

/** A series over time, drawn as the chart grammar draws any chart. */
const Trend = memo(function Trend({ block, data, periodEnd }: { block: Extract<SceneBlock, { kind: "metric-trend" }>; data: NonNullable<Parameters<typeof compileChart>[1]>; periodEnd: string }) {
  const chart = useMemo(() => compileChart(trendChart(block), data, periodEnd, { locale: getLocale() }).chart, [block, data, periodEnd]);
  return chart ? <LensFrame chart={chart} /> : null;
});

function FindingList({ findings, onOpen }: { findings: VerifiedFinding[]; onOpen: (id: string) => void }) {
  return <ol className="scene-findings">{findings.map(f => <li key={f.id} data-kind={f.kind}>
    <Button variant="unstyled" type="button" onClick={() => onOpen(f.id)}><i className="finding-mark" aria-hidden="true">{f.severity}</i><span lang={langOf(f.title)}>{f.title}</span></Button>
  </li>)}</ol>;
}
