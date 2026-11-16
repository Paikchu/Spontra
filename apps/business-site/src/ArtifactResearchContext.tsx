import "./artifact-research-context.css";
import type { PublishedArtifact } from "@/shared/analysis-contract/artifact";
import { messages, useLocale } from "@/packages/web/src/i18n";

const m = messages({ context: "Public research used by this report", asOf: "Research frozen at", macro: "Macro", industry: "Industry", adopted: "Applied to company evidence", rejected: "Rejected for this company", not_applicable: "Not applicable", review: "Background research has changed. This report and its original model remain unchanged and require review.", unavailable: "Background validity could not be checked.", gaps: "Coverage gaps", unreviewed: "Available background; no company impact adopted" }, { context: "本报告使用的公共研究", asOf: "研究上下文冻结于", macro: "宏观", industry: "行业", adopted: "结合公司证据采用", rejected: "对本公司不采用", not_applicable: "不适用", review: "背景研究已变化，本文及原模型仍保留原版本，尚待复核。", unavailable: "暂时无法核验背景研究的有效性。", gaps: "覆盖缺口", unreviewed: "可用背景，未采用公司影响" });
export function ArtifactResearchContext({ artifact }: { artifact: Pick<PublishedArtifact, "researchContext" | "researchFreshness"> }) {
  useLocale();
  const context = artifact.researchContext;
  if (!context) return null;
  const href = (id: string, version: string, claim?: string) => `/research/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}${claim ? `#claim-${encodeURIComponent(claim)}` : ""}`;
  return <details className="artifact-research-context">
    <summary>{m.context}</summary>
    <p>{m.asOf} {context.asOf.slice(0, 10)}</p>
    {artifact.researchFreshness === "review_required" && <p role="status">{m.review}</p>}
    {artifact.researchFreshness === "unavailable" && <p role="status">{m.unavailable}</p>}
    <ul>{context.reports.map(report => <li key={`${report.reportId}:${report.version}`}>
      <a href={href(report.reportId, report.version)}>{m[report.type]} · {report.title}</a> · {report.asOf.slice(0, 10)} · {report.version}
      <ul>{context.uses.filter(use => use.reportId === report.reportId && use.version === report.version).map(use => <li key={use.claimId}><a href={href(report.reportId, report.version, use.claimId)}>{use.claimId}</a> · {m[use.decision]}：{use.reason}</li>)}</ul>
      {!context.uses.some(use => use.reportId === report.reportId && use.version === report.version) && <p>{m.unreviewed}</p>}
    </li>)}</ul>
    {context.gaps.length > 0 && <><h3>{m.gaps}</h3><ul>{context.gaps.map((gap, i) => <li key={i}>{m[gap.kind]}{gap.industryId ? ` · ${gap.industryId}` : ""}：{gap.reason}</li>)}</ul></>}
  </details>;
}
