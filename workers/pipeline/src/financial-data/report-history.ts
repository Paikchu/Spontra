import type { PublicBusinessFlow } from '../../../../shared/analysis-contract/business-flow.ts';
import type { DisclosureAuditSummary } from '../../../../shared/analysis-contract/disclosure-audit.ts';
import { readReportHistory } from '../../../../shared/analysis-runtime/financial-data/report-history.ts';
import { checkCompleteQuarter } from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import { extractDisclosedQuarters, type DocumentSource } from './parser.ts';
import { disclosureAuditPrefix } from './disclosure-audit.ts';

export type ReportArchive = {get(key:string):Promise<{etag?:string;text():Promise<string>}|null>};
type ArchivedReport=DisclosureAuditSummary & {rawKey:string};
// Bounded isolate cache; archive hashes invalidate it immediately when a source is replaced.
const projections=new Map<string,{expires:number;flow:PublicBusinessFlow}>();

/** Read only existing company archives. No SEC fetch, collection, model, database or R2 writes. */
export async function readArchivedReportHistory(db:D1Database,archive:ReportArchive,flow:PublicBusinessFlow):Promise<PublicBusinessFlow> {
 const latest=flow.quarters.slice().sort((a,b)=>b.periodEnd.localeCompare(a.periodEnd))[0];
 if(!latest)return flow;
 const cutoff=new Date(latest.periodEnd);cutoff.setUTCFullYear(cutoff.getUTCFullYear()-2);
 const rows=await db.prepare('SELECT payload FROM sec_cache WHERE cache_key LIKE ? ORDER BY fetched_at DESC LIMIT 100').bind(disclosureAuditPrefix(flow.ticker)+'%').all<{payload:string}>();
 const records:ArchivedReport[]=[];
 for(const row of rows.results){try{const r=JSON.parse(row.payload) as ArchivedReport;
  if(r.ticker===flow.ticker&&r.source?.ticker===flow.ticker&&r.rawKey?.startsWith('financial-disclosures/')&&r.sourceBytes>0&&r.sourceBytes<=12_000_000&&/^10-[QK](?:\/A)?$|^8-K$/.test(r.source.form)&&/^\d{10}-\d{2}-\d{6}$/.test(r.source.accessionNumber)&&Date.parse(r.source.filedAt)>cutoff.getTime())records.push(r);
 }catch{/* A malformed optional archive cannot hide the published latest report. */}}
 const priority=(r:ArchivedReport)=>/ex[-_]?99/i.test(r.source.documentUrl)?0:/^10-Q/.test(r.source.form)?1:/^10-K/.test(r.source.form)?2:3;
 records.sort((a,b)=>priority(a)-priority(b)||b.source.filedAt.localeCompare(a.source.filedAt));
 const key=JSON.stringify([flow.ticker,flow.fetchedAt,flow.quarters,records.map(r=>[r.documentId,r.contentSha256])]);
 const cached=projections.get(key);if(cached&&cached.expires>Date.now())return cached.flow;
 const byPeriod=new Map(flow.quarters.map(q=>[q.periodEnd,q]));
 const issuer=latest.sources.map(s=>s.url.match(/\/Archives\/edgar\/data\/(\d+)\//)?.[1]).find(Boolean);
 let bytes=0;
 for(const record of records.slice(0,24)){
  if(byPeriod.size>=8)break;
  try{
  const url=new URL(record.source.documentUrl),cik=url.pathname.match(/^\/Archives\/edgar\/data\/(\d+)\//)?.[1];
  if(url.protocol!=='https:'||url.hostname!=='www.sec.gov'||url.username||url.password||!cik||!issuer||Number(cik)!==Number(issuer))continue;
  bytes+=record.sourceBytes;if(bytes>48_000_000)break;
   const object=await archive.get(record.rawKey);if(!object)continue;
   const html=await object.text();if(new TextEncoder().encode(html).byteLength!==record.sourceBytes)continue;
   const source:DocumentSource={url:url.href,cik:cik.padStart(10,'0'),accession:record.source.accessionNumber,filedAt:record.source.filedAt,industry:latest.incomeModel==='financial'||latest.incomeModel==='insurance'?latest.incomeModel:'standard'};
   for(const q of extractDisclosedQuarters(html,source).quarters){
    if(q.periodEnd>latest.periodEnd||Date.parse(q.periodEnd)<=cutoff.getTime()||byPeriod.has(q.periodEnd)||!checkCompleteQuarter(q).complete)continue;
    byPeriod.set(q.periodEnd,q);
   }
  }catch{/* Missing or unsupported archives leave their periods unavailable, never invented. */}
 }
 const result=readReportHistory({...flow,quarters:[...byPeriod.values()]},flow.ticker)??flow;
 if(projections.size>=4)projections.delete(projections.keys().next().value!);
 projections.set(key,{expires:Date.now()+60_000,flow:result});return result;
}
