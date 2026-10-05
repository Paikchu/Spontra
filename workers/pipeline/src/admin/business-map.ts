import type { BusinessMapCompanies } from '../../../../shared/analysis-contract/business-map-admin.ts';
import type { SecPipelineEnv } from '../operations.ts';
import { authenticateAdmin } from './auth.ts';
import { listFinancialCompanies } from './financials.ts';
import { FinancialMaintenanceStore, taskView, type MaintenanceRow } from './financial-maintenance-store.ts';
import { flowForIssuer } from '../financial-data/publication.ts';
import { publicFlowSchema } from '../../../../shared/analysis-runtime/financial-data/schema.ts';
import { checkCompleteFlow, newestPair } from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import { withLegacyInterestFormula } from '../../../../shared/analysis-runtime/financial-data/disclosed-quarter.ts';
import { financialPolicy } from '../../../../shared/analysis-runtime/financial-data/policy.ts';
import { normalizeTrackedTicker } from '../sec/config.ts';

const json = (body: unknown, status = 200) => Response.json(body, {status, headers: {'cache-control':'private, no-store'}});
export async function handleBusinessMapAdminRequest(request: Request, env: SecPipelineEnv): Promise<Response> {
  if (!await authenticateAdmin(request, env.REPORT_ADMIN_PASSWORD, Date.now())) return json({error:'请登录管理后台。'},401);
  if (!env.DB) return json({error:'数据服务尚未连接。'},503);
  const db = env.DB, path = new URL(request.url).pathname;
  try {
    if (path === '/admin/business-map/companies' && request.method === 'GET') {
      const list = await listFinancialCompanies(env);
      const rows = await db.prepare(`WITH companies AS (
        SELECT json_extract(value,'$.ticker') ticker,json_extract(value,'$.cik') cik FROM json_each(?)
      ) SELECT c.ticker companyTicker,m.*,j.status collectionStatus,j.reasons_json collectionReasons,j.updated_at collectionUpdatedAt,json_extract(j.cursor_json,'$.index') collectionCompleted,json_array_length(j.cursor_json,'$.documents') collectionTotal,
        json_extract(h.payload,'$.index') historyCompleted,json_array_length(h.payload,'$.documents') historyTotal,v.payload_json snapshot,l.payload legacy,d.payload discovery,d.fetched_at discoveryAt
      FROM companies c
      LEFT JOIN financial_maintenance_tasks m ON m.task_id=(SELECT task_id FROM financial_maintenance_tasks WHERE ticker=c.ticker ORDER BY created_at DESC,task_id DESC LIMIT 1)
      LEFT JOIN financial_collection_jobs j ON j.job_id=(SELECT job_id FROM financial_collection_jobs WHERE ticker=c.ticker ORDER BY generation DESC LIMIT 1)
      LEFT JOIN financial_complete_current p ON p.cik=c.cik
      LEFT JOIN financial_complete_versions v ON v.version_id=p.version_id
      LEFT JOIN sec_cache h ON h.cache_key='sec:revenue-history-cursor:v1:'||c.cik
      LEFT JOIN sec_cache l ON l.cache_key='sec:business-flow:v2:'||c.ticker
      LEFT JOIN sec_cache d ON d.cache_key='sec:financial-discovery-failure:v1:'||c.ticker`)
        .bind(JSON.stringify(list.companies.map(({ticker,cik})=>({ticker,cik})))).all<MaintenanceRow & {
          companyTicker:string;collectionStatus:string|null;collectionReasons:string|null;collectionUpdatedAt:string|null;collectionCompleted:number|null;collectionTotal:number|null;
          historyCompleted:number|null;historyTotal:number|null;snapshot:string|null;legacy:string|null;discovery:string|null;discoveryAt:string|null;
        }>();
      const byTicker = new Map(rows.results.map(row=>[row.companyTicker,row]));
      const companies: BusinessMapCompanies['companies'] = list.companies.map(company=>{
        const row=byTicker.get(company.ticker)!;
        const reasons:string[]=JSON.parse(row.collectionReasons??'[]');
        let flow=null, invalid=false;
        try {
          const raw=row.snapshot??row.legacy;
          if(raw){const parsed=newestPair(withLegacyInterestFormula(publicFlowSchema.parse(JSON.parse(raw))));
            const candidate=parsed.ticker===company.ticker?parsed:company.cik?flowForIssuer(parsed,company.cik,company.ticker):null;
            if(candidate&&checkCompleteFlow(candidate).complete)flow=candidate;else invalid=true;}
        } catch { invalid=true; }
        return {...company,task:row.task_id?taskView(row):null,history:row.historyTotal!==null?{completed:row.historyCompleted??0,total:row.historyTotal}:null,
          collection:row.collectionStatus?{status:row.collectionStatus,reasons,updatedAt:row.collectionUpdatedAt!,completed:row.collectionCompleted??0,total:row.collectionTotal??0}
            :row.discovery?{status:'unavailable',reasons:[JSON.parse(row.discovery).reason],updatedAt:row.discoveryAt!,completed:0,total:0}:null,
          publication:{status:flow?'ready':invalid||row.collectionStatus==='unavailable'?'unavailable':'preparing',
            outdated:!!flow&&!!row.collectionStatus&&row.collectionStatus!=='succeeded',
            reasons:invalid?['INVALID_PAYLOAD']:reasons.length?reasons:flow?[]:['MISSING_TWO_QUARTERS'],periods:flow?.quarters.map(q=>q.periodEnd)??[],revenueCoverage:flow?.quarters.map(q=>({period:q.periodEnd,status:q.segmentDisclosure==='single_reportable_segment'?'single_segment' as const:q.segments.some(s=>s.id==='reported-company-total')?'unverified' as const:'verified' as const,segments:q.segments.length,adjustments:q.revenueAdjustments?.length??0}))??[]}};
      });
      return json({companies,automaticCollection:list.environment.dataCollectionEnabled} satisfies BusinessMapCompanies);
    }
    const match = /^\/admin\/business-map\/companies\/([^/]+)$/.exec(path);
    if (!match || request.method !== 'POST') return json({error:'Not found'},404);
    const ticker = normalizeTrackedTicker(match[1]);
    const body = await request.json() as {enabled?:boolean;requestId?:string};
    if (!ticker || typeof body.enabled !== 'boolean' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.requestId??'')) return json({error:'公司代码或操作参数无效。'},400);
    const receipt=await db.prepare('SELECT ticker,enabled FROM financial_company_setting_requests WHERE request_id=?').bind(body.requestId).first<{ticker:string;enabled:number}>();
    if(receipt)return receipt.ticker===ticker&&receipt.enabled===Number(body.enabled)?json({ticker,enabled:body.enabled,reused:true}):json({error:'操作标识已用于不同请求。'},409);
    const now = new Date().toISOString();
    const existing = await new FinancialMaintenanceStore(db).byRequest(body.requestId!);
    if (existing && existing.ticker !== ticker) return json({error:'操作标识已用于其他公司。'},409);
    // One D1 transaction saves the choice and its durable initial job. A retried add never
    // creates another job, and repeated enable of a default company does not restart collection.
    const defaultEnabled = financialPolicy({...env,SEC_AI_ENABLED:'false'}).dataTickers.has(ticker);
    await db.batch([
      db.prepare(`INSERT INTO financial_maintenance_tasks(task_id,request_id,ticker,action,status,total_steps,next_attempt_at,created_at,updated_at)
        SELECT ?,?,?,'extract','queued',4,?,?,? WHERE ?=1
        AND COALESCE((SELECT enabled FROM financial_company_settings WHERE ticker=?),?)=0
        AND NOT EXISTS(SELECT 1 FROM financial_company_setting_requests WHERE request_id=?)
        ON CONFLICT DO NOTHING`).bind(body.requestId,body.requestId,ticker,now,now,now,body.enabled?1:0,ticker,defaultEnabled?1:0,body.requestId),
      db.prepare(`INSERT INTO financial_company_settings(ticker,enabled,updated_at) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM financial_company_setting_requests WHERE request_id=?)
        ON CONFLICT(ticker) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`).bind(ticker,body.enabled?1:0,now,body.requestId),
      db.prepare('INSERT INTO financial_company_setting_requests(request_id,ticker,enabled) VALUES(?,?,?) ON CONFLICT DO NOTHING').bind(body.requestId,ticker,Number(body.enabled)),
    ]);
    const saved=await db.prepare('SELECT ticker,enabled FROM financial_company_setting_requests WHERE request_id=?').bind(body.requestId).first<{ticker:string;enabled:number}>();
    if(saved?.ticker!==ticker||saved.enabled!==Number(body.enabled))return json({error:'操作标识已用于不同请求。'},409);
    return json({ticker,enabled:body.enabled},200);
  } catch (error) {
    if (error instanceof SyntaxError) return json({error:'操作参数无效。'},400);
    return json({error:'公司配置服务暂时不可用，请重试。'},503);
  }
}
