import { Button } from "@/packages/web/src/ui/button";
import { useMemo, useState, type CSSProperties } from "react";
import type { CompanyEvent, EventsPublication } from "@/shared/analysis-contract/events";
import { INSIDER_RULES } from "@/shared/analysis-runtime/events";
import { getLocale, labels, messages } from "@/packages/web/src/i18n";
import { SourceLanguage } from "@/packages/web/src/i18n/SourceLanguage";
import { perShare, shortPeriod } from "@/shared/analysis-runtime/locale";
import { EVENT_CLASS_LABEL, dollars, eventTitle, eventTitleLang, insiderLens, shares, shortDate, type InsiderLensModel } from "./events-model";

const ITEM_LABEL = labels({
  "1.01": "Material agreement", "1.02": "Agreement terminated", "1.05": "Cybersecurity incident", "2.01": "Acquisition or disposition completed", "2.02": "Results of operations", "2.03": "New financial obligation", "2.04": "Acceleration triggered", "2.05": "Exit costs",
  "2.06": "Material impairment", "3.01": "Delisting notice", "3.02": "Unregistered equity sale", "3.03": "Rights of holders modified", "4.01": "Auditor change", "4.02": "Non-reliance on financials", "5.01": "Change in control", "5.02": "Director or officer change",
  "5.03": "Bylaw amendment", "5.07": "Shareholder vote results", "7.01": "Reg FD disclosure", "8.01": "Other events", "9.01": "Exhibits",
}, {
  "1.01": "重大协议", "1.02": "协议终止", "1.05": "网络安全事件", "2.01": "完成收购或处置", "2.02": "经营业绩", "2.03": "新增财务义务", "2.04": "触发加速偿付", "2.05": "退出成本",
  "2.06": "重大减值", "3.01": "退市通知", "3.02": "未注册股权出售", "3.03": "持有人权利变更", "4.01": "更换审计师", "4.02": "财务报表不可依赖", "5.01": "控制权变更", "5.02": "董事或高管变动",
  "5.03": "章程修订", "5.07": "股东投票结果", "7.01": "Reg FD 披露", "8.01": "其他事项", "9.01": "附件",
}) as Record<string, string | undefined>;

/** The summary's category: English keeps the raw value it has always shown. */
const CATEGORY = labels<NonNullable<NonNullable<CompanyEvent["summary"]>["eventCategory"]>>(
  { earnings_update: "earnings_update", guidance: "guidance", "m&a": "m&a", executive: "executive", legal: "legal", other: "other" },
  { earnings_update: "业绩更新", guidance: "业绩指引", "m&a": "并购", executive: "管理层", legal: "法律", other: "其他" });

const m = messages({
  event: (title: string) => `Event: ${title}`, filed: "Filed", eventOn: "Event", newer: "Newer event", older: "Older event", close: "Close event",
  analystView: "Analyst view", aiSummary: "AI summary", noSummary: "No summary",
  footnotes: (n: number) => `${n} filing ${n === 1 ? "footnote" : "footnotes"}`, edgarIndex: "EDGAR filing index", filing: (form: string) => `${form} filing`,
  form: "Form", eventDate: "Event date", items: "Items", item: (code: string) => `Item ${code}`, document: "Document", exhibits: "Exhibits", summaryCategory: "Summary category",
  director: "Director", tenPercent: "10% owner", filer: "Filer", role: "Role", sharesSold: "Shares sold", avgPrice: "Avg price", proceeds: "Proceeds",
  sharesBought: "Shares bought", cost: "Cost", sharesExercised: "Shares exercised", priorShare: "Share of prior holding", threshold: (n: number) => `Threshold ${n}%`,
  heldAfter: "Direct holding after", notDisclosed: "Not disclosed", plan: "10b5-1 plan", yes: "Yes", no: "No", notMarked: "Not marked",
  adopted: (date: string) => `Adopted ${date}`, salesYear: "Sales, last 12 months", sales: (n: number) => `${n} ${n === 1 ? "sale" : "sales"}`,
  interval: (days: number) => `Interval ~${days} days`, steady: " · Steady cadence", noInterval: "Interval —", total: (amount: string) => `Total ${amount}`,
  otherSellers: "Other insiders selling", people: (n: number) => `${n} ${n === 1 ? "person" : "people"}`, window: (days: number) => `${days}-day window`,
  singleFiling: "Single filing", path: (owner: string, from: string, to: string, sales: number) => `${owner} holding path, ${from} to ${to}, ${sales} ${sales === 1 ? "sale" : "sales"}`,
  directHolding: "Direct holding", sale: "Sale",
}, {
  event: (title: string) => `事件：${title}`, filed: "提交日期", eventOn: "事件日期", newer: "较新事件", older: "较早事件", close: "关闭事件",
  analystView: "分析观点", aiSummary: "AI 摘要", noSummary: "无摘要",
  footnotes: (n: number) => `文件脚注 ${n} 条`, edgarIndex: "EDGAR 文件索引", filing: (form: string) => `${form} 文件`,
  form: "文件类型", eventDate: "事件日期", items: "事项", item: (code: string) => `Item ${code}`, document: "文档", exhibits: "附件", summaryCategory: "摘要类别",
  director: "董事", tenPercent: "10% 股东", filer: "申报人", role: "身份", sharesSold: "卖出股数", avgPrice: "均价", proceeds: "卖出金额",
  sharesBought: "买入股数", cost: "买入金额", sharesExercised: "行权股数", priorShare: "占交易前持股", threshold: (n: number) => `阈值 ${n}%`,
  heldAfter: "交易后直接持股", notDisclosed: "未披露", plan: "10b5-1 交易计划", yes: "是", no: "否", notMarked: "未标注",
  adopted: (date: string) => `订立于 ${date}`, salesYear: "近 12 个月卖出", sales: (n: number) => `${n} 次`,
  interval: (days: number) => `间隔约 ${days} 天`, steady: " · 节奏稳定", noInterval: "间隔 —", total: (amount: string) => `合计 ${amount}`,
  otherSellers: "其他内部人卖出", people: (n: number) => `${n} 人`, window: (days: number) => `${days} 天窗口`,
  singleFiling: "仅一份文件", path: (owner: string, from: string, to: string, sales: number) => `${owner} 持股路径，${from} 至 ${to}，卖出 ${sales} 次`,
  directHolding: "直接持股", sale: "卖出",
});

/**
 * The event in focus, in the lens's place: its figures or chart on the left, what it says and
 * where it was filed on the right. Nothing here is written by a model except the filing's own
 * summary, which is labelled as such; the tag on an insider sale is rule-based.
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
  return <section className="lens event-lens" data-class={event.class} aria-label={m.event(eventTitle(event))} key={event.id}>
    <header className="lens-head">
      <div className="lens-title">
        <b className="lens-kind event-kind">{EVENT_CLASS_LABEL[event.class]}</b>
        {(event.summary || eventTitleLang(event)) && <SourceLanguage />}
        <h2 lang={eventTitleLang(event)}>{eventTitle(event)}</h2>
        <span className="lens-basis">{event.form} · {m.filed} {event.filedAt}{event.eventDate !== event.filedAt ? ` · ${m.eventOn} ${event.eventDate}` : ""}</span>
      </div>
      <div className="lens-nav">
        <span className="lens-steps"><Button variant="unstyled" type="button" aria-label={m.newer} disabled={index <= 0} onClick={() => onStep(-1)}>‹</Button><span>{index + 1} / {count}</span><Button variant="unstyled" type="button" aria-label={m.older} disabled={index >= count - 1} onClick={() => onStep(1)}>›</Button></span>
        <Button variant="unstyled" type="button" className="lens-close" aria-label={m.close} onClick={onClose}>✕</Button>
      </div>
    </header>
    <div className="lens-body">
      <div className="lens-chart">
        {insider ? <InsiderLadder model={insider} event={event} /> : <Facts event={event} />}
      </div>
      <div className="lens-text">
        {insider && <InsiderReading model={insider} event={event} />}
        {event.summary ? <>
          <p className="lens-judgment" lang="en">{event.summary.headline}</p>
          <ul className="event-bullets" lang="en">{event.summary.bullets.map((b, i) => <li key={i} data-importance={b.importance}><b>{b.label}</b>{b.detail}</li>)}</ul>
          {event.summary.analystView && <p className="event-view"><b>{m.analystView}</b><span lang="en">{event.summary.analystView}</span></p>}
          <p className="event-generated">{m.aiSummary} · {event.summary.generatedAt.slice(0, 10)}</p>
        </> : !insider && <p className="lens-empty">{m.noSummary}</p>}
        {insider && insider.path.length > 0 && event.insider!.footnotes.length > 0 && <details className="event-footnotes" open={showQuiet} onToggle={e => setShowQuiet((e.target as HTMLDetailsElement).open)}>
          <summary>{m.footnotes(event.insider!.footnotes.length)}</summary>
          <ol lang="en">{event.insider!.footnotes.map((f, i) => <li key={i}>{f}</li>)}</ol>
        </details>}
        <ol className="sources sources--numbered">
          <li><a href={event.edgarUrl} target="_blank" rel="noopener noreferrer">{m.edgarIndex}<span aria-hidden="true"> ↗</span></a></li>
          <li><a href={event.documentUrl} target="_blank" rel="noopener noreferrer">{m.filing(event.form)}<span aria-hidden="true"> ↗</span></a></li>
          {event.exhibits.map(x => <li key={x.url}><a href={x.url} target="_blank" rel="noopener noreferrer">{x.type} · {x.title}<span aria-hidden="true"> ↗</span></a></li>)}
        </ol>
      </div>
    </div>
  </section>;
}

/** A current report's facts: the item codes it was filed under, in words, and what the primary document is. */
function Facts({ event }: { event: CompanyEvent }) {
  return <dl className="event-facts">
    <div><dt>{m.form}</dt><dd>{event.form}</dd></div>
    <div><dt>{m.eventDate}</dt><dd>{event.eventDate}</dd></div>
    {event.items.length > 0 && <div><dt>{m.items}</dt><dd>{event.items.map(i => <span key={i} className="event-item">{m.item(i)}<small>{ITEM_LABEL[i] ?? ""}</small></span>)}</dd></div>}
    {event.description && <div><dt>{m.document}</dt><dd lang="en">{event.description}</dd></div>}
    {event.exhibits.length > 0 && <div><dt>{m.exhibits}</dt><dd>{event.exhibits.map(x => x.type).join(", ")}</dd></div>}
    {event.summary?.eventCategory && <div><dt>{m.summaryCategory}</dt><dd>{CATEGORY[event.summary.eventCategory]}</dd></div>}
  </dl>;
}

/** One Form 4 as figures: its rule-based tag, the trade, and the owner's history against the other insiders. */
function InsiderReading({ model, event }: { model: InsiderLensModel; event: CompanyEvent }) {
  const t = event.insider!;
  const role = [t.title, t.isDirector ? m.director : null, t.isTenPercentOwner ? m.tenPercent : null].filter(Boolean).join(" · ") || m.filer;
  return <>
    <p className="lens-judgment event-verdict" data-verdict={model.tone}><b>{model.verdict.label}</b></p>
    <dl className="lens-evidence">
      <div className="lens-row"><dt>{m.role}</dt><dd><b>{role}</b></dd></div>
      {t.sold && <>
        <div className="lens-row"><dt>{m.sharesSold}</dt><dd><b>{shares(t.sold.shares)}</b></dd></div>
        <div className="lens-row"><dt>{m.avgPrice}</dt><dd><b>{perShare(t.sold.averagePrice, "USD", getLocale())}</b></dd></div>
        <div className="lens-row"><dt>{m.proceeds}</dt><dd><b>{dollars(t.sold.proceeds)}</b></dd></div>
      </>}
      {!t.sold && t.bought && <>
        <div className="lens-row"><dt>{m.sharesBought}</dt><dd><b>{shares(t.bought.shares)}</b></dd></div>
        <div className="lens-row"><dt>{m.cost}</dt><dd><b>{dollars(t.bought.cost)}</b></dd></div>
      </>}
      {!t.sold && !t.bought && t.exercised && <div className="lens-row"><dt>{m.sharesExercised}</dt><dd><b>{shares(t.exercised)}</b></dd></div>}
      {t.sold && <div className="lens-row"><dt>{m.priorShare}</dt><dd><b>{model.share != null ? `${model.share.toFixed(1)}%` : "—"}</b><em>{m.threshold(INSIDER_RULES.attentionShare)}</em></dd></div>}
      <div className="lens-row"><dt>{m.heldAfter}</dt><dd><b>{t.heldAfter != null ? shares(t.heldAfter) : m.notDisclosed}</b></dd></div>
      <div className="lens-row"><dt>{m.plan}</dt><dd><b>{t.rule10b51 === true ? m.yes : t.rule10b51 === false ? m.no : m.notMarked}</b>{t.planAdoptedOn && <em>{m.adopted(t.planAdoptedOn)}</em>}</dd></div>
      <div className="lens-row"><dt>{m.salesYear}</dt><dd><b>{m.sales(model.cadence.sales.length)} · {shares(model.cadence.totalShares)}</b><em>{model.cadence.intervalDays != null ? `${m.interval(Math.round(model.cadence.intervalDays))}${model.cadence.regular ? m.steady : ""}` : m.noInterval} · {m.total(dollars(model.cadence.totalProceeds))}</em></dd></div>
      <div className="lens-row"><dt>{m.otherSellers}</dt><dd><b>{m.people(model.cluster.length)}</b><em>{m.window(INSIDER_RULES.clusterDays)}</em></dd></div>
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
  if (path.length < 2) return <div className="lens-empty">{m.singleFiling}</div>;
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
  return <div className="insider-ladder" role="img" aria-label={m.path(event.insider!.ownerName, path[0].date, path[path.length - 1].date, sales.length)}>
    <div className="lens-legend"><span><i className="ladder-step" />{m.directHolding}</span><span><i className="ladder-dot" />{m.sale}</span><span><i className="ladder-dot ladder-dot--planned" />{m.plan}</span></div>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {[0.25, 0.5, 0.75].map(t => <line key={t} className="ladder-grid" x1="4" x2="96" y1={8 + t * 84} y2={8 + t * 84} vectorEffect="non-scaling-stroke" />)}
      <path className="ladder-path" d={d} vectorEffect="non-scaling-stroke" />
    </svg>
    <div className="ladder-marks">
      {sales.map(p => {
        const proceeds = model.cadence.sales.find(s => s.id === p.id)?.proceeds ?? 0;
        const size = 8 + Math.sqrt(Math.max(proceeds, 1) / maxProceeds) * 18;
        return <i key={p.id} className="ladder-dot" data-planned={p.planned === true || undefined} data-focus={p.id === event.id || undefined}
          style={{ left: `${x(p.date)}%`, top: `${y(p.held)}%`, width: size, height: size } as CSSProperties} title={`${p.date} · ${shares(p.sold)} · ${dollars(proceeds)}`} />;
      })}
    </div>
    <div className="lens-axis"><span style={{ left: "4%" }} data-edge="start">{shortPeriod(path[0].date)}</span><span style={{ left: "96%" }} data-edge="end">{shortPeriod(path[path.length - 1].date)}</span></div>
    <div className="ladder-scale"><span>{shares(top)}</span><span>{shares(bottom)}</span></div>
  </div>;
}
