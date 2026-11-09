import { knownCik } from '../pipeline/identity.ts';
import { dataTickersFor } from '../core.ts';
import type { BusinessMapCharts, BusinessMapCompanies, BusinessMapCompany, BusinessMapDirectory, BusinessMapFlow, FeatureRunProgress } from '../../../../shared/analysis-contract/business-map-admin.ts';
import type { AiRunKind } from '../../../../shared/analysis-contract/ai-runs-admin.ts';
import { FEATURES, LAYER_REQUIRES, LAYERS, type Feature, type Layer } from '../../../../shared/analysis-contract/business-features.ts';
import { isFeature, layersAbove } from '../../../../shared/analysis-runtime/business-features.ts';
import { companyPolicyEnvironment, featureCompaniesFor, featureEnabled } from '../financial-data/company-policy.ts';
import { writeFeatureSetting } from './feature-settings.ts';
import { scheduledAnalysisOn, setScheduledAnalysis } from '../pipeline/scheduled-analysis.ts';
import { AiRunStore } from '../ai-runs/store.ts';
import { readFlow } from './flow.ts';
import { readCompanyUsage } from './company-usage.ts';
import { companyLayerStatuses } from './company-status.ts';
import { FEATURE_TASKS, KIND_FEATURE, latestOutcomes, listMessages, markRead, TASK_FEATURE } from './messages.ts';
import { failedInputKey } from '../pipeline/workflow-task.ts';
import type { AnalysisEnv } from '../operations.ts';
import { authenticateAdmin } from './auth.ts';
import { listFinancialCompanies } from './financials.ts';
import { FinancialMaintenanceStore, taskView, type MaintenanceRow } from './financial-maintenance-store.ts';
import { flowForIssuer } from '../financial-data/publication.ts';
import { publicFlowSchema } from '../../../../shared/analysis-runtime/financial-data/schema.ts';
import { checkCompleteFlow, newestPair } from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import { dataTickers, normalizeTicker } from "../../../../shared/analysis-runtime/financial-data/policy.ts";

import { emit } from '../pipeline/outbox.ts';
import { readCompletePublicationForTicker } from '../financial-data/publication.ts';
import { readMapDerived } from '../financial-data/derived.ts';
import { discoverDataIssuer } from '../financial-data/provider.ts';
import { edgarListings } from '../sec-archive/index.ts';
import { D1SecRepository } from '../sec/d1.ts';
import { issuerDirectory, primaryTicker, searchIssuers, securities, type IssuerEntry } from '../catalog/issuer-directory.ts';
import { json } from "./http.ts";
import { readValuationCompanyInputs, writeValuationCompanyInputs } from '../valuation/curated.ts';
import { readFiscalFocus } from '../read-api/fiscal-periods.ts';
import type { ValuationCompanyInputs } from '../../../../shared/analysis-contract/valuation.ts';

/** Forgets the failed inputs of a feature's tasks for a company, so a retry is not made to wait or refused. */
async function clearFailures(db: D1Database, ticker: string, feature: Feature): Promise<void> {
  await db.prepare("DELETE FROM sec_cache WHERE cache_key IN (SELECT value FROM json_each(?))").bind(JSON.stringify(FEATURE_TASKS(feature).map(task=>failedInputKey(task,ticker)))).run();
}
/**
 * Each feature's work in flight per company (`feature:ticker`): the SEC report jobs for the reports, the AI run store
 * for the model Workflows, and the due table for runs waiting their turn. Running beats queued. A running job or run
 * also brings how far it got: the report job's stage, or the steps a model Workflow has entered. How the last run ended
 * is the inbox's (messages.ts).
 */
async function featureRuns(db: D1Database, now = Date.now()): Promise<Map<string,{state:'running'|'queued';at:string;progress:FeatureRunProgress[]}>> {
  const rank = { running:2, queued:1 } as const;
  const found = new Map<string,{state:'running'|'queued';at:string;progress:FeatureRunProgress[]}>();
  const note = (feature: Feature, ticker: string, state: 'running'|'queued', at: string, progress?: FeatureRunProgress) => {
    const key=`${feature}:${ticker}`, seen=found.get(key) ?? {state, at, progress:[]};
    if (rank[state] > rank[seen.state] || (rank[state] === rank[seen.state] && at > seen.at)) { seen.state = state; seen.at = at; }
    if (progress) seen.progress.push(progress);
    found.set(key, seen);
  };
  const store = new AiRunStore(db);
  const [jobs, runs, due] = await Promise.all([
    db.prepare("SELECT ticker, status, current_stage stage, created_at startedAt, updated_at at FROM sec_analysis_jobs WHERE status IN ('queued','running') AND updated_at >= ?").bind(new Date(now-2*3600_000).toISOString()).all<{ticker:string;status:string;stage:string;startedAt:string;at:string}>().catch(()=>({results:[]})),
    store.latestRuns().catch(()=>new Map<string,{runId:string;status:string;stage:string|null;startedAt:string;updatedAt:string}>()),
    db.prepare("SELECT ticker, task, due_at FROM pipeline_due WHERE due_at > ?").bind(new Date(now).toISOString()).all<{ticker:string;task:string;due_at:string}>().catch(()=>({results:[]})),
  ]);
  for (const job of jobs.results) {
    const running = job.status === 'running';
    note('filings', job.ticker, running ? 'running' : 'queued', job.at, running ? {kind:'report', status:'running', stage:job.stage, steps:[], startedAt:job.startedAt, updatedAt:job.at} : undefined);
  }
  // Only runs in flight read their step log: a few rows, not every company's history.
  await Promise.all([...runs].map(async ([key, run]) => {
    const [kind, ticker] = key.split(':') as [AiRunKind, string];
    const feature = KIND_FEATURE[kind];
    if (!feature) return;
    if (run.status === 'running' || run.status === 'waiting') {
      const full = await store.get(kind, ticker, run.runId).catch(() => null);
      note(feature, ticker, 'running', run.updatedAt, {kind, status:run.status, stage:run.stage, steps:full?.log ?? [], startedAt:run.startedAt, updatedAt:run.updatedAt});
    }
    else if (run.status === 'queued') note(feature, ticker, 'queued', run.updatedAt);
  }));
  for (const row of due.results) { const feature = TASK_FEATURE[row.task]; if (feature && row.ticker !== '*') note(feature, row.ticker, 'queued', row.due_at); }
  return found;
}
/** The newest publication of each feature per company, from where the feature stores it. */
const PUBLISHED: Record<Feature,string> = {
  filings: "SELECT ticker, max(generated_at) at FROM sec_published_reports GROUP BY ticker",
  findings: "SELECT substr(cache_key,13) ticker, fetched_at at FROM sec_cache WHERE cache_key >= 'findings:v2:' AND cache_key < 'findings:v2;'",
  tree: "SELECT substr(cache_key,18) ticker, fetched_at at FROM sec_cache WHERE cache_key >= 'business-tree:v1:' AND cache_key < 'business-tree:v1;'",
  valuation: "SELECT c.ticker, v.generated_at at FROM valuation_current c JOIN valuation_versions v ON v.version_id = c.version_id",
};
const LAYER_LABEL: Record<Layer,string> = { map: '财报桑基图', filings: 'SEC 文件解析', findings: '关键点', tree: '业务解析', valuation: '估值' };
const DIRECTORY_PAGE = 50;
/**
 * Every US-listed company in EDGAR's exchange directory, one row per issuer (its first-listed class; the others listed
 * beside it), ETFs left out, with the five layer switches as they stand. `filter=on` keeps the companies with layer 1
 * on; a query ranks by ticker and name over the whole directory.
 */
export function directoryPage(entries: IssuerEntry[], etf: (ticker: string) => boolean, layers: (ticker: string) => Record<Layer, boolean>,
  query: string, filter: 'on' | 'all', page: number): BusinessMapDirectory {
  const issuers = new Map<string, { entry: IssuerEntry; classes: string[] }>();
  for (const entry of entries) {
    if (etf(entry[0])) continue;
    const key = entry[3] || entry[0], seen = issuers.get(key);
    if (seen) seen.classes.push(entry[0]); else issuers.set(key, { entry, classes: [] });
  }
  let rows = [...issuers.values()];
  if (query.trim()) {
    const order = new Map(searchIssuers(rows.map(r => r.entry), query, 500).map((s, i) => [s.ticker, i]));
    rows = rows.filter(r => order.has(r.entry[0])).sort((a, b) => order.get(a.entry[0])! - order.get(b.entry[0])!);
  }
  const shaped = rows.map(({ entry: [ticker, name, exchange, cik], classes }) => ({ ticker, name, exchange, cik, classes, layers: layers(ticker) }));
  const kept = filter === 'on' ? shaped.filter(r => r.layers.map) : shaped;
  if (!query.trim()) kept.sort((a, b) => Number(b.layers.map) - Number(a.layers.map) || a.ticker.localeCompare(b.ticker));
  const pages = Math.max(1, Math.ceil(kept.length / DIRECTORY_PAGE)), at = Math.min(Math.max(1, page), pages);
  return { total: kept.length, page: at, pages, rows: kept.slice((at - 1) * DIRECTORY_PAGE, at * DIRECTORY_PAGE) };
}
export async function handleBusinessMapAdminRequest(request: Request, env: AnalysisEnv): Promise<Response> {
  if (!await authenticateAdmin(request, env.REPORT_ADMIN_PASSWORD, Date.now())) return json({error:'请登录管理后台。'},401);
  if (!env.DB) return json({error:'数据服务尚未连接。'},503);
  const db = env.DB, path = new URL(request.url).pathname;
  try {
    if (path === '/admin/business-map/directory' && request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      const filter = params.get('filter') === 'all' ? 'all' : 'on';
      let entries: IssuerEntry[];
      try { entries = await issuerDirectory(db, edgarListings(env, { delayMs: 0 })); }
      catch { return json({error:'暂时无法访问 SEC 发行人目录，请稍后重试。'},503); }
      const security = await securities(db).catch(() => () => null);
      const data = new Set(dataTickersFor(env));
      const lists = Object.fromEntries(FEATURES.map(f => [f, new Set(featureCompaniesFor(env, f))])) as Record<Feature, Set<string>>;
      const layers = (ticker: string) => Object.fromEntries(LAYERS.map(l => [l, l === 'map' ? data.has(ticker) : lists[l].has(ticker)])) as Record<Layer, boolean>;
      return json(directoryPage(entries, t => security(t)?.etf ?? false, layers, params.get('q') ?? '', filter, Number(params.get('page')) || 1) satisfies BusinessMapDirectory);
    }
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
      // What each feature has published, by company: the newest publication's time, read once per feature.
      const published = Object.fromEntries(await Promise.all(FEATURES.map(async feature=>[feature,new Map((await db.prepare(PUBLISHED[feature]).bind().all<{ticker:string;at:string}>().catch(()=>({results:[]}))).results.map(r=>[r.ticker,r.at]))]))) as Record<Feature,Map<string,string>>;
      const lists = Object.fromEntries(FEATURES.map(feature=>[feature,featureCompaniesFor(env,feature)])) as Record<Feature,string[]>;
      const [runs, outcomes, scheduledAnalysis] = await Promise.all([featureRuns(db), latestOutcomes(db), scheduledAnalysisOn(db)]);
      const generation=Object.fromEntries(FEATURES.map(feature=>[feature,featureEnabled(env,feature)])) as Record<Feature,boolean>;
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
        const presentation={model:newest?.incomeModel??null,source:newest?.presentation?.source??null,afterTax:(newest?.afterTaxComponents??[]).map(c=>({name:c.name,value:c.amount.value??''})),basisChanges:newest?.basisChanges??[],
          profile:row.profileStatus?{status:row.profileStatus,accession:row.profileAccession??'',attempts:row.profileAttempts??0,issues:JSON.parse(row.profileIssues??'[]') as string[],updatedAt:row.profileUpdatedAt??''}:null};
        const features=Object.fromEntries(FEATURES.map(feature=>{
          const key=`${feature}:${company.ticker}`, on=lists[feature].includes(company.ticker), last=outcomes.get(key);
          // A failure switched the feature off; switched on again, it is being retried and no longer the state.
          return [feature,{on,publishedAt:published[feature].get(company.ticker)??null,run:runs.get(key)?.state??null,progress:runs.get(key)?.progress??[],failure:!on&&last?.outcome==='failed'?{at:last.updatedAt,detail:last.detail}:null}];
        })) as BusinessMapCompany['features'];
        const current: Omit<BusinessMapCompany, 'layerStatuses'> = {...company,presentation,features,task:row.task_id?taskView(row):null,history:row.historyTotal!==null?{completed:row.historyCompleted??0,total:row.historyTotal}:null,
          collection:row.collectionStatus?{status:row.collectionStatus,reasons,updatedAt:row.collectionUpdatedAt!,completed:row.collectionCompleted??0,total:row.collectionTotal??0}
            :row.discovery?{status:'unavailable',reasons:[JSON.parse(row.discovery).reason],updatedAt:row.discoveryAt!,completed:0,total:0}:null,
          publication:{status:flow?'ready':invalid||row.collectionStatus==='unavailable'?'unavailable':'preparing',
            outdated:!!flow&&!!row.collectionStatus&&row.collectionStatus!=='succeeded',
            reasons:invalid?['INVALID_PAYLOAD']:reasons.length?reasons:flow?[]:['MISSING_TWO_QUARTERS'],periods:flow?.quarters.map(q=>q.periodEnd)??[],revenueCoverage:flow?.quarters.map(q=>({period:q.periodEnd,status:q.segmentDisclosure==='single_reportable_segment'?'single_segment' as const:q.segments.some(s=>s.id==='reported-company-total')?'unverified' as const:'verified' as const,segments:q.segments.length,adjustments:q.revenueAdjustments?.length??0}))??[]}};
        return {...current, layerStatuses:companyLayerStatuses(current, {automaticCollection:list.environment.dataCollectionEnabled,generation})};
      });
      return json({companies,automaticCollection:list.environment.dataCollectionEnabled,scheduledAnalysis,generation} satisfies BusinessMapCompanies);
    }
    const usage = /^\/admin\/business-map\/companies\/([^/]+)\/usage$/.exec(path);
    if (usage && request.method === 'GET') {
      const ticker = normalizeTicker(decodeURIComponent(usage[1]!));
      if (!ticker) return json({error:'公司代码无效。'},400);
      return json(await readCompanyUsage(db, ticker));
    }
    // One company's analysis as a graph: the registry's tasks for the map and its features, and where each stands now.
    const flow = /^\/admin\/business-map\/companies\/([^/]+)\/flow$/.exec(path);
    if (flow && request.method === 'GET') {
      const ticker = normalizeTicker(decodeURIComponent(flow[1]!));
      if (!ticker) return json({error:'公司代码无效。'},400);
      return json(await readFlow(db, ticker) satisfies BusinessMapFlow);
    }
    // The three BusinessView charts as the map reads them: profit from the published flow and its archived quarters,
    // cash flow and balance sheet from the derived capital structure. Read only, like the map's own routes.
    const charts = /^\/admin\/business-map\/companies\/([^/]+)\/charts$/.exec(path);
    if (charts && request.method === 'GET') {
      const ticker = normalizeTicker(decodeURIComponent(charts[1]!));
      if (!ticker) return json({error:'公司代码无效。'},400);
      const publication = await readCompletePublicationForTicker(db, ticker);
      const derived = publication.flow ? await readMapDerived(db, publication.flow) : null;
      // As the map merges them: archived quarters first, the published pair overriding any period they share.
      const flow = publication.flow;
      const profit = flow ? {...flow, quarters: [...new Map([...(derived?.reports?.quarters ?? []), ...flow.quarters].map(q => [q.periodEnd, q])).values()].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))} : null;
      return json({ticker, status: publication.status, reasons: publication.reasons, profit, capital: derived?.capital ?? null} satisfies BusinessMapCharts);
    }
    // The feature switches, applied by company-policy.ts. Per company, one
    if (path === '/admin/business-map/scheduled-analysis' && request.method === 'POST') {
      const body = await request.json() as {on?:unknown};
      if (typeof body.on !== 'boolean') return json({error:'操作参数无效。'},400);
      await setScheduledAnalysis(env,body.on);
      return json({on:body.on},200);
    }
    // switch: on generates the feature and shows it, off stops generating and hides what was written (it stays stored).
    // Global: whether the feature is generated for anyone; what is shown follows the company switches. Each change emits
    // `feature.settings`, which checks for something to write and moves the map's revisions.
    const globalSwitch = /^\/admin\/business-map\/features\/([a-z]+)$/.exec(path);
    if (globalSwitch && request.method === 'POST') {
      const feature = globalSwitch[1];
      const body = await request.json() as {on?:boolean};
      if (!isFeature(feature) || typeof body.on !== 'boolean') return json({error:'操作参数无效。'},400);
      await writeFeatureSetting(db,'*',feature,body.on,new Date().toISOString());
      // Generation resumed: every company switched on is checked once for something to write.
      if (body.on) await emit(env,featureCompaniesFor(await companyPolicyEnvironment(env),feature).map(ticker=>({type:'feature.settings' as const,ticker,detail:{feature}})));
      return json({feature,on:body.on},200);
    }
    const companySwitch = /^\/admin\/business-map\/companies\/([^/]+)\/features\/([a-z]+)$/.exec(path);
    if (companySwitch && request.method === 'POST') {
      const ticker = normalizeTicker(decodeURIComponent(companySwitch[1]!)), feature = companySwitch[2];
      const body = await request.json() as {on?:boolean};
      if (!ticker || !isFeature(feature) || typeof body.on !== 'boolean') return json({error:'公司代码或操作参数无效。'},400);
      // The ladder: a layer opens only over the layer below it, and closing a layer closes every layer above.
      const policy = await companyPolicyEnvironment(env);
      const below = LAYER_REQUIRES[feature];
      const belowOn = below === 'map' ? dataTickersFor(policy).includes(ticker) : !!below && featureCompaniesFor(policy, below).includes(ticker);
      if (body.on && !belowOn) return json({error:`请先开启该公司的${LAYER_LABEL[below!]}。`},409);
      const now = new Date().toISOString();
      await writeFeatureSetting(db,ticker,feature,body.on,now);
      // Switched on again after a failure: the failed input no longer holds the feature's tasks back, it runs at once.
      if (body.on) await clearFailures(db,ticker,feature);
      const closed = body.on ? [] : layersAbove(feature).filter((f): f is Feature => f !== 'map' && featureCompaniesFor(policy, f).includes(ticker));
      for (const f of closed) await writeFeatureSetting(db,ticker,f,false,now);
      const cik = await knownCik(db,ticker);
      await emit(env,[feature,...closed].map(f=>({type:'feature.settings' as const,ticker,cik,detail:{feature:f}})));
      return json({ticker,feature,on:body.on},200);
    }
    if (path === '/admin/business-map/messages' && request.method === 'GET') return json(await listMessages(db));
    // The ticker field's suggestions: EDGAR's exchange directory, searched by ticker or name.
    if (path === '/admin/business-map/issuers' && request.method === 'GET') {
      const query = new URL(request.url).searchParams.get('q') ?? '';
      if (!query.trim()) return json({issuers:[]});
      try { return json({issuers: searchIssuers(await issuerDirectory(db, edgarListings(env, { delayMs: 0 })), query)}); }
      catch { return json({error:'暂时无法访问 SEC 发行人目录，请稍后重试。'},503); }
    }
    if (path === '/admin/business-map/messages/read' && request.method === 'POST') {
      const body = await request.json().catch(()=>({})) as {ids?:unknown};
      const ids = Array.isArray(body.ids) ? body.ids.filter((id):id is string=>typeof id==='string').slice(0,500) : null;
      await markRead(db, ids);
      return json(await listMessages(db));
    }
    // Judge the issuer's income statement again (presentation-task.ts): forget the filing it was judged on and ask.
    const judge = /^\/admin\/business-map\/companies\/([^/]+)\/presentation$/.exec(path);
    if (judge && request.method === 'POST') {
      const ticker = normalizeTicker(decodeURIComponent(judge[1]!));
      if (!ticker) return json({error:'公司代码无效。'},400);
      const cik = await knownCik(db, ticker);
      if (cik) await db.prepare("UPDATE financial_presentation_profiles SET accession='' WHERE cik=?").bind(cik).run();
      await emit(env,[{type:'presentation.unresolved',ticker,cik}]);
      return json({ticker,requested:true},202);
    }
    // The valuation inputs the admin keeps for a company (valuation/curated.ts): its comparable set and management's
    // cited targets. Saving one emits `feature.settings` for the valuation, which runs again when its input changed.
    const valuation = /^\/admin\/business-map\/companies\/([^/]+)\/valuation-inputs$/.exec(path);
    if (valuation && (request.method === 'GET' || request.method === 'POST')) {
      const ticker = normalizeTicker(decodeURIComponent(valuation[1]!));
      if (!ticker) return json({error:'公司代码无效。'},400);
      const fiscalYearEndMonth = await readFiscalFocus(db, ticker).then(map => map.issuers.get(ticker)?.fiscalYearEndMonth ?? null).catch(() => null);
      if (request.method === 'GET') return json({...await readValuationCompanyInputs(db, ticker), fiscalYearEndMonth} satisfies ValuationCompanyInputs);
      const body = await request.json().catch(() => null) as {peers?:unknown;targets?:unknown;reassess?:unknown}|null;
      if (!body || !('peers' in body) || !('targets' in body) || typeof body.reassess !== 'boolean') return json({error:'操作参数无效。'},400);
      let saved: Omit<ValuationCompanyInputs,'fiscalYearEndMonth'>;
      try { saved = await writeValuationCompanyInputs(db, ticker, {peers: body.peers, targets: body.targets, reassess: body.reassess}, new Date().toISOString()); }
      catch (error) { return json({error: error instanceof Error ? error.message : '估值输入无效。'},400); }
      await emit(env,[{type:'feature.settings',ticker,cik:await knownCik(db,ticker),detail:{feature:'valuation'}}]);
      return json({...saved, fiscalYearEndMonth} satisfies ValuationCompanyInputs);
    }
    const match = /^\/admin\/business-map\/companies\/([^/]+)$/.exec(path);
    if (!match || request.method !== 'POST') return json({error:'Not found'},404);
    let ticker = normalizeTicker(match[1]);
    const body = await request.json() as {enabled?:boolean;requestId?:string};
    // A second share class joins as the class EDGAR lists first for its issuer, so one company is never kept twice.
    if (ticker && body.enabled === true) ticker = primaryTicker(await issuerDirectory(db, edgarListings(env, { delayMs: 0 })).catch(() => []), ticker);
    if (!ticker || typeof body.enabled !== 'boolean' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.requestId??'')) return json({error:'公司代码或操作参数无效。'},400);
    const receipt=await db.prepare('SELECT ticker,enabled FROM financial_company_setting_requests WHERE request_id=?').bind(body.requestId).first<{ticker:string;enabled:number}>();
    if(receipt)return receipt.ticker===ticker&&receipt.enabled===Number(body.enabled)?json({ticker,enabled:body.enabled,reused:true}):json({error:'操作标识已用于不同请求。'},409);
    const now = new Date().toISOString();
    const existing = await new FinancialMaintenanceStore(db).byRequest(body.requestId!);
    if (existing && existing.ticker !== ticker) return json({error:'操作标识已用于其他公司。'},409);
    // A company joins only if EDGAR's issuer directory lists it: a typo is refused here, not found hours later by the
    // maintenance task; the issuer record saved now lets discovery and collection know its CIK at once.
    if (body.enabled) {
      try {
        const issuer = await discoverDataIssuer(ticker, edgarListings(env, { delayMs: 0 }));
        await new D1SecRepository(db).setCache(`admin:financial-issuer:${ticker}`, issuer, now);
      } catch (error) {
        if (error instanceof Error && error.message === 'SEC_ISSUER_NOT_FOUND') return json({error:'SEC 发行人目录中没有这个代码。'},404);
        return json({error:'暂时无法访问 SEC 发行人目录，请稍后重试。'},503);
      }
    }
    // One D1 transaction saves the choice and its durable initial job. A retried add never
    // creates another job, and repeated enable of a default company does not restart collection.
    const defaultEnabled = dataTickers(env).has(ticker);
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
    // Layer 1 off closes every layer above it (the ladder); what they wrote stays stored.
    if(!body.enabled){
      const policy=await companyPolicyEnvironment(env);
      const closed=FEATURES.filter(f=>featureCompaniesFor(policy,f).includes(ticker));
      for(const f of closed)await writeFeatureSetting(db,ticker,f,false,now);
      const cik=await knownCik(db,ticker);
      await emit(env,[{type:'feature.settings' as const,ticker,cik,detail:{feature:'map' as const}},...closed.map(f=>({type:'feature.settings' as const,ticker,cik,detail:{feature:f}}))]);
    }
    // A newly added company starts with an extract task; the maintenance task picks it up, and its event rail is built.
    if(await db.prepare('SELECT 1 FROM financial_maintenance_tasks WHERE request_id=?').bind(body.requestId).first()){
      const cik=await knownCik(db,ticker);
      await emit(env,[{type:'company.added',ticker,cik},{type:'maintenance.requested',ticker,cik}]);
    }
    return json({ticker,enabled:body.enabled},200);
  } catch (error) {
    if (error instanceof SyntaxError) return json({error:'操作参数无效。'},400);
    return json({error:'公司配置服务暂时不可用，请重试。'},503);
  }
}
