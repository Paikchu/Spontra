import { Button } from "@/packages/web/src/ui/button";
import React, { useMemo, useState, type CSSProperties } from "react";
import type { CompanyEvent, EventsPublication } from "@/shared/analysis-contract/events";
import { INSIDER_RULES } from "@/shared/analysis-runtime/events";
import { EVENT_CLASS_LABEL, dollars, eventTitle, insiderLens, shares, shortDate, type InsiderLensModel } from "./events-model";

const ITEM_LABEL: Record<string, string> = {
  "1.01": "重大协议", "1.02": "协议终止", "1.05": "网络安全事件", "2.01": "完成收购或处置", "2.02": "业绩发布", "2.03": "新增债务", "2.04": "触发加速偿还", "2.05": "退出成本",
  "2.06": "重大减值", "3.01": "退市通知", "3.02": "非注册股权发行", "3.03": "股东权利修改", "4.01": "更换审计师", "4.02": "财报不可依赖", "5.01": "控制权变更", "5.02": "董事高管变动",
  "5.03": "章程修订", "5.07": "股东投票结果", "7.01": "Reg FD 披露", "8.01": "其他事项", "9.01": "附件",
};

/**
 * The event in focus, in the lens's place: its figures or chart on the left, what it says and
 * where it was filed on the right. Nothing here is written by a model except the filing's own
 * summary, which is labelled as such; the verdict on an insider sale is a rule, shown with its rule.
 */
export function EventLens({ event, publication, onClose, onStep, index, count }: {
  event: CompanyEvent;
  publication: EventsPublication;
  onClose: () => void;
  onStep: (delta: 1 | -1) => void;
  index: number;
  count: number;
}) {
  const insider = useMemo(() => insiderLens(publication, event), [publication, event]);
  const [showQuiet, setShowQuiet] = useState(false);
  return <section className="lens event-lens" data-class={event.class} aria-label={`事件：${eventTitle(event)}`} key={event.id}>
    <header className="lens-head">
      <div className="lens-title">
        <b className="lens-kind event-kind">{EVENT_CLASS_LABEL[event.class]}</b>
        <h2>{eventTitle(event)}</h2>
        <span className="lens-basis">{event.form} · 申报 {event.filedAt}{event.eventDate !== event.filedAt ? ` · 事件 ${event.eventDate}` : ""}</span>
      </div>
      <div className="lens-nav">
        <span className="lens-steps"><Button variant="unstyled" type="button" aria-label="较新事件" disabled={index <= 0} onClick={() => onStep(-1)}>‹</Button><span>{index + 1} / {count}</span><Button variant="unstyled" type="button" aria-label="较早事件" disabled={index >= count - 1} onClick={() => onStep(1)}>›</Button></span>
        <Button variant="unstyled" type="button" className="lens-close" aria-label="关闭事件" onClick={onClose}>✕</Button>
      </div>
    </header>
    <div className="lens-body">
      <div className="lens-chart">
        {insider ? <InsiderLadder model={insider} event={event} /> : <Facts event={event} />}
      </div>
      <div className="lens-text">
        {insider && <InsiderReading model={insider} event={event} />}
        {event.summary ? <>
          <p className="lens-judgment">{event.summary.headline}</p>
          <ul className="event-bullets">{event.summary.bullets.map((b, i) => <li key={i} data-importance={b.importance}><b>{b.label}</b>{b.detail}</li>)}</ul>
          {event.summary.analystView && <p className="event-view"><b>投资含义</b>{event.summary.analystView}</p>}
          <p className="event-generated">摘要由模型生成于 {event.summary.generatedAt.slice(0, 10)}，数字以原文为准</p>
        </> : !insider && <p className="lens-empty">该申报尚无摘要。类别由 8-K 条款编号确定；详情见原文。</p>}
        {insider && insider.path.length > 0 && event.insider!.footnotes.length > 0 && <details className="event-footnotes" open={showQuiet} onToggle={e => setShowQuiet((e.target as HTMLDetailsElement).open)}>
          <summary>申报脚注 {event.insider!.footnotes.length} 条</summary>
          <ol>{event.insider!.footnotes.map((f, i) => <li key={i}>{f}</li>)}</ol>
        </details>}
        <ol className="sources sources--numbered">
          <li><a href={event.edgarUrl} target="_blank" rel="noopener noreferrer">EDGAR 申报索引<span aria-hidden="true"> ↗</span></a></li>
          <li><a href={event.documentUrl} target="_blank" rel="noopener noreferrer">{event.form} 原文<span aria-hidden="true"> ↗</span></a></li>
          {event.exhibits.map(x => <li key={x.url}><a href={x.url} target="_blank" rel="noopener noreferrer">{x.type} · {x.title}<span aria-hidden="true"> ↗</span></a></li>)}
        </ol>
      </div>
    </div>
  </section>;
}

/** A current report's facts: the item codes it was filed under, in words, and what the primary document is. */
function Facts({ event }: { event: CompanyEvent }) {
  return <dl className="event-facts">
    <div><dt>申报类型</dt><dd>{event.form}</dd></div>
    <div><dt>事件日期</dt><dd>{event.eventDate}</dd></div>
    {event.items.length > 0 && <div><dt>条款</dt><dd>{event.items.map(i => <span key={i} className="event-item">Item {i}<small>{ITEM_LABEL[i] ?? ""}</small></span>)}</dd></div>}
    {event.description && <div><dt>文件</dt><dd>{event.description}</dd></div>}
    {event.exhibits.length > 0 && <div><dt>附件</dt><dd>{event.exhibits.map(x => x.type).join("、")}</dd></div>}
    {event.summary?.eventCategory && <div><dt>摘要分类</dt><dd>{event.summary.eventCategory}</dd></div>}
  </dl>;
}

/** The reading of one Form 4 against the owner's own history and the other insiders, with the rule that decided it. */
function InsiderReading({ model, event }: { model: InsiderLensModel; event: CompanyEvent }) {
  const t = event.insider!;
  const role = [t.title, t.isDirector ? "董事" : null, t.isTenPercentOwner ? "10% 股东" : null].filter(Boolean).join(" · ") || "申报人";
  return <>
    <p className="lens-judgment event-verdict" data-verdict={model.verdict.label}>
      <b>{model.verdict.label}</b>{t.ownerName}（{role}）{t.sold ? `卖出 ${shares(t.sold.shares)}，均价 $${t.sold.averagePrice.toFixed(2)}，共 ${dollars(t.sold.proceeds)}` : t.bought ? `买入 ${shares(t.bought.shares)}，共 ${dollars(t.bought.cost)}` : t.exercised ? `行权 ${shares(t.exercised)}，未卖出` : "持股变动，未交易"}。
    </p>
    <ul className="event-rules">{model.verdict.rules.map((r, i) => <li key={i}>{r}</li>)}</ul>
    <dl className="lens-evidence">
      {t.sold && <div className="lens-row"><dt>占交易前持股</dt><dd><b>{model.share != null ? `${model.share.toFixed(1)}%` : "—"}</b><em>阈值 {INSIDER_RULES.attentionShare}%</em></dd></div>}
      <div className="lens-row"><dt>交易后直接持股</dt><dd><b>{t.heldAfter != null ? shares(t.heldAfter) : "未披露"}</b></dd></div>
      <div className="lens-row"><dt>10b5-1 计划</dt><dd><b>{t.rule10b51 === true ? "是" : t.rule10b51 === false ? "否" : "表单未标注"}</b>{t.planAdoptedOn && <em>采用于 {t.planAdoptedOn}</em>}</dd></div>
      <div className="lens-row"><dt>近 12 个月卖出</dt><dd><b>{model.cadence.sales.length} 次 · {shares(model.cadence.totalShares)}</b><em>{model.cadence.intervalDays != null ? `间隔约 ${Math.round(model.cadence.intervalDays)} 天${model.cadence.regular ? " · 节奏稳定" : ""}` : "无可比间隔"} · 共 {dollars(model.cadence.totalProceeds)}</em></dd></div>
      <div className="lens-row"><dt>同期其他内部人卖出</dt><dd><b>{model.cluster.length} 人</b><em>{INSIDER_RULES.clusterDays} 天内</em></dd></div>
    </dl>
    {model.cluster.length > 0 && <ul className="event-cluster">{model.cluster.map(c => <li key={c.id}><span>{c.ownerName}{c.title ? ` · ${c.title}` : ""}</span><span>{shortDate(c.date)} · {dollars(c.proceeds)}</span></li>)}</ul>}
  </>;
}

/**
 * The owner's holding over the trailing two years as a staircase: each filing's held-after figure
 * is a step, a sale drops it, an exercise or purchase lifts it. Dots mark sales, sized by proceeds,
 * hollow when the filing says the trade ran under a 10b5-1 plan. The focused filing is lit.
 */
function InsiderLadder({ model, event }: { model: InsiderLensModel; event: CompanyEvent }) {
  const path = model.path;
  if (path.length < 2) return <div className="lens-empty">{event.insider!.ownerName} 在窗口内只有这一次申报，持股路径暂不可画。<br />{event.insider!.heldAfter != null ? `交易后持股 ${shares(event.insider!.heldAfter)}` : ""}</div>;
  const held = path.map(p => p.held);
  // A large holder's sales are small against the holding, so the scale hugs the path rather than starting at zero.
  const peak = Math.max(...held, ...path.map(p => p.held + p.sold)), low = Math.min(...held);
  const top = peak + (peak - low) * 0.08, bottom = Math.max(0, low - (peak - low) * 0.15);
  const range = top - bottom || 1;
  const t0 = Date.parse(path[0].date), t1 = Date.parse(path[path.length - 1].date);
  const span = Math.max(t1 - t0, 30 * 86_400_000);
  const x = (d: string) => 4 + (Date.parse(d) - t0) / span * 92;
  const y = (v: number) => 92 - (v - bottom) / range * 84;
  // The staircase: hold flat from each filing to the next, then step to the new level.
  const d = path.map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(2)},${y(i ? path[i - 1].held : p.held + p.sold - p.bought - p.exercised).toFixed(2)}L${x(p.date).toFixed(2)},${y(p.held).toFixed(2)}`).join("") + `L96,${y(path[path.length - 1].held).toFixed(2)}`;
  const maxProceeds = Math.max(1, ...model.cadence.sales.map(s => s.proceeds), ...path.map(p => p.sold * (event.insider!.sold?.averagePrice ?? 0)));
  const sales = path.filter(p => p.sold > 0);
  return <div className="insider-ladder" role="img" aria-label={`${event.insider!.ownerName} 的持股路径，${path[0].date} 至 ${path[path.length - 1].date}，${sales.length} 次卖出`}>
    <div className="lens-legend"><span><i className="ladder-step" />直接持股</span><span><i className="ladder-dot" />卖出（面积 = 金额）</span><span><i className="ladder-dot ladder-dot--planned" />10b5-1 计划</span></div>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {[0.25, 0.5, 0.75].map(t => <line key={t} className="ladder-grid" x1="4" x2="96" y1={8 + t * 84} y2={8 + t * 84} vectorEffect="non-scaling-stroke" />)}
      <path className="ladder-path" d={d} vectorEffect="non-scaling-stroke" />
    </svg>
    <div className="ladder-marks">
      {sales.map(p => {
        const proceeds = model.cadence.sales.find(s => s.id === p.id)?.proceeds ?? 0;
        const size = 8 + Math.sqrt(Math.max(proceeds, 1) / maxProceeds) * 18;
        return <i key={p.id} className="ladder-dot" data-planned={p.planned === true || undefined} data-focus={p.id === event.id || undefined}
          style={{ left: `${x(p.date)}%`, top: `${y(p.held)}%`, width: size, height: size } as CSSProperties} title={`${p.date} 卖出 ${shares(p.sold)} · ${dollars(proceeds)}`} />;
      })}
    </div>
    <div className="lens-axis"><span style={{ left: "4%" }} data-edge="start">{path[0].date.slice(0, 7).replace("-", ".")}</span><span style={{ left: "96%" }} data-edge="end">{path[path.length - 1].date.slice(0, 7).replace("-", ".")}</span></div>
    <div className="ladder-scale"><span>{shares(top)}</span><span>{shares(bottom)}</span></div>
  </div>;
}
