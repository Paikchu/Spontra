/** Local reader/publisher journey and fault replay. Synthetic material never leaves this process. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { savePublicResearchDraft, reviewPublicResearch, publishPublicResearch, readPublicResearch, withdrawPublicResearch, restorePublicResearch, changedPublicClaims, type PublicResearchEnv } from "../workers/analysis/src/public-research/store.ts";
import { saveCompanyResearchExposure, freezeCompanyResearch, recordCompanyResearchDependencies, companyResearchDependencyStatus, companyResearchDependencyStatements } from "../workers/analysis/src/public-research/context.ts";
import { validatePublicResearch, distinctImpactChannels } from "../shared/analysis-runtime/public-research.ts";
import type { PublicResearchDraft, ResearchReview } from "../shared/analysis-contract/public-research.ts";

const sqlite=new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../workers/analysis/migrations/0060_public_research.sql',import.meta.url),'utf8'));
let breakBatch=false;
class Statement {
  values:unknown[]=[];
  query:string;
  constructor(query:string){this.query=query;}
  bind(...values:unknown[]){this.values=values;return this;}
  async first(){return sqlite.prepare(this.query).get(...this.values as never[])??null;}
  async all(){return {results:sqlite.prepare(this.query).all(...this.values as never[])};}
  async run(){const result=sqlite.prepare(this.query).run(...this.values as never[]);return {success:true,meta:{changes:Number(result.changes)}};}
}
const db={prepare:(query:string)=>new Statement(query),batch:async(statements:Statement[])=>{sqlite.exec('BEGIN');try{const results=[];for(const statement of statements){if(breakBatch){breakBatch=false;throw new Error('injected index failure');}results.push(await statement.run());}sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
const bodies=new Map<string,string>();
const env={DB:db,SEC_FILINGS:{get:async(key:string)=>bodies.has(key)?{text:async()=>bodies.get(key)!}:null,put:async(key:string,value:string)=>{bodies.set(key,value);}}} as unknown as PublicResearchEnv;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const asOf='2026-01-02T00:00:00.000Z',now='2026-01-03T00:00:00.000Z';
const excerpt='SYNTHETIC ACCEPTANCE SOURCE: financing rate 5 percent; not actual market data.';
const source={id:'source-1',canonicalId:'synthetic-original',uri:'https://example.com/synthetic',title:'Synthetic fixture (not market evidence)',locator:'paragraph 1',excerpt,contentHash:hash(excerpt),revision:'1',publishedAt:'2026-01-01T00:00:00.000Z',availableAt:'2026-01-01T00:00:00.000Z',collectedAt:asOf,observationPeriod:{start:'2026-01-01',end:'2026-01-01'},usage:'public' as const,authorization:'Synthetic acceptance material only'};
const draft:PublicResearchDraft={schemaVersion:'public-research.v1',reportId:'synthetic-macro',type:'macro',title:'Synthetic funding baseline',language:'en',scope:{regions:['US'],currency:'USD',industryId:null,description:'Synthetic test scope'},asOf,generatedAt:asOf,validUntil:'2099-01-01T00:00:00.000Z',inputFingerprint:hash('synthetic-input'),modelVersion:'no-model-called',promptVersion:'fixture-v1',toolVersion:'fixture-v1',coverage:'limited',missingInputs:['Synthetic data is not approved for production'],changes:['Initial synthetic baseline'],summary:'Synthetic evidence tests storage and publication only.',sources:[source],observations:[{id:'rate',sourceId:'source-1',label:'Synthetic rate',status:'observed',value:5,unit:'percent',currency:null,period:{start:'2026-01-01',end:'2026-01-01'},definition:'Synthetic contract rate, not market yield',basis:'actual',missingReason:null}],claims:Array.from({length:20},(_,i)=>({id:`claim-${i}`,kind:'fact' as const,title:`Synthetic claim ${i}`,statement:'The synthetic source states the contractual rate.',sourceIds:['source-1'],observationIds:['rate'],premiseClaimIds:[],assumptions:[],impactChannels:['Financing → contract reset → interest'],counterEvidence:['No actual issuer evidence in this fixture'],verification:'Read the synthetic source only',shockId:`shock-${i}`,financialVariable:'interest'})),dependencies:[],scenarios:[{name:'base',assumptions:['Synthetic contract persists'],claimIds:['claim-0']}],authorRunId:'synthetic-author',sections:[{id:'funding',title:'Funding',claimIds:Array.from({length:20},(_,i)=>`claim-${i}`)}]};
const review=(draft:PublicResearchDraft):ResearchReview=>({reviewer:'synthetic-independent-reviewer',reviewedAt:now,authorRunId:draft.authorRunId,claimChecks:draft.claims.map(claim=>({claimId:claim.id,supported:true,notes:'Synthetic original excerpt inspected; not a real financial review'})),conclusion:'approved',notes:'Fixture schema review only'});
const checks:Array<{name:string;status:string;detail?:unknown}>=[];
const check=(name:string,value:unknown,detail?:unknown)=>{if(!value)throw new Error(name);checks.push({name,status:'passed',detail});};
async function rejects(name:string,work:()=>unknown){try{await work();}catch(error){checks.push({name,status:'passed',detail:String(error)});return;}throw new Error(`Expected refusal: ${name}`);}

validatePublicResearch(draft,review(draft),now);
check('20 synthetic claims each carry original source and typed unit',draft.claims.length===20);
await rejects('unknown source rejected',()=>validatePublicResearch({...draft,claims:[{...draft.claims[0],sourceIds:['missing']}]},review(draft),now));
await rejects('missing differs from zero',()=>validatePublicResearch({...draft,observations:[{...draft.observations[0],status:'missing',value:0}]},review(draft),now));
await rejects('currency and amount unit mismatch rejected',()=>validatePublicResearch({...draft,observations:[{...draft.observations[0],unit:'USD_m',currency:'EUR'}]},review(draft),now));
await rejects('future evidence rejected',()=>validatePublicResearch({...draft,sources:[{...source,availableAt:'2027-01-01T00:00:00.000Z'}]},review(draft),now));
await rejects('author cannot self approve',()=>validatePublicResearch(draft,{...review(draft),reviewer:draft.authorRunId},now));
await rejects('source hash mismatch rejected',()=>savePublicResearchDraft(env,{...draft,sources:[{...source,contentHash:hash('not excerpt')}]}));
const saved=await savePublicResearchDraft(env,draft);
await rejects("report identity cannot silently switch industry/type",()=>savePublicResearchDraft(env,{...draft,type:"industry",scope:{...draft.scope,industryId:"synthetic-cloud"}}));
await rejects('unreviewed draft cannot publish',()=>publishPublicResearch(env,draft.reportId,saved.version,null,now));
await reviewPublicResearch(env,draft.reportId,saved.version,review(draft),now);
const published=await publishPublicResearch(env,draft.reportId,saved.version,null,now);
const first=await readPublicResearch(env,draft.reportId),second=await readPublicResearch(env,draft.reportId);
check('same immutable report reads identical',JSON.stringify(first)===JSON.stringify(second));
check('reader body uses structured claims',published.bodyMarkdown.includes(draft.claims[0].statement));
const bodyKey=`public-research/${draft.reportId}/${saved.version}.json`,savedBody=bodies.get(bodyKey)!;bodies.delete(bodyKey);
check('missing published body is explicit unavailable',(await readPublicResearch(env,draft.reportId)).status==='unavailable');bodies.set(bodyKey,savedBody);
const duplicates=await Promise.all(Array.from({length:100},()=>savePublicResearchDraft(env,draft)));
check('100 duplicate inputs produce one immutable version',new Set(duplicates.map(item=>item.version)).size===1);
const revised={...draft,title:'Revised synthetic funding baseline',generatedAt:now,inputFingerprint:hash('revised-input'),claims:draft.claims.map((claim,i)=>i?claim:{...claim,statement:'The revised synthetic source changes the financing conclusion.'})};
breakBatch=true;
await rejects('body write then index failure isolated',()=>savePublicResearchDraft(env,revised));
check('failed save preserves old publication',(await readPublicResearch(env,draft.reportId)).report?.version===saved.version);
const next=await savePublicResearchDraft(env,revised);await reviewPublicResearch(env,draft.reportId,next.version,review(revised),now);
await saveCompanyResearchExposure(env,{id:'synthetic-exposure',version:'v1',companyId:'SYNTHETIC-A',segmentId:null,industryId:'synthetic-cloud',relation:'industry',regions:['US'],validFrom:asOf,validUntil:null,source,weight:null,weightBasis:null,status:'verified'});
const frozen=await freezeCompanyResearch(env,'SYNTHETIC-A','2026-01-04T00:00:00.000Z');
check('missing industry explicit uncovered',frozen.gaps.some(gap=>gap.industryId==='synthetic-cloud'&&gap.reason==='uncovered'));
await recordCompanyResearchDependencies(env,{ticker:'SYNTHETIC-A',resultId:'company-synthetic-v1',dependencies:[{reportId:draft.reportId,version:saved.version,claimId:'claim-0'}],mappingVersions:frozen.mappingVersions});
const inFlightAdoption=await companyResearchDependencyStatements(env,{ticker:'SYNTHETIC-A',resultId:'racing-company-publication',dependencies:[{reportId:draft.reportId,version:saved.version,claimId:'claim-0'}],mappingVersions:[]});
await publishPublicResearch(env,draft.reportId,next.version,saved.version,now);
await rejects('adoption precheck race aborts publication transaction',()=>env.DB!.batch(inFlightAdoption));
await rejects('late adoption cannot reuse invalidated pinned claim',()=>recordCompanyResearchDependencies(env,{ticker:'SYNTHETIC-A',resultId:'late-company-publication',dependencies:[{reportId:draft.reportId,version:saved.version,claimId:'claim-0'}],mappingVersions:[]}));
check('frozen task retains v1 during v2 publication',frozen.reports[0].report.version===saved.version);
check('adopted changed claim invalidates company result',(await companyResearchDependencyStatus(env,'company-synthetic-v1')).status==='review_required');
check('source revision change invalidates dependent claims',changedPublicClaims(draft,{...draft,sources:[{...source,revision:'2'}]}).length===20);
check('presentation-only change does not invalidate claims',changedPublicClaims(draft,{...draft,title:'Formatting only',claims:draft.claims.map(claim=>({...claim,statement:claim.statement.replace('.','!')}))}).length===0);
const concurrent={...revised,title:'Competing synthetic publication',inputFingerprint:hash('competing')};const conflict=await savePublicResearchDraft(env,concurrent);await reviewPublicResearch(env,draft.reportId,conflict.version,review(concurrent),now);
await rejects('stale pointer cannot overwrite concurrent version',()=>publishPublicResearch(env,draft.reportId,conflict.version,saved.version,now));
check('old version remains readable',(await readPublicResearch(env,draft.reportId,{version:saved.version})).report?.version===saved.version);
check('offset timestamps cannot reveal future publication',(await readPublicResearch(env,draft.reportId,{asOf:'2026-01-03T01:00:00+02:00'})).status==='unavailable');
check('historical read cannot see future publication',(await readPublicResearch(env,draft.reportId,{asOf})).status==='unavailable');
check('duplicate impact channels flagged',distinctImpactChannels([published,published]).duplicates.length===20);
const industry:PublicResearchDraft={...draft,reportId:'synthetic-industry',validUntil:'2199-01-01T00:00:00.000Z',type:'industry',title:'Synthetic cloud industry',scope:{...draft.scope,industryId:'synthetic-cloud'},asOf:'2026-01-04T00:00:00.000Z',generatedAt:'2026-01-04T00:00:00.000Z',dependencies:[{reportId:draft.reportId,version:next.version,claimId:'claim-0',ownerClaimIds:['claim-0']}]};
const industryTime='2026-01-05T00:00:00.000Z';
const industryVersion=await savePublicResearchDraft(env,industry);await reviewPublicResearch(env,industry.reportId,industryVersion.version,{...review(industry),reviewedAt:industryTime},industryTime);await publishPublicResearch(env,industry.reportId,industryVersion.version,null,industryTime);
await saveCompanyResearchExposure(env,{id:'synthetic-exposure-b',version:'v1',companyId:'SYNTHETIC-B',segmentId:null,industryId:'synthetic-cloud',relation:'industry',regions:['US'],validFrom:asOf,validUntil:null,source,weight:null,weightBasis:null,status:'verified'});
const [contextA,contextB]=await Promise.all(['SYNTHETIC-A','SYNTHETIC-B'].map(ticker=>freezeCompanyResearch(env,ticker,'2026-01-06T00:00:00.000Z')));
check('two companies reuse identical industry version',contextA.reports.find(item=>item.report.type==='industry')?.report.version===industryVersion.version && contextB.reports.find(item=>item.report.type==='industry')?.report.version===industryVersion.version);
check('unknown exposure weights remain null',contextA.reports.filter(item=>item.report.type==='industry').every(item=>item.exposures.every(exposure=>exposure.weight===null)));
const secondIndustry={...industry,reportId:'synthetic-second-industry',scope:{...industry.scope,industryId:'synthetic-energy'}};
const secondVersion=await savePublicResearchDraft(env,secondIndustry);await reviewPublicResearch(env,secondIndustry.reportId,secondVersion.version,{...review(secondIndustry),reviewedAt:industryTime},industryTime);await publishPublicResearch(env,secondIndustry.reportId,secondVersion.version,null,industryTime);
await saveCompanyResearchExposure(env,{id:'synthetic-exposure-energy',version:'v1',companyId:'SYNTHETIC-A',segmentId:'power',industryId:'synthetic-energy',relation:'energy',regions:['US'],validFrom:asOf,validUntil:null,source,weight:null,weightBasis:null,status:'verified'});
const cross=await freezeCompanyResearch(env,'SYNTHETIC-A','2026-01-06T00:00:00.000Z');
check('cross-industry company keeps two distinct evidenced relationships',cross.reports.filter(item=>item.report.type==='industry').length===2);
await recordCompanyResearchDependencies(env,{ticker:'SYNTHETIC-B',resultId:'company-synthetic-v2',dependencies:[{reportId:industry.reportId,version:industryVersion.version,claimId:'claim-0'}],mappingVersions:contextB.mappingVersions});
await recordCompanyResearchDependencies(env,{ticker:'SYNTHETIC-C',resultId:'company-independent-industry-claim',dependencies:[{reportId:industry.reportId,version:industryVersion.version,claimId:'claim-1'}],mappingVersions:[]});
const afterMacroExpiry=await readPublicResearch(env,industry.reportId,{version:industryVersion.version,asOf:'2100-01-01T00:00:00.000Z'});
check('upstream expiry marks only affected industry claim',afterMacroExpiry.report?.claimStates['claim-0']==='review_required' && afterMacroExpiry.report.claimStates['claim-1']==='valid');
await withdrawPublicResearch(env,draft.reportId,next.version,'Synthetic rollback drill');
check('macro change does not invalidate independent industry claim/company',(await companyResearchDependencyStatus(env,'company-independent-industry-claim')).status==='valid');
await recordCompanyResearchDependencies(env,{ticker:'SYNTHETIC-C',resultId:'company-late-independent-claim',dependencies:[{reportId:industry.reportId,version:industryVersion.version,claimId:'claim-1'}],mappingVersions:[]});
check('unaffected claim remains adoptable in partially invalidated industry report',(await companyResearchDependencyStatus(env,'company-late-independent-claim')).status==='valid');
check('withdrawal propagates through industry to company', (await companyResearchDependencyStatus(env,'company-synthetic-v2')).status==='review_required');
check('withdrawn macro invalidates dependent industry', (await readPublicResearch(env,industry.reportId)).report?.freshnessStatus==='review_required');

check('withdrawn current is not valid',(await readPublicResearch(env,draft.reportId)).status==='withdrawn');
await restorePublicResearch(env,draft.reportId,saved.version);
check('restore reads complete previous publication',(await readPublicResearch(env,draft.reportId)).report?.version===saved.version);
const evidence={at:new Date().toISOString(),scope:'local SQLite and in-memory object-store publication journey; synthetic data only; no model/network/production writes',checks,limitations:['Does not constitute G1/G2 human review of real evidence','Does not validate Cloudflare distributed storage guarantees or provider budget enforcement']};
const output=resolve(process.argv[2]??'/tmp/spontra-public-research-acceptance.json');mkdirSync(resolve(output,'..'),{recursive:true});writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({passed:checks.length,evidence:output}));
