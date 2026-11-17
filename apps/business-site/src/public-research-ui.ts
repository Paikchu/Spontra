import { labels, messages } from "@/packages/web/src/i18n";

export const researchWords = messages({
  research: "Research", macro: "Macro research", industry: "Industry research", home: "Home", all: "All research",
  browse: "Browse reports", search: "Find an industry", loading: "Loading research…", retry: "Retry",
  error: "Research could not be loaded", unavailable: "No published research is available yet", denied: "This report is not available to this reader",
  withdrawn: "This report has been withdrawn", missing: "This report or version is unavailable", emptySearch: "No research covers this search yet",
  asOf: "Data as of", published: "Published", version: "Version", history: "History", sources: "Sources", changes: "Changes since the previous version",
  limited: "Limited coverage", complete: "Coverage stated in report", original: "Report language", scope: "Scope", currency: "Currency",
  historical: "Fixed report version. Its evidence and assumptions are preserved at publication.", latest: "Open current version",
  stale: "This research needs updating. Its assumptions should be reviewed before reuse.",
  pending: "Research is being updated. The last published version remains available.",
  notes: "Evidence and limitations", related: "Related research", bodyMissing: "The report body is unavailable. Please try again.",
  read: "Read full report", summary: "Research summary", context: "Scope and version", contents: "In this report",
  analysis: "Investment transmission", scenarios: "Scenario conditions", transmission: "Transmission", verification: "What to verify",
  counterEvidence: "Counter-evidence and uncertainty", basis: "Data and assumptions", assumptions: "Assumptions", premises: "Supporting claims",
  limitations: "Coverage gaps", gaps: (n: number) => `${n} coverage gaps`, locator: "Location in source", citedBy: "Cited by",
}, {
  research: "研究", macro: "宏观研究", industry: "行业研究", home: "首页", all: "全部研究",
  browse: "查看报告", search: "查找行业", loading: "正在加载研究…", retry: "重试",
  error: "研究加载失败", unavailable: "尚无已发布研究", denied: "当前无法访问这份报告",
  withdrawn: "这份报告已撤回", missing: "这份报告或版本暂不可用", emptySearch: "尚未覆盖该行业",
  asOf: "数据截至", published: "发布于", version: "版本", history: "历史版本", sources: "来源", changes: "相对上版变化",
  limited: "有限覆盖", complete: "覆盖范围见报告", original: "报告语言", scope: "适用范围", currency: "币种",
  historical: "固定报告版本，保留发布时的证据与假设。", latest: "查看当前版本",
  stale: "研究待更新，复用其假设前需重新核验。",
  pending: "研究更新中，当前显示上次发布版本。",
  notes: "证据与限制", related: "相关研究", bodyMissing: "报告正文暂不可用，请重试。",
  read: "阅读全文", summary: "研究摘要", context: "范围与版本", contents: "报告目录",
  analysis: "投资传导", scenarios: "情景条件", transmission: "投资传导", verification: "验证节点",
  counterEvidence: "反证与不确定性", basis: "数据与假设", assumptions: "假设", premises: "前提结论",
  limitations: "覆盖缺口", gaps: (n: number) => `${n} 项覆盖缺口`, locator: "原文定位", citedBy: "引用此来源的结论",
});

export const freshnessWords = labels({ valid: "Current", updating: "Updating", review_required: "Needs review", stale: "Stale", unavailable: "Unavailable" },
  { valid: "有效", updating: "更新中", review_required: "待复核", stale: "已过期", unavailable: "不可用" });

export const claimKindWords = labels({ fact: "Fact", inference: "Inference", scenario: "Scenario" },
  { fact: "事实", inference: "推断", scenario: "情景" });

export const scenarioWords = labels({ downside: "Downside", base: "Base", upside: "Upside" },
  { downside: "下行情景", base: "基准情景", upside: "上行情景" });

export const observationBasisWords = labels({ actual: "Actual", consensus: "Consensus", management: "Management", assumption: "Assumption" },
  { actual: "实际值", consensus: "市场共识", management: "管理层口径", assumption: "假设值" });

export const observationStatusWords = labels({ observed: "Observed", missing: "Missing", not_applicable: "Not applicable" },
  { observed: "已有数据", missing: "缺失", not_applicable: "不适用" });

export function researchHref(id: string, version?: string) {
  return `/research/${encodeURIComponent(id)}${version == null ? "" : `?version=${encodeURIComponent(version)}`}`;
}
