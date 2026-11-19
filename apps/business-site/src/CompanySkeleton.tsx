import type { ReactNode } from "react";
import { getLocale, messages } from "@/packages/web/src/i18n";
import { qoqLabel, yoyLabel } from "@/shared/analysis-runtime/locale";
import { CompanyMark } from "./CompanyMark";
import { Rail } from "./Sidebar";
import { VIEW_LABEL } from "./findings-labels";

const m = messages({
  companyBusinesses: "Company businesses", loading: "Loading", allBusinesses: "All businesses",
  findings: "Company research", tabReports: "Reports", tabManagement: "Management", ask: "Ask",
  summary: "Summary", detail: "Detail",
  scores: "Five-dimension research score", valuationCore: "Core valuation & price range",
}, {
  companyBusinesses: "公司业务", loading: "加载中", allBusinesses: "全部业务",
  findings: "公司专题", tabReports: "财报", tabManagement: "管理层动态", ask: "提问",
  summary: "概要", detail: "明细",
  scores: "五维研究评分", valuationCore: "核心估值与价格区间",
});

type SkeletonView = "valuation" | "company" | "profit" | "cash" | "balance" | "lens";
const SKELETON_TABS = ["valuation", "company", "profit", "cash", "balance"] as const;

function openingSkeletonView(): SkeletonView {
  if (typeof location === "undefined") return "profit";
  const params = new URLSearchParams(location.search);
  if (params.has("finding") || params.has("report") || params.has("event")) return "lens";
  const view = params.get("view");
  if (view === "valuation" || view === "company" || view === "cash" || view === "balance" || view === "profit") return view;
  return "profit";
}

/** Pentagon radar outline matching the real five-dimension radar geometry while valuation data loads. */
function RadarSkeleton() {
  const cx = 120, cy = 112, r = 64;
  const ring = (scale: number) => Array.from({ length: 5 }, (_, i) => {
    const a = (-Math.PI / 2) + (i * 2 * Math.PI) / 5;
    return `${(cx + Math.cos(a) * r * scale).toFixed(1)},${(cy + Math.sin(a) * r * scale).toFixed(1)}`;
  }).join(" ");
  const spokes = Array.from({ length: 5 }, (_, i) => {
    const a = (-Math.PI / 2) + (i * 2 * Math.PI) / 5;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });
  return (
    <div className="skel-radar" aria-hidden="true">
      <svg viewBox="0 0 240 224" className="skel-radar-svg">
        {[0.33, 0.66, 1].map(scale => <polygon key={scale} points={ring(scale)} className="skel-radar-ring" />)}
        {spokes.map((pt, i) => <line key={i} x1={cx} y1={cy} x2={pt.x} y2={pt.y} className="skel-radar-axis" />)}
        <polygon points={ring(0.56)} className="skel-radar-fill" />
      </svg>
    </div>
  );
}

/** Stage skeleton aligned to the Valuation assessment layout (five-dimension radar + core valuation strip). */
export function ValuationSkeleton() {
  return (
    <div className="lens-stage" aria-busy="true" aria-label={m.loading}>
      <section className="lens val-panel skel-val" aria-hidden="true">
        <div className="skel-val-section">
          <div className="skel-val-heading">
            <i className="skel-val-accent" />
            <span className="skel-bar" style={{ width: "124px", height: "18px" }} />
          </div>
          <div className="skel-val-scores">
            <RadarSkeleton />
            <div className="skel-val-detail">
              <div className="skel-val-pills">
                {[82, 86, 82, 92, 82].map((w, i) => <span key={i} className={`skel-val-pill${i === 1 ? " skel-val-pill--active" : ""}`} style={{ width: `${w}px` }} />)}
              </div>
              <div className="skel-val-dimhead">
                <span className="skel-bar" style={{ width: "152px", height: "16px" }} />
                <span className="skel-bar" style={{ width: "44px", height: "18px" }} />
              </div>
              <div className="skel-lines">
                <span className="skel-bar" style={{ width: "98%" }} />
                <span className="skel-bar" style={{ width: "94%" }} />
                <span className="skel-bar" style={{ width: "96%" }} />
                <span className="skel-bar" style={{ width: "78%" }} />
              </div>
              <div className="skel-lines skel-lines--note">
                <span className="skel-bar" style={{ width: "86%" }} />
                <span className="skel-bar" style={{ width: "72%" }} />
              </div>
            </div>
          </div>
        </div>
        <div className="skel-val-section skel-val-section--bordered">
          <div className="skel-val-heading">
            <i className="skel-val-accent" />
            <span className="skel-bar" style={{ width: "156px", height: "18px" }} />
          </div>
          <div className="skel-val-kpis">
            {[164, 118, 92, 96].map((w, i) => (
              <div key={i} className="skel-val-kpi">
                <span className="skel-bar" style={{ width: "92px", height: "12px" }} />
                <span className="skel-bar" style={{ width: `${w}px`, height: "26px" }} />
                <span className="skel-bar" style={{ width: "112px", height: "12px" }} />
              </div>
            ))}
          </div>
          <div className="skel-val-range">
            <span className="skel-bar" style={{ width: "116px", height: "13px" }} />
            <span className="skel-bar" style={{ width: "156px", height: "14px" }} />
          </div>
        </div>
      </section>
    </div>
  );
}

/** Stage skeleton aligned to a single-column document view (company analysis or finding/filing lens). */
export function DocumentSkeleton() {
  return (
    <div className="lens-stage" aria-busy="true" aria-label={m.loading}>
      <section className="lens skel-doc" aria-hidden="true">
        <header className="lens-head">
          <div className="lens-title skel-doc-title">
            <span className="skel-bar" style={{ width: "72px", height: "14px" }} />
            <span className="skel-bar" style={{ width: "min(420px, 72%)", height: "26px" }} />
            <span className="skel-bar" style={{ width: "180px", height: "13px" }} />
          </div>
        </header>
        <div className="lens-doc">
          <div className="skel-lines">
            <span className="skel-bar" style={{ width: "96%" }} />
            <span className="skel-bar" style={{ width: "92%" }} />
            <span className="skel-bar" style={{ width: "84%" }} />
          </div>
          <div className="skel-doc-block" />
          <div className="skel-lines">
            <span className="skel-bar" style={{ width: "94%" }} />
            <span className="skel-bar" style={{ width: "88%" }} />
            <span className="skel-bar" style={{ width: "68%" }} />
          </div>
        </div>
      </section>
    </div>
  );
}

/** Flow/pool statement silhouette matching the Sankey and quarterly trend proportions. */
function StatementChartSkeleton() {
  return (
    <div className="skel-flow" aria-hidden="true">
      <div className="skel-flow-col">
        <span className="skel-flow-bar" style={{ height: "52%" }} />
        <span className="skel-flow-bar" style={{ height: "28%" }} />
      </div>
      <div className="skel-flow-band" />
      <div className="skel-flow-col">
        <span className="skel-flow-bar skel-flow-bar--trunk" style={{ height: "82%" }} />
      </div>
      <div className="skel-flow-band" />
      <div className="skel-flow-col">
        <span className="skel-flow-bar" style={{ height: "42%" }} />
        <span className="skel-flow-bar" style={{ height: "34%" }} />
      </div>
    </div>
  );
}

/**
 * Same frame and view geometry as the loaded page: rail header, businesses, research guidance,
 * stream filter tabs, quarter timeline, bottom Ask slot, 5-tab stage bar, and view-matched stage body.
 */
export function CompanySkeleton({ ticker, tools }: { ticker: string; tools: ReactNode }) {
  const view = openingSkeletonView();
  const statement = view === "profit" || view === "cash" || view === "balance";
  const stageView = view === "lens" ? "profit" : view;
  const foot = (
    <div className="ask-entry skel-ask" aria-hidden="true">
      <span className="ask-open">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 4v-4h0A2 2 0 0 1 4 14Z" /></svg>
        <span>{m.ask}</span>
      </span>
    </div>
  );
  return (
    <div className="map map--loading" role="status" aria-label={m.loading} aria-busy="true">
      <Rail ticker={ticker} actions={tools} label={m.companyBusinesses} foot={foot}>
        <section className="biz" data-section="business" aria-hidden="true">
          <div className="biz-head">
            <span className="biz-total">
              <CompanyMark ticker={ticker} />
              <span className="biz-total-metrics">
                <span className="skel-bar skel-bar--total" />
                <span className="skel-bar skel-bar--delta" />
              </span>
            </span>
            <span className="icon-button biz-fold"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg></span>
          </div>
          <div className="biz-rows">
            <div className="rail-list section-body">
              <div className="row row--all"><i className="row-chip row-chip--all" aria-hidden="true" /><span className="row-name">{m.allBusinesses}</span></div>
              {[0, 1].map(i => (
                <div key={i} className="row" data-depth="0">
                  <i className="row-chip" aria-hidden="true" />
                  <span className="row-name"><span className="skel-bar" style={{ width: i === 0 ? "82%" : "64%", height: "13px" }} /></span>
                  <span className="row-value"><span className="skel-bar" style={{ width: "48px", height: "13px" }} /></span>
                  <span className="row-delta"><span className="skel-bar" style={{ width: "42px", height: "11px" }} /></span>
                </div>
              ))}
            </div>
          </div>
        </section>
        <CompanyDetailsSkeleton />
      </Rail>

      <section className="stage" data-view={stageView} data-trend={statement ? "" : undefined} aria-hidden="true">
        {view !== "lens" && (
          <div className="stage-tabs">
            <span className="trend-views stage-views">
              {SKELETON_TABS.map(v => (
                <button key={v} type="button" role="radio" tabIndex={-1} aria-checked={v === view}>{VIEW_LABEL[v]}</button>
              ))}
            </span>
          </div>
        )}
        {view === "valuation" ? <ValuationSkeleton />
          : view === "company" || view === "lens" ? <DocumentSkeleton />
          : <>
            <header className="stage-head stage-head--summary">
              <div className="stats">
                {[118, 96, 108, 92].map((w, i) => (
                  <div key={i} className="stat">
                    <span className="stat-label"><span className="skel-bar" style={{ width: "68px", height: "12px" }} /></span>
                    <strong className="stat-value"><span className="skel-bar" style={{ width: `${w}px`, height: "26px" }} /></strong>
                  </div>
                ))}
              </div>
              {view === "profit" && (
                <div className="stage-controls">
                  <span className="trend-views stage-views">
                    <button type="button" role="radio" tabIndex={-1} aria-checked="true">{yoyLabel(getLocale())}</button>
                    <button type="button" role="radio" tabIndex={-1} aria-checked="false">{qoqLabel(getLocale())}</button>
                  </span>
                  <span className="trend-views stage-views">
                    <button type="button" role="radio" tabIndex={-1} aria-checked="true">{m.summary}</button>
                    <button type="button" role="radio" tabIndex={-1} aria-checked="false">{m.detail}</button>
                  </span>
                </div>
              )}
            </header>
            <div className="chart"><StatementChartSkeleton /></div>
            <div className="trend" data-view="trend">
              <div className="trend-head">
                <div className="trend-title">
                  <span className="skel-bar" style={{ width: "112px", height: "16px" }} />
                  <div className="trend-legend">
                    <span className="skel-bar" style={{ width: "64px", height: "12px" }} />
                    <span className="skel-bar" style={{ width: "52px", height: "12px" }} />
                  </div>
                </div>
              </div>
              <div className="trend-plot skel-trend-plot">
                {[38, 46, 52, 58, 64, 72, 80, 92].map((h, i) => (
                  <div key={i} className="trend-col">
                    <span className="skel-trend-bar" style={{ height: `${h}%` }} />
                  </div>
                ))}
              </div>
            </div>
          </>}
      </section>
    </div>
  );
}

/** Reserves the rail's research guidance, filter tabs and quarter timeline while primary data loads. */
export function CompanyDetailsSkeleton() {
  return (
    <div className="company-details-loading" aria-busy="true" aria-label={m.loading}>
      <section className="stream" data-section="stream" aria-hidden="true">
        <div className="guidance">
          <div className="guidance-head"><h3>{m.findings}</h3></div>
          {[74, 92, 66].map((w, i) => (
            <div key={i} className="stream-row finding-row">
              <span className="stream-mark"><i className="skel-dot" /></span>
              <span className="stream-body">
                <span className="skel-bar" style={{ width: `${w}%`, height: "14px" }} />
                <span className="skel-bar" style={{ width: "48%", height: "11px" }} />
              </span>
            </div>
          ))}
        </div>
        <div className="stream-tabs">
          <div data-slot="toggle-group">
            <span data-slot="toggle-group-item" data-state="on">{m.tabReports}</span>
            <span data-slot="toggle-group-item" data-state="on">{m.tabManagement}</span>
          </div>
        </div>
        <QuarterTimelineSkeleton />
      </section>
    </div>
  );
}

/** Reserves the quarter-grouped filings and events stream below the filter tabs while events/filings settle. */
export function QuarterTimelineSkeleton() {
  return (
    <div className="stream-rows" aria-hidden="true">
      <div className="quarter-frame">
        <div className="quarter-frame-head">
          <span className="skel-bar" style={{ width: "86px", height: "13px" }} />
          <span className="skel-bar" style={{ width: "78px", height: "12px" }} />
        </div>
        {[88, 94, 72, 82].map((w, i) => (
          <div key={i} className="stream-row">
            <span className="stream-mark"><i className="skel-dot" /></span>
            <span className="stream-body">
              <span className="skel-bar" style={{ width: `${w}%`, height: "14px" }} />
              <span className="skel-bar" style={{ width: `${46 + (i % 3) * 14}%`, height: "11px" }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
