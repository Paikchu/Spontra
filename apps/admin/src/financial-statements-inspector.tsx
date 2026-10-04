import {useEffect,useState} from 'react';
import type {DisclosureAuditSummary} from '@/shared/analysis-contract/disclosure-audit';
import type {FinancialStatements,StatementCell} from '@/shared/analysis-runtime/financial-data/financial-statements';
import {adminApi,AdminApiError} from './admin-api';
import {safeEvidenceUrl} from './financial-maintenance-state';

function Cell({cell}:{cell:StatementCell}){
 const Tag=cell.header?'th':'td';
 return <Tag colSpan={cell.colSpan} rowSpan={cell.rowSpan} data-empty={!cell.text} data-numeric={cell.facts.some(f=>f.value!==null)}><span className="fm-cell-text">{cell.text || '\u00a0'}</span>{cell.facts.length>0&&<details className="fm-cell-facts"><summary aria-label={`查看 ${cell.text.slice(0,40)} 的期间单位与标签`}>出处 · {cell.facts.length}</summary>{cell.facts.map(f=><div key={f.id}><code>{f.concept}</code><p>规范值：{f.value??'未解析，保留原文'} · {f.status}</p><p>单位：{f.unit??'未标注'} · scale {f.scale??'未标注'}</p><p>{f.period?.kind==='instant'?'时点':'期间'}：{f.period?.start?`${f.period.start} — `:''}{f.period?.end??'未解析'}</p>{f.dimensions.map((d,i)=><p key={i}>{d.axis}: {d.value}</p>)}</div>)}</details>}</Tag>;
}
export function FinancialStatementsInspector({ticker,documents,onUnauthorized}:{ticker:string;documents:DisclosureAuditSummary[];onUnauthorized:()=>void}){
 const filings=documents.filter(d=>/^10-[QK](?:\/A)?$/.test(d.source.form)).sort((a,b)=>b.source.reportDate.localeCompare(a.source.reportDate)||b.source.filedAt.localeCompare(a.source.filedAt));
 const [selected,setSelected]=useState(''),[data,setData]=useState<FinancialStatements|null>(null),[tableId,setTableId]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0);
 const doc=filings.find(d=>d.documentId===selected)??filings[0];const id=doc?.documentId;
 useEffect(()=>{if(!id)return;const controller=new AbortController();setLoading(true);setError('');setData(null);setTableId('');void adminApi<FinancialStatements>(`financials/companies/${ticker}/documents/${id}/statements`,{signal:controller.signal}).then(result=>{if(!controller.signal.aborted){setData(result);setTableId(result.tables.find(t=>/balance sheets/i.test(t.section))?.id??result.tables[0]?.id??'');}}).catch(e=>{if(!controller.signal.aborted){if(e instanceof AdminApiError&&e.status===401)onUnauthorized();else setError(e.message);}}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[ticker,id,retry]);
 const table=data?.tables.find(t=>t.id===tableId);const source=safeEvidenceUrl(doc?.source.documentUrl);
 return <section className="fm-statements" aria-label="SEC 完整财务报表">
  <h3>Financial Statements · 报表与附注</h3><p>按 SEC 原始行列展示资产负债表、利润表、综合收益表、权益变动表、现金流量表和附注表格，保留比较期间、原始单位和脚注文字。</p>
  {!filings.length?<p className="fm-boundary">尚无已归档的 10-Q / 10-K。请补全数据；下面的季度摘要不代表完整报表。</p>:<><label>财报文件<select aria-label="Financial Statements 财报" value={id} onChange={e=>setSelected(e.target.value)}>{filings.map(d=><option key={d.documentId} value={d.documentId}>{d.source.form} · {d.source.reportDate} · {d.source.accessionNumber}</option>)}</select></label>{source&&<p><a href={source+(data?.locator?.elementId?'#'+encodeURIComponent(data.locator.elementId):'')} target="_blank" rel="noopener noreferrer">查看 SEC Financial Statements 原文</a></p>}</>}
  {loading&&<p role="status">正在读取整章报表与附注…</p>}{error&&<p role="alert">{error} <button onClick={()=>setRetry(v=>v+1)}>重试</button></p>}
  {data&&<><p>{data.coverage.tables} 张原始表格 · {data.coverage.rows} 行 · {data.coverage.cells} 个单元格 · 章节内 {data.coverage.facts} 个标签事实；表格关联 {data.coverage.linkedFacts} 个。正文 {data.coverage.textCharacters.toLocaleString()} 字符。</p>
   {data.status==='not_located'&&<p className="fm-boundary">尚未可靠定位 Financial Statements 章节，不能视为已提取。请查看原文。</p>}
   {!!data.coverage.issues.length&&<div className="fm-boundary">提取待核对：{data.coverage.issues.join('；')}</div>}
   <p className="fm-muted">金额按原表展示；展开“出处”可看精确值、期间、单位与标签。空白和破折号保持原样，不自动补零；未支持转换不隐藏原始数值。</p>
   {!!data.tables.length&&<label>报表 / 附注表格<select aria-label="选择财务报表或附注表格" value={tableId} onChange={e=>setTableId(e.target.value)}>{data.tables.map(t=><option key={t.id} value={t.id}>{t.title}（{t.rows.length} 行）</option>)}</select></label>}
   {table&&<><h4>{table.section}</h4>{table.precedingText&&<details><summary>表前说明、单位与脚注（完整原文）</summary><p>{table.precedingText}</p></details>}<p>原文字符 {table.locator.start}–{table.locator.end} · 全部 {table.rows.length} 行</p><div className="fm-table-scroll fm-statement-grid" tabIndex={0} aria-label="完整报表表格"><table key={table.id}><tbody>{table.rows.map((row,i)=><tr key={i}>{row.cells.map((cell,j)=><Cell key={j} cell={cell}/>)}</tr>)}</tbody></table></div></>}
   {!!data.text&&<details><summary>Financial Statements 整章正文（包含附注和表格文字，不截断）</summary><div className="fm-statement-text">{data.text}</div></details>}
  </>}
 </section>;
}
