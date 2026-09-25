import type { AnalysisRunSummary } from "../../../shared/analysis-contract/filings.ts";

export function companyAnalysisNotice(run: AnalysisRunSummary | undefined, hasOverview = false): string {
  const oldMissingData = run?.errorCode === "yahoo_target_period_missing" || run?.errorCode === "INSUFFICIENT_DATA";
  if (oldMissingData) {
    return hasOverview
      ? "最新季度的 Yahoo 数据尚待对齐，当前展示上一版业务判断。"
      : "正在等待 Yahoo 补齐目标季度数据；数据对齐后将自动生成业务分析。";
  }
  if (run?.state === "queued") return hasOverview ? "新版业务拆解已排队，当前展示上一版内容。" : "业务拆解已排队，正在准备研究材料。";
  if (run?.state === "running") {
    return hasOverview ? "新版业务拆解正在生成，当前展示上一版内容。" : "正在查找来源并核查业务拆解。";
  }
  if (run?.state === "failed") {
    const message = run.errorCode === "RECOVERY_EXHAUSTED"
      ? "业务分析多次生成失败，自动重试已暂停，需维护人员处理。"
      : "业务分析暂时生成失败，系统将按重试策略自动恢复。";
    return hasOverview ? `${message}当前保留上一版已发布结论。` : message;
  }
  if (hasOverview) return "";
  if (run?.state === "unknown") return "暂时无法确认业务分析的生成状态，请稍后重新读取。";
  return "业务拆解尚未生成，将在周期报告就绪后自动启动。";
}

export function shouldPollCompanyAnalysis(run: AnalysisRunSummary | undefined): boolean {
  return Boolean(run && (run.state === "queued" || run.state === "running"
    || (run.state === "failed" && run.errorCode !== "RECOVERY_EXHAUSTED")));
}
