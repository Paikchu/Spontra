import { useEffect, useState } from "react";
import type { TelemetryRange, TelemetrySummary } from "@/apps/business-site/src/telemetry";
import { UsageBoard, type UsageLabels } from "@/apps/business-site/src/usage-board";

const labels: UsageLabels = {
  title: "产品使用情况",
  empty: "这个时间段还没有数据",
  unavailable: "统计暂时没有取到",
  retry: "重试",
  utc: "时间按协调世界时",
  sessions: "独立会话",
  pageViews: "浏览量",
  companies: "访问最多的公司",
  searches: "无结果搜索",
  events: "事件分布",
  expand: "要点展开率",
  errors: "错误率",
  tour: "引导完成率",
  none: "暂无",
  ranges: { "24h": "近 24 小时", "7d": "近 7 天", "4w": "近 4 周" },
  eventName: {
    page_view: "页面浏览事件",
    search_submit: "提交搜索",
    search_select: "选中搜索结果",
    company_tab_view: "切换报表",
    finding_expand: "展开要点",
    source_click: "打开来源",
    chart_period_change: "切换季度",
    lang_toggle: "切换语言",
    theme_toggle: "切换主题",
    error_shown: "显示错误",
    tour_start: "开始引导",
    tour_done: "完成引导",
    tour_skip: "跳过引导",
  },
};

/** Anonymous usage from the public site. The numbers are the aggregate, never a raw address. */
export function AnalyticsPanel() {
  const [range, setRange] = useState<TelemetryRange>("7d");
  const [summary, setSummary] = useState<TelemetrySummary | null>(null);
  const [pending, setPending] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setSummary(null);
    setPending(true);
    setFailed(false);
    void fetch(`/api/admin/analytics?range=${range}`, { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async response => {
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as TelemetrySummary;
        if (body.schemaVersion !== "telemetry-summary.v1") throw new Error("invalid");
        if (!controller.signal.aborted) setSummary(body);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setFailed(true);
        setSummary(null);
      })
      .finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [range, attempt]);
  return <div className="ra-analytics">
    <UsageBoard summary={summary} range={range} onRange={setRange} labels={labels} pending={pending} failed={failed} onRetry={() => setAttempt(value => value + 1)} />
  </div>;
}
