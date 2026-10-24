import { Button } from "@/packages/web/src/ui/button";
import { Table, TableBody, TableCell, TableHead, TableRow } from "@/packages/web/src/ui/table";
import { useMemo, useState, type CSSProperties } from "react";
import type { CompanyEvent, EventsPublication } from "@/shared/analysis-contract/events";
import { INSIDER_RULES } from "@/shared/analysis-runtime/events";
import { getLocale, labels, messages } from "@/packages/web/src/i18n";
import { SourceLanguage, langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { perShare, shortPeriod } from "@/shared/analysis-runtime/locale";
import type { FindingData } from "@/shared/analysis-runtime/findings";
import { EVENT_CLASS_LABEL, dollars, eventTitle, eventTitleLang, insiderLens, shareCounts, shares, shortDate, type InsiderLensModel } from "./events-model";
import { ItemAnalysisBody, useItemAnalysis, useVerifiedAnalysis } from "./ItemAnalysis";

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
  stake: "Stake", ofOutstanding: (count: string, asOf: string) => `Direct holding ÷ ${count} outstanding as of ${asOf}`,
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
  stake: "持股比例", ofOutstanding: (count: string, asOf: string) => `直接持股 ÷ 流通股 ${count}（截至 ${asOf}）`,
});

/**
 * The event in focus, holding the whole stage the way a finding does: its analysis, written by the agent every
 * analysis is written by and verified here as a finding is, drawn by the finding's own blocks. Until a filing has one
 * (a routine Form 4, a company without AI analysis), its chart and figures and the filing's own summary stand in, in
 * the same single-column document; the summary's headline is the title, so it is not repeated. The tag on an insider
 * sale is rule-based.
 */
export function EventLens({ event, publication, ticker, data, updates, nodeColor, onClose, onStep, index, count }: {
  event: CompanyEvent;
  publication: EventsPublication;
  ticker: string;
  data: FindingData;
  updates: number;
  nodeColor: (id: string) => string;
  onClose: () => void;
  onStep: (delta: 1 | -1) => void;
  index: number;
  count: number;
}) {
  const counts = useMemo(() => shareCounts(data.fundamentals), [data.fundamentals]);
  const insider = useMemo(() => insiderLens(publication, event, counts), [publication, event, counts]);
  const [showQuiet, setShowQuiet] = useState(false);
  const analysis = useItemAnalysis(ticker, event.id, updates);
  const verified = useVerifiedAnalysis(analysis, data, ticker);
  const title = verified?.finding.title ?? eventTitle(event);
  return <section className="lens event-lens" data-class={event.class} aria-label={m.event(eventTitle(event))} key={event.id}>
    <header className="lens-head">
      <div className="lens-title">
        <b className="lens-kind event-kind">{EVENT_CLASS_LABEL[event.class]}</b>
        <SourceLanguage of={verified ? [verified.finding.title, verified.finding.judgment.text] : event.summary ? [event.summary.headline, event.summary.analystView, ...event.summary.bullets.flatMap(b => [b.label, b.detail])] : []} />
        <h2 lang={verified ? langOf(title) : eventTitleLang(event)}>{title}</h2>
        <span className="lens-basis">{event.form} · {m.filed} {event.filedAt}{event.eventDate !== event.filedAt ? ` · ${m.eventOn} ${event.eventDate}` : ""}</span>
      </div>
      <div className="lens-nav">
        <span className="lens-steps"><Button variant="unstyled" type="button" aria-label={m.newer} disabled={index <= 0} onClick={() => onStep(-1)}>‹</Button><span>{index + 1} / {count}</span><Button variant="unstyled" type="button" aria-label={m.older} disabled={index >= count - 1} onClick={() => onStep(1)}>›</Button></span>
        <Button variant="unstyled" type="button" className="lens-close" aria-label={m.close} onClick={onClose}>✕</Button>
      </div>
    </header>
    <ItemAnalysisBody analysis={analysis} verified={verified} ticker={ticker} nodeColor={nodeColor} fallback={<div className="lens-doc"><div className="lens-doc-row"><div className="lens-doc-cell">
      {insider && !insider.stake && <InsiderLadder model={insider} event={event} />}
      {insider && <InsiderReading model={insider} event={event} />}
      {event.summary ? <>
        <ul className="event-bullets">{event.summary.bullets.map((b, i) => <li key={i} data-importance={b.importance} lang={langOf(b.detail)}><b>{b.label}</b>{b.detail}</li>)}</ul>
        {event.summary.analystView && <p className="event-view"><b>{m.analystView}</b><span lang={langOf(event.summary.analystView)}>{event.summary.analystView}</span></p>}
      </> : !insider && <p className="lens-empty">{m.noSummary}</p>}
      {!insider && <Facts event={event} />}
      {event.summary && <p className="event-generated">{m.aiSummary} · {event.summary.generatedAt.slice(0, 10)}</p>}
      {insider && insider.path.length > 0 && event.insider!.footnotes.length > 0 && <details className="event-footnotes" open={showQuiet} onToggle={e => setShowQuiet((e.target as HTMLDetailsElement).open)}>
        <summary>{m.footnotes(event.insider!.footnotes.length)}</summary>
        <ol lang="en">{event.insider!.footnotes.map((f, i) => <li key={i}>{f}</li>)}</ol>
      </details>}
      <ol className="sources sources--numbered">
        <li><a href={event.edgarUrl} target="_blank" rel="noopener noreferrer">{m.edgarIndex}<span aria-hidden="true"> ↗</span></a></li>
        <li><a href={event.documentUrl} target="_blank" rel="noopener noreferrer">{m.filing(event.form)}<span aria-hidden="true"> ↗</span></a></li>
        {event.exhibits.map(x => <li key={x.url}><a href={x.url} target="_blank" rel="noopener noreferrer">{x.type} · {x.title}<span aria-hidden="true"> ↗</span></a></li>)}
      </ol>
    </div></div></div>} />
  </section>;
}

/** A current report's facts: the item codes it was filed under, in words, and what the primary document is. */
function Facts({ event }: { event: CompanyEvent }) {
  return <Table className="lens-table lens-pairs event-facts"><TableBody>
    <TableRow><TableHead scope="row">{m.form}</TableHead><TableCell>{event.form}</TableCell></TableRow>
    <TableRow><TableHead scope="row">{m.eventDate}</TableHead><TableCell>{event.eventDate}</TableCell></TableRow>
    {event.items.length > 0 && <TableRow><TableHead scope="row">{m.items}</TableHead><TableCell>{event.items.map(i => <span key={i} className="event-item">{m.item(i)}<small>{ITEM_LABEL[i] ?? ""}</small></span>)}</TableCell></TableRow>}
    {event.description && <TableRow><TableHead scope="row">{m.document}</TableHead><TableCell lang="en">{event.description}</TableCell></TableRow>}
    {event.exhibits.length > 0 && <TableRow><TableHead scope="row">{m.exhibits}</TableHead><TableCell>{event.exhibits.map(x => x.type).join(", ")}</TableCell></TableRow>}
    {event.summary?.eventCategory && <TableRow><TableHead scope="row">{m.summaryCategory}</TableHead><TableCell>{CATEGORY[event.summary.eventCategory]}</TableCell></TableRow>}
  </TableBody></Table>;
}

/** One Form 4 as figures: its rule-based tag, the trade, and the owner's history against the other insiders. */
function InsiderReading({ model, event }: { model: InsiderLensModel; event: CompanyEvent }) {
  const t = event.insider!;
  const role = [t.title, t.isDirector ? m.director : null, t.isTenPercentOwner ? m.tenPercent : null].filter(Boolean).join(" · ") || m.filer;
  return <>
    <p className="lens-judgment event-verdict" data-verdict={model.tone}><b>{model.verdict.label}</b></p>
    <Table className="lens-table lens-pairs"><TableBody>
      <TableRow><TableHead scope="row">{m.role}</TableHead><TableCell><b>{role}</b></TableCell></TableRow>
      {t.sold && <>
        <TableRow><TableHead scope="row">{m.sharesSold}</TableHead><TableCell><b>{shares(t.sold.shares)}</b></TableCell></TableRow>
        <TableRow><TableHead scope="row">{m.avgPrice}</TableHead><TableCell><b>{perShare(t.sold.averagePrice, "USD", getLocale())}</b></TableCell></TableRow>
        <TableRow><TableHead scope="row">{m.proceeds}</TableHead><TableCell><b>{dollars(t.sold.proceeds)}</b></TableCell></TableRow>
      </>}
      {!t.sold && t.bought && <>
        <TableRow><TableHead scope="row">{m.sharesBought}</TableHead><TableCell><b>{shares(t.bought.shares)}</b></TableCell></TableRow>
        <TableRow><TableHead scope="row">{m.cost}</TableHead><TableCell><b>{dollars(t.bought.cost)}</b></TableCell></TableRow>
      </>}
      {!t.sold && !t.bought && t.exercised && <TableRow><TableHead scope="row">{m.sharesExercised}</TableHead><TableCell><b>{shares(t.exercised)}</b></TableCell></TableRow>}
      {t.sold && <TableRow><TableHead scope="row">{m.priorShare}</TableHead><TableCell><b>{model.share != null ? `${model.share.toFixed(1)}%` : "—"}</b><em>{m.threshold(INSIDER_RULES.attentionShare)}</em></TableCell></TableRow>}
      <TableRow><TableHead scope="row">{m.heldAfter}</TableHead><TableCell><b>{t.heldAfter != null ? shares(t.heldAfter) : m.notDisclosed}</b></TableCell></TableRow>
      {model.stake && <TableRow><TableHead scope="row">{m.stake}</TableHead><TableCell><b>{model.stake.before != null && model.stake.before !== model.stake.after ? `${stake(model.stake.before)} → ` : ""}{stake(model.stake.after!)}</b><em>{m.ofOutstanding(shares(model.stake.outstanding.shares), shortPeriod(model.stake.outstanding.date))}</em></TableCell></TableRow>}
      <TableRow><TableHead scope="row">{m.plan}</TableHead><TableCell><b>{t.rule10b51 === true ? m.yes : t.rule10b51 === false ? m.no : m.notMarked}</b>{t.planAdoptedOn && <em>{m.adopted(t.planAdoptedOn)}</em>}</TableCell></TableRow>
      <TableRow><TableHead scope="row">{m.salesYear}</TableHead><TableCell><b>{m.sales(model.cadence.sales.length)} · {shares(model.cadence.totalShares)}</b><em>{model.cadence.intervalDays != null ? `${m.interval(Math.round(model.cadence.intervalDays))}${model.cadence.regular ? m.steady : ""}` : m.noInterval} · {m.total(dollars(model.cadence.totalProceeds))}</em></TableCell></TableRow>
      <TableRow><TableHead scope="row">{m.otherSellers}</TableHead><TableCell><b>{m.people(model.cluster.length)}</b><em>{m.window(INSIDER_RULES.clusterDays)}</em></TableCell></TableRow>
    </TableBody></Table>
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
  const sales = path.filter(p => p.sold > 0);
  const maxProceeds = Math.max(1, ...sales.map(p => p.proceeds));
  return <div className="insider-ladder" role="img" aria-label={m.path(event.insider!.ownerName, path[0].date, path[path.length - 1].date, sales.length)}>
    <div className="lens-legend"><span><i className="ladder-step" />{m.directHolding}</span><span><i className="ladder-dot" />{m.sale}</span><span><i className="ladder-dot ladder-dot--planned" />{m.plan}</span></div>
    <div className="ladder-plot">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {[0.25, 0.5, 0.75].map(t => <line key={t} className="ladder-grid" x1="4" x2="96" y1={8 + t * 84} y2={8 + t * 84} vectorEffect="non-scaling-stroke" />)}
        <path className="ladder-path" d={d} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="ladder-marks">
        {sales.map(p => {
          const size = 8 + Math.sqrt(Math.max(p.proceeds, 1) / maxProceeds) * 18;
          return <i key={p.id} className="ladder-dot" data-planned={p.planned === true || undefined} data-focus={p.id === event.id || undefined}
            style={{ left: `${x(p.date)}%`, top: `${y(p.held)}%`, width: size, height: size } as CSSProperties} title={`${p.date} · ${shares(p.sold)} · ${dollars(p.proceeds)}`} />;
        })}
      </div>
      <div className="ladder-scale"><span style={{ top: "8%" }}>{shares(top)}</span><span style={{ top: "92%" }}>{shares(bottom)}</span></div>
    </div>
    <div className="lens-axis"><span style={{ left: "4%" }} data-edge="start">{shortPeriod(path[0].date)}</span><span style={{ left: "96%" }} data-edge="end">{shortPeriod(path[path.length - 1].date)}</span></div>
  </div>;
}

/** "0.0251%": three significant figures however small the stake, one decimal at least, six at most. */
function stake(v: number): string {
  if (v <= 0) return "0%";
  if (v < 5e-7) return "<0.000001%";
  return `${v.toFixed(Math.min(6, Math.max(1, 2 - Math.floor(Math.log10(v)))))}%`;
}
