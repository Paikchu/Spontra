import type { ReactNode } from "react";
import { getLocale, messages } from "@/packages/web/src/i18n";
import { qoqLabel, yoyLabel } from "@/shared/analysis-runtime/locale";
import { Rail } from "./Sidebar";
import { VIEW_LABEL } from "./findings-labels";

const m = messages({
  companyBusinesses: "Company businesses", loading: "Loading", allBusinesses: "All businesses", findings: "Findings", events: "Filings and events",
  summary: "Summary", detail: "Detail", revenue: "Revenue", businessRevenue: "Business revenue", profit: "Profit", costs: "Costs and expenses",
}, {
  companyBusinesses: "公司业务", loading: "加载中", allBusinesses: "全部业务", findings: "要点", events: "文件与事件",
  summary: "概要", detail: "明细", revenue: "营收", businessRevenue: "业务营收", profit: "利润", costs: "成本与费用",
});

/** Same boxes as the loaded map: closed rail digest, head, chart, timeline, trend and footer. Text is a shimmer in the real line metrics. */
export function CompanySkeleton({ ticker, tools }: { ticker: string; tools: ReactNode }) {
  return (
    <div className="map map--loading" role="status" aria-label={m.loading} aria-busy="true">
      <Rail ticker={ticker} actions={tools} label={m.companyBusinesses}>
        <section className="findings" data-section="business" aria-hidden="true">
          <div className="rail-list section-body">
            <div className="row row--all"><i className="row-chip row-chip--all" aria-hidden="true" /><span className="row-name ghost-text">{m.allBusinesses}</span></div>
            {[0, 1, 2].map(i => <div key={i} className="row" data-depth="0" data-extra=""><i className="row-chip" aria-hidden="true" /><span className="row-name ghost-text">{m.allBusinesses}</span></div>)}
          </div>
        </section>
        <CompanyDetailsSkeleton />
      </Rail>
      <section className="stage" data-timeline="" data-view="profit" data-trend="" aria-hidden="true">
        <div className="stage-tabs"><span className="trend-views stage-views">{(["valuation", "profit", "cash", "balance"] as const).map(v => <button key={v} type="button" tabIndex={-1} aria-checked="false">{VIEW_LABEL[v]}</button>)}</span></div>
        <header className="stage-head stage-head--summary">
          <div className="stats">
            {[0, 1, 2, 3].map(i => <div key={i} className="stat"><span className="stat-label ghost-text">{m.revenue}</span><strong className="stat-value ghost-text">$00.0B</strong></div>)}
          </div>
          <div className="stage-controls">
            <span className="trend-views stage-views"><button type="button" tabIndex={-1} aria-checked="true">{yoyLabel(getLocale())}</button><button type="button" tabIndex={-1} aria-checked="false">{qoqLabel(getLocale())}</button></span>
            <span className="trend-views stage-views"><button type="button" tabIndex={-1} aria-checked="true">{m.summary}</button><button type="button" tabIndex={-1} aria-checked="false">{m.detail}</button></span>
          </div>
        </header>
        <div className="chart"><div className="ghost-chart" /></div>
        <div className="timeline"><div className="timeline-track" /></div>
        <div className="trend" data-view="trend">
          <div className="trend-head"><div className="trend-title"><h2 className="ghost-text">{m.revenue}</h2><div className="trend-legend"><span className="ghost-text">{m.businessRevenue}</span><span className="ghost-text">{m.profit}</span></div></div></div>
          <div className="trend-plot" />
        </div>
        <footer className="stage-foot">
          <div className="legend"><span className="ghost-text">{m.businessRevenue}</span><span className="ghost-text">{m.profit}</span><span className="ghost-text">{m.costs}</span></div>
          <p className="provenance"><span className="ghost-text">{m.loading}</span></p>
        </footer>
      </section>
    </div>
  );
}

/** Reserve the two side sections while the primary view is already usable. */
export function CompanyDetailsSkeleton() {
  return <div className="company-details-loading" aria-busy="true" aria-label={m.loading}>
        <section className="findings" data-section="findings" aria-hidden="true">
          <header className="findings-head"><span className="findings-title ghost-text">{m.findings}</span></header>
          <div className="findings-rows section-body">
            {[0, 1, 2].map(i => <div key={i} className="finding-row"><i className="finding-mark" aria-hidden="true" /><span className="finding-title ghost-text">{m.findings}</span></div>)}
          </div>
        </section>
        <section className="findings" data-section="events" aria-hidden="true">
          <header className="findings-head"><span className="findings-title ghost-text">{m.events}</span></header>
          <div className="event-filters">{[0, 1, 2, 3, 4].map(i => <span key={i} className="event-filter event-filter--ghost" />)}</div>
          <div className="findings-rows section-body">
            {[0, 1, 2, 3, 4].map(i => <div key={i} className="finding-row event-row"><time className="event-date ghost-text">00.00</time><span className="finding-title ghost-text">{m.events}</span></div>)}
          </div>
        </section>
  </div>;
}
