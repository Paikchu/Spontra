import { knownCik } from '../pipeline/identity.ts';
import { dataTickersFor, trackedTickersFor } from '../core.ts';
import type { BusinessMapCharts, BusinessMapCompanies } from '../../../../shared/analysis-contract/business-map-admin.ts';
import type { SecPipelineEnv } from '../operations.ts';
import { authenticateAdmin } from './auth.ts';
import { listFinancialCompanies } from './financials.ts';
import { FinancialMaintenanceStore, taskView, type MaintenanceRow } from './financial-maintenance-store.ts';
import { flowForIssuer } from '../financial-data/publication.ts';
import { publicFlowSchema } from '../../../../shared/analysis-runtime/financial-data/schema.ts';
import { checkCompleteFlow, newestPair } from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import { financialPolicy } from '../../../../shared/analysis-runtime/financial-data/policy.ts';
import { normalizeTrackedTicker } from '../sec/config.ts';
import { emit } from '../pipeline/outbox.ts';
import { readCompletePublicationForTicker } from '../financial-data/publication.ts';
import { readMapDerived } from '../financial-data/derived.ts';

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
        json_extract(h.payload,'$.index') historyCompleted,json_array_length(h.payload,'$.documents') historyTotal,v.payload_json snapshot,d.payload discovery,d.fetched_at discoveryAt,
        f.status profileStatus,f.accession profileAccession,f.attempts profileAttempts,f.issues_json profileIssues,f.updated_at profileUpdatedAt
      FROM companies c
      LEFT JOIN financial_maintenance_tasks m ON m.task_id=(SELECT task_id FROM financial_maintenance_tasks WHERE ticker=c.ticker ORDER BY created_at DESC,task_id DESC LIMIT 1)
      LEFT JOIN financial_collection_jobs j ON j.job_id=(SELECT job_id FROM financial_collection_jobs WHERE ticker=c.ticker ORDER BY generation DESC LIMIT 1)
      LEFT JOIN financial_complete_current p ON p.cik=c.cik
      LEFT JOIN financial_complete_versions v ON v.version_id=p.version_id
      LEFT JOIN sec_cache h ON h.cache_key='sec:revenue-history-cursor:v1:'||c.cik
      LEFT JOIN sec_cache d ON d.cache_key='sec:financial-discovery-failure:v1:'||c.ticker
      LEFT JOIN financial_presentation_profiles f ON f.cik=c.cik`)
        .bind(JSON.stringify(list.companies.map(({ticker,cik})=>({ticker,cik})))).all<MaintenanceRow & {
          companyTicker:string;collectionStatus:string|null;collectionReasons:string|null;collectionUpdatedAt:string|null;collectionCompleted:number|null;collectionTotal:number|null;
          historyCompleted:number|null;historyTotal:number|null;snapshot:string|null;discovery:string|null;discoveryAt:string|null;
          profileStatus:'verified'|'unresolved'|null;profileAccession:string|null;profileAttempts:number|null;profileIssues:string|null;profileUpdatedAt:string|null;
        }>();
      const byTicker = new Map(rows.results.map(row=>[row.companyTicker,row]));
      const companies: BusinessMapCompanies['companies'] = list.companies.map(company=>{
        const row=byTicker.get(company.ticker)!;
        const reasons:string[]=JSON.parse(row.collectionReasons??'[]');
        let flow=null, invalid=false;
        try {
          const raw=row.snapshot;
          if(raw){const parsed=newestPair(publicFlowSchema.parse(JSON.parse(raw)));
            const candidate=parsed.ticker===company.ticker?parsed:company.cik?flowForIssuer(parsed,company.cik,company.ticker):null;
            if(candidate&&checkCompleteFlow(candidate).complete)flow=candidate;else invalid=true;}
        } catch { invalid=true; }
        const newest=flow?.quarters[0];
        const presentation={source:newest?.presentation?.source??null,afterTax:(newest?.afterTaxComponents??[]).map(c=>({name:c.name,value:c.amount.value??''})),basisChanges:newest?.basisChanges??[],
          profile:row.profileStatus?{status:row.profileStatus,accession:row.profileAccession??'',attempts:row.profileAttempts??0,issues:JSON.parse(row.profileIssues??'[]') as string[],updatedAt:row.profileUpdatedAt??''}:null};
        return {...company,presentation,task:row.task_id?taskView(row):null,history:row.historyTotal!==null?{completed:row.historyCompleted??0,total:row.historyTotal}:null,
          collection:row.collectionStatus?{status:row.collectionStatus,reasons,updatedAt:row.collectionUpdatedAt!,completed:row.collectionCompleted??0,total:row.collectionTotal??0}
            :row.discovery?{status:'unavailable',reasons:[JSON.parse(row.discovery).reason],updatedAt:row.discoveryAt!,completed:0,total:0}:null,
          publication:{status:flow?'ready':invalid||row.collectionStatus==='unavailable'?'unavailable':'preparing',
            outdated:!!flow&&!!row.collectionStatus&&row.collectionStatus!=='succeeded',
            reasons:invalid?['INVALID_PAYLOAD']:reasons.length?reasons:flow?[]:['MISSING_TWO_QUARTERS'],periods:flow?.quarters.map(q=>q.periodEnd)??[],revenueCoverage:flow?.quarters.map(q=>({period:q.periodEnd,status:q.segmentDisclosure==='single_reportable_segment'?'single_segment' as const:q.segments.some(s=>s.id==='reported-company-total')?'unverified' as const:'verified' as const,segments:q.segments.length,adjustments:q.revenueAdjustments?.length??0}))??[]}};
      });
      return json({companies,automaticCollection:list.environment.dataCollectionEnabled} satisfies BusinessMapCompanies);
    }
    // The three BusinessView charts as the map reads them: profit from the published flow and its archived quarters,
    // cash flow and balance sheet from the derived capital structure. Read only, like the map's own routes.
    const charts = /^\/admin\/business-map\/companies\/([^/]+)\/charts$/.exec(path);
    if (charts && request.method === 'GET') {
      const ticker = normalizeTrackedTicker(decodeURIComponent(charts[1]!));
      if (!ticker) return json({error:'公司代码无效。'},400);
      const publication = await readCompletePublicationForTicker(db, ticker);
      const derived = publication.flow ? await readMapDerived(db, publication.flow) : null;
      // As the map merges them: archived quarters first, the published pair overriding any period they share.
      const flow = publication.flow;
      const profit = flow ? {...flow, quarters: [...new Map([...(derived?.reports?.quarters ?? []), ...flow.quarters].map(q => [q.periodEnd, q])).values()].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))} : null;
      return json({ticker, status: publication.status, reasons: publication.reasons, profit, capital: derived?.capital ?? null} satisfies BusinessMapCharts);
    }
    // The AI switch (company-policy.ts): a row overrides SEC_AI_TICKERS for its company. Switching a company on starts its
    // AI work (`ai.enabled`); switching it off stops new runs, and what was published stays until the storage sweep.
    const ai = /^\/admin\/business-map\/companies\/([^/]+)\/ai$/.exec(path);
    if (ai && request.method === 'POST') {
      const ticker = normalizeTrackedTicker(decodeURIComponent(ai[1]!));
      const body = await request.json() as {enabled?:boolean};
      if (!ticker || typeof body.enabled !== 'boolean') return json({error:'公司代码或操作参数无效。'},400);
      if (body.enabled && !dataTickersFor(env).includes(ticker)) return json({error:'请先把该公司加入白名单。'},409);
      const before = trackedTickersFor(env).includes(ticker);
      await db.prepare('INSERT INTO financial_ai_settings(ticker,enabled,updated_at) VALUES(?,?,?) ON CONFLICT(ticker) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at')
        .bind(ticker,body.enabled?1:0,new Date().toISOString()).run();
      if (body.enabled && !before) await emit(env,[{type:'ai.enabled',ticker,cik:await knownCik(db,ticker)}]);
      return json({ticker,aiEnabled:body.enabled},200);
    }
    // Judge the issuer's income statement again (presentation-task.ts): forget the filing it was judged on and ask.
    const judge = /^\/admin\/business-map\/companies\/([^/]+)\/presentation$/.exec(path);
    if (judge && request.method === 'POST') {
      const ticker = normalizeTrackedTicker(decodeURIComponent(judge[1]!));
      if (!ticker) return json({error:'公司代码无效。'},400);
      const cik = await knownCik(db, ticker);
      if (cik) await db.prepare("UPDATE financial_presentation_profiles SET accession='' WHERE cik=? AND status='unresolved'").bind(cik).run();
      await emit(env,[{type:'presentation.unresolved',ticker,cik}]);
      return json({ticker,requested:true},202);
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
    // A newly added company starts with an extract task; the maintenance task picks it up.
    if(await db.prepare('SELECT 1 FROM financial_maintenance_tasks WHERE request_id=?').bind(body.requestId).first())await emit(env,[{type:'maintenance.requested',ticker}]);
    return json({ticker,enabled:body.enabled},200);
  } catch (error) {
    if (error instanceof SyntaxError) return json({error:'操作参数无效。'},400);
    return json({error:'公司配置服务暂时不可用，请重试。'},503);
  }
}
