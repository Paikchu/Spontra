import {AnalysisRequestError} from '../read-api/contract-support/errors.ts';
import {publicFlowSchema} from '../../../../shared/analysis-runtime/financial-data/schema.ts';
import type {CompleteFlowPublication} from '../../../../shared/analysis-contract/complete-business-flow.ts';
import type {PublicBusinessFlow,FlowAmount,BusinessSegment} from '../../../../shared/analysis-contract/business-flow.ts';
import {checkCompleteFlow} from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import {historyForIssuer,readRevenueHistory} from './history.ts';
import {historyFromSnapshot,mergeHistory,readHistory} from '../../../../shared/analysis-runtime/financial-data/history.ts';
import type {RevenueHistoryQuarter} from '../../../../shared/analysis-contract/revenue-history.ts';

/** Admin list metadata comes from the same verified publications as the detail view, never an
 * in-progress/failed attempt or a newly discovered filing that has not yielded usable data. */
export function financialPublicationMetadata(ticker: string, source: {
 cik: string | null; currentPayload: string | null; publishedAt: string | null;
 historyPayload: string | null;
}): { latestPeriodEnd: string | null; lastUpdatedAt: string | null } {
 let flow: PublicBusinessFlow | null = null;
 try {
  if (source.currentPayload) {
   const current = publicFlowSchema.parse(JSON.parse(source.currentPayload));
   if (!checkCompleteFlow(current).complete) throw new Error('Published snapshot failed validation');
   flow = current.ticker === ticker ? current : source.cik ? flowForIssuer(current, source.cik, ticker) : null;
  }
 } catch { /* A corrupt publication must not hide other companies in the admin list. */ }
 let history = null;
 if (source.cik && source.historyPayload) {
  try {
   const candidate = historyForIssuer(JSON.parse(source.historyPayload), source.cik, ticker);
   history = candidate ? readHistory(candidate, ticker) : null;
  } catch { /* Supplementary history never invalidates a complete snapshot. */ }
 }
 const periods = [...(flow?.quarters ?? []), ...(history?.quarters ?? [])].map(quarter => quarter.periodEnd).sort();
 const updates = [flow ? (source.currentPayload ? source.publishedAt ?? flow.fetchedAt : flow.fetchedAt) : null, history?.updatedAt]
  .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
  .sort((a, b) => Date.parse(a) - Date.parse(b));
 return { latestPeriodEnd: periods.at(-1) ?? null, lastUpdatedAt: updates.at(-1) ?? null };
}
/** Reads only the pointer to complete immutable versions, never staged quarters. */
export async function readCompletePublication(db:D1Database,cik:string):Promise<CompleteFlowPublication>{
 const row=await db.prepare(`SELECT v.payload_json FROM financial_complete_current c JOIN financial_complete_versions v ON v.version_id=c.version_id WHERE c.cik=?`).bind(cik).first<{payload_json:string}>();
 const attempt=await db.prepare(`SELECT status,reasons_json,updated_at FROM financial_collection_jobs WHERE cik=? ORDER BY generation DESC LIMIT 1`).bind(cik).first<{status:string;reasons_json:string;updated_at:string}>();
 const flow=row?publicFlowSchema.parse(JSON.parse(row.payload_json)):null;if(flow&&!checkCompleteFlow(flow).complete)throw new Error('Published snapshot failed validation');
 return {schemaVersion:'complete-business-flow.v1',status:flow?'ready':attempt?.status==='unavailable'?'unavailable':'preparing',flow,reasons:attempt&&attempt.status!=='succeeded'?JSON.parse(attempt.reasons_json):flow?[]:['MISSING_TWO_QUARTERS'],outdated:!!flow&&!!attempt&&attempt.status!=='succeeded',lastAttemptAt:attempt?.updated_at??null};
}

/** Data-only public projection: no AI payload, no staged partial quarters, no read-side refresh. */
export async function readCompletePublicationForTicker(db:D1Database,ticker:string):Promise<CompleteFlowPublication>{
 ticker=ticker.trim().toUpperCase();if(!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker))throw new AnalysisRequestError('INVALID_TICKER','Invalid company ticker.');
 // Scalar fallbacks preserve source priority without exceeding D1's compound SELECT limit.
 const resolved=await db.prepare(`SELECT COALESCE(
  (SELECT cik FROM financial_collection_jobs WHERE ticker=? ORDER BY generation DESC LIMIT 1),
  (SELECT v.cik FROM financial_complete_current c JOIN financial_complete_versions v ON v.version_id=c.version_id WHERE v.ticker=? ORDER BY v.generation DESC LIMIT 1),
  (SELECT substr(cache_key,length('sec:revenue-history:v1:')+1) FROM sec_cache
    WHERE cache_key LIKE 'sec:revenue-history:v1:%' AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.ticker') END=? LIMIT 1),
  (SELECT CASE WHEN json_valid(payload) THEN json_extract(payload,'$.cik') END FROM sec_cache WHERE cache_key='admin:financial-issuer:'||?),
  (SELECT CASE WHEN json_valid(payload) THEN json_extract(payload,'$.company.cik') END FROM sec_cache WHERE cache_key='sec:filings:'||?),
  (SELECT cik FROM sec_filings WHERE ticker=? AND cik IS NOT NULL LIMIT 1)
 ) cik`).bind(ticker,ticker,ticker,ticker,ticker,ticker).first<{cik:string|null}>();
 const identity=resolved?.cik!=null?{cik:resolved.cik}:null;
 const publication=await readFlowPublication(db,ticker,identity);
 // Revenue history is supplementary: a missing or invalid record never affects the snapshot.
 const stored=identity?await readRevenueHistory(db,identity.cik,ticker).catch(()=>null):null;
 const anchors=(publication.flow?.quarters??[]).map(historyFromSnapshot).filter((q):q is RevenueHistoryQuarter=>q!==null);
 const history=stored||anchors.length?readHistory(mergeHistory(ticker,stored?.quarters??[],anchors,stored?.updatedAt??publication.flow?.fetchedAt??new Date().toISOString()),ticker):null;
 return {...publication,history};
}
async function readFlowPublication(db:D1Database,ticker:string,identity:{cik:string}|null):Promise<CompleteFlowPublication>{
 const current=identity?await readCompletePublication(db,identity.cik):null;
 if(current?.flow){
  if(current.flow.ticker===ticker)return current;
  const flow=flowForIssuer(current.flow,identity!.cik,ticker);
  return flow?{...current,flow}:{...current,status:'preparing',flow:null,reasons:['INVALID_SOURCE'],outdated:false};
 }
 return current??{schemaVersion:'complete-business-flow.v1',status:'preparing',flow:null,reasons:['MISSING_TWO_QUARTERS'],outdated:false,lastAttemptAt:null};
}

/** Share classes use one issuer snapshot. Relabel only this CIK-keyed, validated publication,
 * after checking every source and all amount provenance; the general flow validator stays strict. */
export function flowForIssuer(flow:PublicBusinessFlow,cik:string,ticker:string):PublicBusinessFlow|null{
 if(!/^\d{10}$/.test(cik)||Number(cik)<=0)return null;
 const sameIssuer=(value:string)=>{try{
  const url=new URL(value),sourceCik=url.pathname.match(/^\/Archives\/edgar\/data\/(\d{1,10})\//)?.[1];
  return url.protocol==='https:'&&['sec.gov','www.sec.gov'].includes(url.hostname)&&!url.username&&!url.password&&!url.port&&!!sourceCik&&Number(sourceCik)===Number(cik);
 }catch{return false;}};
 for(const quarter of flow.quarters){
  if(!quarter.sources.length||!quarter.sources.every(source=>sameIssuer(source.url)))return null;
  const sourceIds=new Set(quarter.sources.map(source=>source.id));
  const amounts:Array<FlowAmount|null|undefined>=Object.values(quarter.figures);
  const segments:BusinessSegment[]=[...quarter.segments,...(quarter.revenueBreakdowns??[]).flatMap(breakdown=>breakdown.nodes)];
  for(const segment of segments){
   if(!segment.sourceIds.every(id=>sourceIds.has(id)))return null;
   amounts.push(segment.revenue,...(segment.children??[]).map(child=>child.revenue));
  }
  amounts.push(...(quarter.revenueAdjustments??[]).map(component=>component.amount),...(quarter.expenseComponents??[]).map(component=>component.amount),...(quarter.otherComponents??[]).map(component=>component.amount));
  for(const amount of amounts){
   if(!amount)continue;
   if(amount.value!==null&&(!amount.sourceIds.length||!amount.lineage?.length))return null;
   if(!amount.sourceIds.every(id=>sourceIds.has(id))||!(amount.lineage??[]).every(lineage=>sameIssuer(lineage.url)))return null;
  }
 }
 return {...flow,ticker};
}
