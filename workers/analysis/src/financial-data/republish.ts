import type {BusinessFlowQuarter, FlowAmount, PublicBusinessFlow} from '../../../../shared/analysis-contract/business-flow.ts';
import type {RevenueHistoryLeaf, RevenueHistoryQuarter} from '../../../../shared/analysis-contract/revenue-history.ts';
import {publicFlowSchema} from '../../../../shared/analysis-runtime/financial-data/schema.ts';
import {checkCompleteFlow} from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import {historyFromSnapshot, reconcileRounding, roundingCompatible} from '../../../../shared/analysis-runtime/financial-data/history.ts';
import {readRevenueHistory} from './history.ts';

/** Rebuild only revenue presentation from stored history. The stored complete statements remain
 * the authority for their accounting totals. No extraction, network fetch, event, or model dispatch. */
export function rebuildPublication(flow: PublicBusinessFlow, history: RevenueHistoryQuarter[], at: string): PublicBusinessFlow {
  const quarters = flow.quarters.map(q => {
    let h = history.find(h => h.periodEnd === q.periodEnd && h.periodStart === q.periodStart && h.currency === q.currency);
    if (!h) return q;
    if (h.scale !== q.scale) {
      const factor = h.scale / q.scale;
      const leaf = (l: RevenueHistoryLeaf) => ({...l, value: String(Number(l.value) * factor)});
      h = {...h, scale: q.scale, revenue: String(Number(h.revenue) * factor), segments: h.segments.map(s=>({...leaf(s), children:s.children?.map(leaf)})), revenueAdjustments:h.revenueAdjustments?.map(leaf)};
    }
    if (Number(h.revenue) !== Number(q.figures.revenue?.value)) {
      const total = historyFromSnapshot(q);
      if (!total || !(h.fiscalQuarter === 4 || h.basis === 'derived') || !roundingCompatible(h, total)) throw new Error('REPUBLICATION_REVENUE_CONFLICT');
      h = reconcileRounding(h, {...total, basis:'reported'});
    }
    const amounts: FlowAmount[] = [];
    const amount = (l: RevenueHistoryLeaf): FlowAmount => {
      const lineage = l.lineage ?? h!.lineage;
      const result: FlowAmount = {value:l.value, basis:l.basis ?? (lineage?.some(v=>v.periodStart!==q.periodStart)?'derived':'reported'),
        definition:`revenue:${l.id}`, comparabilityKey:null, sourceIds:[...new Set(lineage?.map(v=>v.accession)??[])], lineage,
        ...(l.formula || h!.formula ? {formula:l.formula ?? h!.formula} : {})};
      amounts.push(result); return result;
    };
    const next: BusinessFlowQuarter = {...q, segmentDisclosure:h.segmentDisclosure, segmentsComplete:true,
      segments:h.segments.map(s=>({id:s.id,name:s.name,revenue:amount(s),description:'Revenue from the stored filing history.',products:[],customers:null,monetization:null,
        disclosure:h!.segmentDisclosure==='single_reportable_segment'?'Single reportable segment.':'Verified filing revenue split.',sourceIds:[...new Set((s.lineage??h!.lineage??[]).map(l=>l.accession))],
        ...(s.children?{children:s.children.map(c=>({id:c.id,name:c.name,revenue:amount(c)}))}:{})})),
      revenueAdjustments:h.revenueAdjustments?.map(a=>({id:a.id,name:a.name,amount:amount(a)})), revenueBreakdowns:undefined};
    const sources = new Map(q.sources.map(s=>[s.id,s]));
    for (const l of amounts.flatMap(a=>a.lineage??[])) if (!sources.has(l.accession)) sources.set(l.accession,{id:l.accession,title:`SEC filing ${l.accession}`,url:l.url});
    next.sources=[...sources.values()];
    return next;
  });
  const rebuilt = publicFlowSchema.parse({...flow, fetchedAt:at, quarters});
  if (!checkCompleteFlow(rebuilt).complete) throw new Error('REPUBLICATION_INVALID');
  return rebuilt;
}

/** One immutable version per maintenance request. Pointer and all affected cache revisions commit
 * together, fenced by both the task lease and the version read. Deliberately bypasses the outbox:
 * financials.published would start other workflows, including optional model consumers. */
export async function republishStoredFinancials(db: D1Database, target: {ticker:string;cik:string;taskId:string;leaseToken:string}, now = new Date()): Promise<string> {
  const version = `reread:${target.taskId}`, at = now.toISOString();
  const prior = await db.prepare('SELECT version_id FROM financial_complete_versions WHERE version_id=?').bind(version).first();
  if (prior) return version;
  const current = await db.prepare(`SELECT v.payload_json,v.version_id FROM financial_complete_current c JOIN financial_complete_versions v ON v.version_id=c.version_id WHERE c.cik=?`).bind(target.cik).first<{payload_json:string;version_id:string}>();
  if (!current) throw new Error('REPUBLICATION_NO_COMPLETE_STATEMENTS');
  const history = await readRevenueHistory(db,target.cik,target.ticker);
  if (!history) throw new Error('REPUBLICATION_NO_HISTORY');
  const flow = rebuildPublication(publicFlowSchema.parse(JSON.parse(current.payload_json)),history.quarters,at);
  const generation = await db.prepare(`SELECT max(generation) generation FROM (
    SELECT generation FROM financial_complete_versions WHERE cik=? UNION ALL SELECT generation FROM financial_collection_jobs WHERE cik=?)`)
    .bind(target.cik,target.cik).first<{generation:number|null}>();
  const nextGeneration = Math.max(now.getTime(),(generation?.generation??0)+1);
  // Resolve share classes separately to stay within D1's compound SELECT limit.
  const tickerSources = await Promise.all([
    db.prepare('SELECT DISTINCT ticker FROM financial_collection_jobs WHERE cik=?').bind(target.cik).all<{ticker:string}>(),
    db.prepare('SELECT DISTINCT ticker FROM sec_filings WHERE cik=?').bind(target.cik).all<{ticker:string}>(),
    db.prepare('SELECT DISTINCT ticker FROM financial_complete_versions WHERE cik=?').bind(target.cik).all<{ticker:string}>(),
    db.prepare(`SELECT substr(cache_key,length('admin:financial-issuer:')+1) ticker FROM sec_cache
      WHERE cache_key LIKE 'admin:financial-issuer:%' AND json_valid(payload) AND json_extract(payload,'$.cik')=?`).bind(target.cik).all<{ticker:string}>(),
  ]);
  const tickers = [...new Set([target.ticker,flow.ticker,...tickerSources.flatMap(source=>source.results.map(row=>row.ticker))])];
  const owns = `EXISTS(SELECT 1 FROM financial_maintenance_tasks WHERE task_id=? AND lease_token=? AND status='running' AND lease_until>?)`;
  const owned = [target.taskId,target.leaseToken,at];
  const results = await db.batch([
    db.prepare(`INSERT INTO financial_complete_versions(version_id,cik,ticker,generation,payload_json,published_at)
      SELECT ?,?,?,?,?,? WHERE ${owns} AND EXISTS(SELECT 1 FROM financial_complete_current WHERE cik=? AND version_id=?) ON CONFLICT(version_id) DO NOTHING`)
      .bind(version,target.cik,flow.ticker,nextGeneration,JSON.stringify(flow),at,...owned,target.cik,current.version_id),
    db.prepare(`UPDATE financial_complete_current SET version_id=?,generation=? WHERE cik=? AND version_id=? AND ${owns}
      AND EXISTS(SELECT 1 FROM financial_complete_versions WHERE version_id=?)`)
      .bind(version,nextGeneration,target.cik,current.version_id,...owned,version),
    // Include share classes already served through this issuer, not only the requested ticker.
    ...tickers.flatMap(ticker=>['company','fundamentals','capital'].map(resource=>db.prepare(`INSERT INTO publication_revisions(ticker,resource,revision)
      SELECT ?,?,? WHERE ${owns} AND EXISTS(SELECT 1 FROM financial_complete_current WHERE cik=? AND version_id=?)
      ON CONFLICT(ticker,resource) DO UPDATE SET revision=CASE WHEN publication_revisions.revision>=excluded.revision THEN strftime('%Y-%m-%dT%H:%M:%fZ',publication_revisions.revision,'+0.001 seconds') ELSE excluded.revision END`)
      .bind(ticker,resource,at,...owned,target.cik,version))),
  ]);
  if (!results[1].meta.changes) throw new Error('REPUBLICATION_LEASE_OR_VERSION_CHANGED');
  return version;
}
