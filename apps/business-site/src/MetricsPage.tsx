import { useEffect, useState } from "react";
import { messages, useLocale } from "@/packages/web/src/i18n";
import { PrivacyNote } from "./PrivacyNote";
import { LanguageToggle, ThemeToggle } from "./Sidebar";
import type { TelemetryRange, TelemetrySummary } from "./telemetry";
import { UsageBoard, type UsageLabels } from "./usage-board";

const m = messages({
  title: "Product usage",
  empty: "No data for this period yet",
  unavailable: "Usage stats are unavailable",
  retry: "Retry",
  utc: "Times are UTC",
  sessions: "Active sessions",
  pageViews: "Page views",
  companies: "Most visited companies",
  searches: "Searches with no results",
  events: "Events",
  expand: "Finding expand rate",
  errors: "Error rate",
  tour: "Tour completion",
  none: "None yet",
  day: "Last 24 hours",
  week: "Last 7 days",
  month: "Last 4 weeks",
  page_view: "Page view events",
  search_submit: "Search submits",
  search_select: "Search picks",
  company_tab_view: "Statement tabs",
  finding_expand: "Finding opens",
  source_click: "Source clicks",
  chart_period_change: "Quarter changes",
  lang_toggle: "Language switches",
  theme_toggle: "Theme switches",
  error_shown: "Errors shown",
  tour_start: "Tour starts",
  tour_done: "Tour finished",
  tour_skip: "Tour skipped",
}, {
  title: "产品使用情况",
  empty: "这个时间段还没有数据",
  unavailable: "统计暂时没有取到",
  retry: "重试",
  utc: "时间按协调世界时",
  sessions: "日活会话",
  pageViews: "浏览量",
  companies: "访问最多的公司",
  searches: "无结果搜索",
  events: "事件分布",
  expand: "要点展开率",
  errors: "错误率",
  tour: "引导完成率",
  none: "暂无",
  day: "近 24 小时",
  week: "近 7 天",
  month: "近 4 周",
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
});

const NAMES = ["page_view", "search_submit", "search_select", "company_tab_view", "finding_expand", "source_click", "chart_period_change", "lang_toggle", "theme_toggle", "error_shown", "tour_start", "tour_done", "tour_skip"] as const;

function labels(): UsageLabels {
  const eventName: Record<string, string> = {};
  for (const name of NAMES) eventName[name] = m[name];
  return {
    title: m.title, empty: m.empty, unavailable: m.unavailable, retry: m.retry, utc: m.utc,
    sessions: m.sessions, pageViews: m.pageViews, companies: m.companies, searches: m.searches,
    events: m.events, expand: m.expand, errors: m.errors, tour: m.tour, none: m.none,
    ranges: { "24h": m.day, "7d": m.week, "4w": m.month },
    eventName,
  };
}

/** Public anonymous-usage dashboard. The numbers come from this site's own telemetry route. */
export function MetricsPage({ light, onToggleTheme }: { light: boolean; onToggleTheme: () => void }) {
  useLocale();
  const [range, setRange] = useState<TelemetryRange>("7d");
  const [summary, setSummary] = useState<TelemetrySummary | null>(null);
  const [pending, setPending] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setPending(true);
    setFailed(false);
    void fetch(`/api/business/v1/telemetry?range=${range}`, { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async response => {
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as TelemetrySummary;
        if (body.schemaVersion !== "telemetry-summary.v1") throw new Error("invalid");
        setSummary(body);
      })
      .catch(error => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setFailed(true);
        setSummary(null);
      })
      .finally(() => setPending(false));
    return () => controller.abort();
  }, [range, attempt]);
  return <main className="home usage-page">
    <header className="home-nav">
      <a className="home-brand" href="/" data-nav><span className="home-mark" lang="en">BV</span><span lang="en">Business View</span></a>
      <div className="home-nav-tools">
        <ThemeToggle light={light} onToggle={onToggleTheme} />
        <LanguageToggle />
      </div>
    </header>
    <div className="home-wrap usage-wrap">
      <UsageBoard summary={summary} range={range} onRange={setRange} labels={labels()} pending={pending} failed={failed} onRetry={() => setAttempt(value => value + 1)} />
      <footer className="home-foot"><PrivacyNote /></footer>
    </div>
  </main>;
}
