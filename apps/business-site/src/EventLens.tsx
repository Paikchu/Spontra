import { Button } from "@/packages/web/src/ui/button";
import { Table, TableBody, TableCell, TableHead, TableRow } from "@/packages/web/src/ui/table";
import type { CompanyEvent, EventsPublication } from "@/shared/analysis-contract/events";
import { labels, messages } from "@/packages/web/src/i18n";
import { SourceLanguage, langOf } from "@/packages/web/src/i18n/SourceLanguage";
import type { FindingData } from "@/shared/analysis-runtime/findings";
import { EVENT_CLASS_LABEL, eventTitle, eventTitleLang } from "./events-model";
import { ItemAnalysisBody, useItemAnalysis, useVerifiedAnalysis } from "./ItemAnalysis";
import { PersonHistory } from "./InsiderHistory";

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
  event: (title: string) => `Event: ${title}`, filed: "Filed", eventOn: "Event", close: "Close event",
  analystView: "Analyst view", aiSummary: "AI summary", noSummary: "No summary",
  edgarIndex: "EDGAR filing index", filing: (form: string) => `${form} filing`,
  form: "Form", eventDate: "Event date", items: "Items", item: (code: string) => `Item ${code}`, document: "Document", exhibits: "Exhibits", summaryCategory: "Summary category",
}, {
  event: (title: string) => `事件：${title}`, filed: "提交日期", eventOn: "事件日期", close: "关闭事件",
  analystView: "分析观点", aiSummary: "AI 摘要", noSummary: "无摘要",
  edgarIndex: "EDGAR 文件索引", filing: (form: string) => `${form} 文件`,
  form: "文件类型", eventDate: "事件日期", items: "事项", item: (code: string) => `Item ${code}`, document: "文档", exhibits: "附件", summaryCategory: "摘要类别",
});

/**
 * The event in focus, holding the whole stage the way a finding does: its analysis, written by the agent every
 * analysis is written by and verified here as a finding is, drawn by the finding's own blocks. Until a filing has one
 * (a routine Form 4, a company without AI analysis), the filing's own summary stands in, in the same single-column
 * document; the summary's headline is the title, so it is not repeated. A Form 4 shows only its
 * filer's every transaction of the company, newest first.
 */
export function EventLens({ event, publication, ticker, data, updates, nodeColor, onFocusEvent, onClose }: {
  event: CompanyEvent;
  publication: EventsPublication;
  ticker: string;
  data: FindingData;
  updates: number;
  nodeColor: (id: string) => string;
  /** Opens another filing of the events publication on the stage. */
  onFocusEvent: (id: string) => void;
  onClose: () => void;
}) {
  const analysis = useItemAnalysis(ticker, event.id, updates);
  const verified = useVerifiedAnalysis(analysis, data, ticker);
  const title = verified?.finding.title ?? eventTitle(event);
  const history = event.insider ? <PersonHistory event={event} publication={publication} ticker={ticker} updates={updates} onFocusEvent={onFocusEvent} /> : null;
  return <section className="lens event-lens" data-class={event.class} aria-label={m.event(eventTitle(event))} key={event.id}>
    <header className="lens-head">
      <div className="lens-title">
        <b className="lens-kind event-kind">{EVENT_CLASS_LABEL[event.class]}</b>
        <SourceLanguage of={verified ? [verified.finding.title, verified.finding.judgment.text] : event.summary ? [event.summary.headline, event.summary.analystView, ...event.summary.bullets.flatMap(b => [b.label, b.detail])] : []} />
        <h2 lang={verified ? langOf(title) : eventTitleLang(event)}>{title}</h2>
        <span className="lens-basis">{event.form} · {m.filed} {event.filedAt}{event.eventDate !== event.filedAt ? ` · ${m.eventOn} ${event.eventDate}` : ""}</span>
      </div>
      <div className="lens-nav">
        <Button variant="unstyled" type="button" className="lens-close" aria-label={m.close} onClick={onClose}>✕</Button>
      </div>
    </header>
    <ItemAnalysisBody analysis={analysis} verified={verified} ticker={ticker} nodeColor={nodeColor} after={history} fallback={<div className="lens-doc">{history ?? <div className="lens-doc-row"><div className="lens-doc-cell">
      {event.summary ? <>
        <ul className="event-bullets">{event.summary.bullets.map((b, i) => <li key={i} data-importance={b.importance} lang={langOf(b.detail)}><b>{b.label}</b>{b.detail}</li>)}</ul>
        {event.summary.analystView && <p className="event-view"><b>{m.analystView}</b><span lang={langOf(event.summary.analystView)}>{event.summary.analystView}</span></p>}
      </> : <p className="lens-empty">{m.noSummary}</p>}
      <Facts event={event} />
      {event.summary && <p className="event-generated">{m.aiSummary} · {event.summary.generatedAt.slice(0, 10)}</p>}
      <ol className="sources sources--numbered">
        <li><a href={event.edgarUrl} target="_blank" rel="noopener noreferrer">{m.edgarIndex}<span aria-hidden="true"> ↗</span></a></li>
        <li><a href={event.documentUrl} target="_blank" rel="noopener noreferrer">{m.filing(event.form)}<span aria-hidden="true"> ↗</span></a></li>
        {event.exhibits.map(x => <li key={x.url}><a href={x.url} target="_blank" rel="noopener noreferrer">{x.type} · {x.title}<span aria-hidden="true"> ↗</span></a></li>)}
      </ol>
    </div></div>}</div>} />
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
