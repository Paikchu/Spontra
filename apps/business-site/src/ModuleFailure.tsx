import { messages } from "@/packages/web/src/i18n";
import type { MapResource } from "@/shared/analysis-contract/revisions";
const m = messages({
  unavailable: "Temporarily unable to load", retry: "Retry", rate: "Too many requests. Refreshing automatically shortly.",
  company: "Revenue and profit", capital: "Financial statements", findings: "Signals", fundamentals: "Fundamentals", events: "Events", filings: "Filings", valuation: "Valuation",
}, {
  unavailable: "暂时加载不出来", retry: "重试", rate: "访问有点频繁，稍后自动刷新",
  company: "营收与利润", capital: "财务报表", findings: "信号", fundamentals: "基本面", events: "事件", filings: "财报", valuation: "估值",
});
export function RateNotice() { return <p className="module-failure" role="status">{m.rate}</p>; }
export function ModuleFailure({ resource, retry }: { resource: MapResource; retry: (resource: MapResource) => void }) {
  return <section className="module-failure" data-module={resource} aria-label={m[resource]}>
    <strong>{m[resource]}</strong><span role="status">{m.unavailable}</span><button type="button" onClick={() => retry(resource)}>{m.retry}</button>
  </section>;
}
