import { useEffect, useRef } from "react";
import { Check, Clock3, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { FinancialMaintenanceTask } from "@/shared/analysis-contract/financial-maintenance";

export function financialDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间待确认" : new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

const statusLabels: Record<FinancialMaintenanceTask["status"], string> = {
  queued: "等待更新", running: "正在更新", succeeded: "更新完成", partial: "部分数据已更新",
  failed: "更新未完成", cancel_requested: "正在停止", cancelled: "已停止",
};
const stageLabels: Record<string, string> = {
  queued: "正在排队", waiting_issuer: "等待前一次更新结束", identify: "正在查找公司财报",
  backup: "正在准备更新", history: "正在补充历史报表", audit: "正在整理报表",
  analysis_dispatch: "正在准备分析", analysis_wait: "正在生成财报分析", finalize: "正在保存结果",
  discover: "正在查找最新财报", discovery: "正在查找最新财报", extract: "正在读取表格",
  collect: "正在获取财报", analyze: "正在分析财报", analysis: "正在分析财报",
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
    <div className="fm-dialog-heading"><div><h2 id="fm-history-title">更新记录</h2><p>{ticker} · 查看获取报表和分析的进度</p></div><button className="fm-icon-button" aria-label="关闭更新记录" onClick={onClose}><X size={20} /></button></div>
    <p className="fm-history-hint">更新会在后台继续，关闭页面也不受影响。</p>
    {tasks.length ? <ol className="fm-history-list">{tasks.map(task => {
      const active = activeStatuses.has(task.status);
      const needsAttention = task.status === "failed" || task.status === "partial";
      return <li key={task.id} data-state={active ? "active" : needsAttention ? "attention" : "complete"}>
        <div className="fm-history-icon">{active ? <LoaderCircle className="ra-spin" size={19} /> : task.status === "succeeded" ? <Check size={19} /> : <Clock3 size={19} />}</div>
        <div className="fm-history-item"><div className="fm-history-top"><strong>{task.action === "analyze" ? "财报分析" : "财报数据"}</strong><span>{statusLabels[task.status]}</span></div>
          <time dateTime={task.updatedAt}>{financialDate(task.updatedAt)}</time>
          {active && <p>{stageLabels[task.stage] || "正在处理，请稍候"}</p>}
          {active && task.progress.total > 0 && <progress max={task.progress.total} value={task.progress.completed} aria-label="财报更新进度" />}
          {task.status === "partial" && <p>已保存可获取的数据，部分内容暂时缺失。你可以稍后重试。</p>}
          {task.status === "failed" && <p>这次未能完成更新，已有数据保留。请稍后重试。</p>}
          {task.status === "cancelled" && <p>更新已停止，之前保存的数据仍然可用。</p>}
          {(task.canRetry || task.canCancel) && <div className="fm-history-actions">{task.canRetry && <button className="fm-button" disabled={busy || hasActiveTask} onClick={() => onRetry(task)}><RefreshCw size={14} />重新尝试</button>}{task.canCancel && <button className="fm-button" disabled={busy} onClick={() => onCancel(task)}>停止更新</button>}</div>}
        </div>
      </li>;
    })}</ol> : <div className="fm-history-empty"><Clock3 size={28} /><h3>还没有更新记录</h3><p>点击“更新数据”后，可以在这里查看进度。</p></div>}
  </dialog>;
}
