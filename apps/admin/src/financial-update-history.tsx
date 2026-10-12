import { useEffect, useRef } from "react";
import { Check, Clock3, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { FinancialMaintenanceTask } from "@/shared/analysis-contract/financial-maintenance";

export function financialDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

const statusLabels: Record<FinancialMaintenanceTask["status"], string> = {
  queued: "排队中", running: "更新中", succeeded: "已完成", partial: "部分完成",
  failed: "失败", cancel_requested: "停止中", cancelled: "已停止",
};
const stageLabels: Record<string, string> = {
  queued: "排队", waiting_issuer: "等待前序任务", identify: "查找公司财报",
  backup: "准备更新", history: "补充历史报表", audit: "整理报表",
  analysis_dispatch: "准备分析", analysis_wait: "生成财报分析", finalize: "保存结果",
  discover: "查找最新财报", discovery: "查找最新财报", extract: "读取表格",
  collect: "获取财报", analyze: "分析财报", analysis: "分析财报",
};
const activeStatuses = new Set(["queued", "running", "cancel_requested"]);

export function FinancialUpdateHistory({ open, onClose, tasks, ticker, busy, hasActiveTask, onRetry, onCancel }: {
  open: boolean; onClose: () => void; tasks: FinancialMaintenanceTask[]; ticker: string;
  busy: boolean; hasActiveTask: boolean; onRetry: (task: FinancialMaintenanceTask) => void;
  onCancel: (task: FinancialMaintenanceTask) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  return <dialog ref={dialog} className="fm-history-dialog" onCancel={onClose} onClose={onClose} aria-labelledby="fm-history-title">
    <div className="fm-dialog-heading"><div><h2 id="fm-history-title">更新记录</h2><p>{ticker}</p></div><button className="fm-icon-button" aria-label="关闭" onClick={onClose}><X size={20} /></button></div>
    {tasks.length ? <ol className="fm-history-list">{tasks.map(task => {
      const active = activeStatuses.has(task.status);
      const needsAttention = task.status === "failed" || task.status === "partial";
      return <li key={task.id} data-state={active ? "active" : needsAttention ? "attention" : "complete"}>
        <div className="fm-history-icon">{active ? <LoaderCircle className="ra-spin" size={19} /> : task.status === "succeeded" ? <Check size={19} /> : <Clock3 size={19} />}</div>
        <div className="fm-history-item"><div className="fm-history-top"><strong>{task.action === "analyze" ? "财报分析" : "财报数据"}</strong><span>{statusLabels[task.status]}</span></div>
          <time dateTime={task.updatedAt}>{financialDate(task.updatedAt)}</time>
          {active && <p>{stageLabels[task.stage] || "处理中"}</p>}
          {active && task.progress.total > 0 && <progress max={task.progress.total} value={task.progress.completed} aria-label="财报更新进度" />}
          {(task.errorCode || task.issues.length > 0) && <details><summary>采集问题</summary><ul>{[...new Set([...(task.errorCode ? [task.errorCode] : []), ...task.issues])].map(issue => <li key={issue}>{issue}</li>)}</ul></details>}
          {(task.canRetry || task.canCancel) && <div className="fm-history-actions">{task.canRetry && <button className="fm-button" disabled={busy || hasActiveTask} onClick={() => onRetry(task)}><RefreshCw size={14} />重试</button>}{task.canCancel && <button className="fm-button" disabled={busy} onClick={() => onCancel(task)}>停止更新</button>}</div>}
        </div>
      </li>;
    })}</ol> : <div className="fm-history-empty"><Clock3 size={28} /><h3>无更新记录</h3></div>}
  </dialog>;
}
