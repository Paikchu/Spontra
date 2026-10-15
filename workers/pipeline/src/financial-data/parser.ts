import {readStatementTableFacts} from './statement-table.ts';
import {parseSecBusinessFlow} from '../../../../shared/analysis-runtime/financial-data/business-flow-parser.ts';
import {parseSecEarningsRelease} from '../../../../shared/analysis-runtime/financial-data/business-flow-release.ts';
import {buildPublishedBusinessQuarter} from '../../../../shared/analysis-runtime/financial-data/disclosed-quarter.ts';
import type { BusinessFlowQuarter, FlowAmount, FlowMetric, BusinessSegment } from '../../../../shared/analysis-contract/business-flow.ts';
import { disclosedWholeCompany } from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import {extractFilingDisclosures} from '../../../../shared/analysis-runtime/financial-data/disclosure-extraction.ts';
import {extractFinancialStatements} from '../../../../shared/analysis-runtime/financial-data/financial-statements.ts';
import {memberName} from './member-labels.ts';
import {readIncomeStatementCells} from '../../../../shared/analysis-runtime/financial-data/income-statement.ts';
import type {IncomeCalculation,RevenueStructure} from './calculation.ts';
import {applyStructure,structureFromCalculation,structureFromStatement,structureKey,type BridgeAnchors,type BridgeStructure,type ResolvedBridge} from './bridge.ts';
export interface DocumentSource {url:string;accession:string;filedAt:string;cik:string;industry:'standard'|'financial'|'insurance'|'unknown';fiscalYear?:string;singleSegment?:boolean;
 /** The filing's labels for its dimension members (member-labels.ts); handed to each dimensional fact, not kept on its source. */
 memberLabels?:Record<string,string>;
 /** The filing's income statement calculation (calculation.ts); read by the parse, not kept on the facts' source. */
 calculation?:IncomeCalculation|null;
 /** How the filing reconciles segment revenue to consolidated revenue and which tables show which members (calculation.ts); read by the parse, not kept on the facts' source. */
 revenueStructure?:RevenueStructure|null;
 /** A structure from operating income to net income that balanced on an earlier filing of this issuer (presentation profile). */
 presentation?:{structure:BridgeStructure;version:string}|null;}
export const SEC_FLOW_PARSER_VERSION='deterministic-sec.v13';
/** Issuers read through a disclosure-specific profile; generic statement arithmetic would describe them in another scheme. */
export const hasDisclosureProfile=(cik:string)=>cik==='0001341439';
export interface Fact {source:DocumentSource;operands?:Fact[];formula?:string;precision:number;tag:string;value:number;currency:string;start:string;end:string;context:string;dimensions:Record<string,string>;
 /** The issuer's income statement row printing this fact; flip means the statement shows it with the opposite sign. */
 statementRow?:{order:number;label:string;flip:boolean};
 /** The filing's label for each member of this fact's dimensions. */
 memberLabels?:Record<string,string>;
 /** The filing's revenue tables that show this fact's member; the members one table shows are one split of revenue. */
 tables?:string[];}
const text=(s:string)=>s.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').trim();
const attrs=(s:string)=>Object.fromEntries([...s.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1].toLowerCase(),m[2]]));
const local=(tag:string)=>tag.split(':').at(-1)!;
const tags:Partial<Record<FlowMetric,string[]>>={revenue:['RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet'],cost:['CostOfRevenue','CostOfGoodsAndServicesSold'],gross:['GrossProfit'],operatingExpenses:['OperatingExpenses'],operating:['OperatingIncomeLoss'],other:['NonoperatingIncomeExpense','OtherNonoperatingIncomeExpense'],pretax:['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest','IncomeLossFromContinuingOperationsIncludingNoncontrollingInterestBeforeIncomeTaxesExtraordinaryItems'],tax:['IncomeTaxExpenseBenefit'],net:['IncomeLossFromContinuingOperations','NetIncomeLoss','ProfitLoss'],research:['ResearchAndDevelopmentExpense'],sales:['SellingAndMarketingExpense','SellingExpense'],administration:['GeneralAndAdministrativeExpense']};
const flowConcepts=new Set([...Object.values(tags).flat(), 'RevenuesNetOfInterestExpense','NoninterestExpense','CostsAndExpenses','ProvisionForLoanLeaseAndOtherLosses','SellingGeneralAndAdministrativeExpense','GainLossOnInvestments','IncomeLossFromEquityMethodInvestments']);
const needsRestatementReview=(html:string)=>text(html).replace(/\s+/g,' ').split(/\.(?: |$)/).some(p=>/\bas\s+restated\b|\b(?:prior[- ](?:period|year)|previously reported|comparative|historical)[^.]{0,180}\b(?:recast|restated|reclassified)\b|\b(?:recast|restated)[^.]{0,180}\b(?:income|segment|financial statement)/i.test(p)&&!/no impact on[^.]*consolidated (?:income|statements of income)/i.test(p));
/** The consolidation-items member that only says "these are the operating segments": not a dimension of the split itself. */
const operatingSegments=([axis,member]:[string,string])=>local(axis)==='ConsolidationItemsAxis'&&local(member)==='OperatingSegmentsMember';
const near=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1,Math.max(Math.abs(a),Math.abs(b))*1e-9);
export function readReportedFacts(html:string,source:DocumentSource):{facts:Fact[];issues:string[]}{
 if(!/<ix:nonFraction/i.test(html))return {facts:readStatementTableFacts(html,source),issues:[]};
 source={...source,singleSegment:/the company operates (?:its business )?in (?:one|a single) operating segment/i.test(text(html).replace(/\s+/g,' ')),fiscalYear:text(html.match(/<ix:nonNumeric[^>]*name=["\']dei:DocumentFiscalYearFocus["\'][^>]*>([\s\S]*?)<\/ix:nonNumeric>/i)?.[1]??'')};
 const {memberLabels,revenueStructure,calculation:_calculation,presentation:_presentation,...factSource}=source;source=factSource;
 // Lines the filing's revenue calculation adds to a revenue total (hedging gains beside contract revenue) are read as consolidated facts.
 const revenueLines=new Set(revenueStructure?.arcs.flatMap(a=>[local(a.parent),local(a.child)])??[]);
 const issues:string[]=[];
 const contexts=new Map<string,{start:string;end:string;dimensions:Record<string,string>}>();
 for(const m of html.matchAll(/<(?:[\w-]+:)?context\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?context\s*>/gi)){
  const a=attrs(m[1]),start=m[2].match(/<(?:[\w-]+:)?startDate[^>]*>([^<]+)/i)?.[1],end=m[2].match(/<(?:[\w-]+:)?endDate[^>]*>([^<]+)/i)?.[1],issuer=m[2].match(/<(?:[\w-]+:)?identifier[^>]*>([^<]+)/i)?.[1];if(!a.id||!start||!end||!issuer||issuer.replace(/^0+/,'')!==source.cik.replace(/^0+/,''))continue;
  const days=(Date.parse(end)-Date.parse(start))/86400000;if(days<70||days>380||!Number.isFinite(days))continue;const dimensions:Record<string,string>={};for(const d of m[2].matchAll(/<(?:[\w-]+:)?explicitMember\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?explicitMember\s*>/gi)){dimensions[attrs(d[1]).dimension]=text(d[2]);}if(/typedMember/i.test(m[2]))continue;contexts.set(a.id,{start,end,dimensions});
 }
 const units=new Map<string,string>();for(const m of html.matchAll(/<(?:[\w-]+:)?unit\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?unit\s*>/gi)){const measure=m[2].match(/<[^>]*measure[^>]*>\s*iso4217:([A-Z]{3})\s*</i)?.[1];if(measure&&!/divide/i.test(m[2]))units.set(attrs(m[1]).id,measure);}
 const buckets=new Map<string,Fact[]>();for(const m of html.matchAll(/<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction\s*>/gi)){
  const a=attrs(m[1]);const context=contexts.get(a.contextref),currency=units.get(a.unitref);if(!flowConcepts.has(local(a.name??''))&&!(revenueLines.has(local(a.name??''))&&context&&!Object.keys(context.dimensions).length))continue;if(!context||!currency||a['xsi:nil']==='true')continue;let raw=text(m[2]).replace(/[,\s]/g,'');if(local(a.format??'')==='fixed-zero')raw='0';if(/^[–—-]$/.test(raw)&&/(?:zero-?dash|num-?dash)$/i.test(local(a.format??'')))raw='0';if(a.format&&!/^(?:num-?dot-?decimal|zero-?dash|num-?dash|fixed-zero)$/i.test(local(a.format))){issues.push('UNSUPPORTED_NUMBER_FORMAT');continue;}if(!/^\(?[+-]?\d+(\.\d+)?\)?$/.test(raw))continue;const scale=Number(a.scale??0);if(!Number.isInteger(scale)||Math.abs(scale)>18)continue;const value=Math.abs(Number(raw.replace(/[()]/g,'')))*10**scale*(a.sign==='-'||raw.startsWith('(')||raw.startsWith('-')?-1:1);if(!Number.isFinite(value))continue;const precision=a.decimals==='INF'?Number.MAX_SAFE_INTEGER:/^-?\d+$/.test(a.decimals??'')?Number(a.decimals):Number.MIN_SAFE_INTEGER;const fact={precision,tag:a.name,value,currency,...context,context:a.contextref,source};const key=[context.start,context.end,currency].join('|');buckets.set(key,[...(buckets.get(key)??[]),fact]);
 }
 const facts=[...buckets.values()].flat();
 // Income statement rows keep the issuer's own lines, including custom concepts the flow tags do not name.
 const inventory=extractFilingDisclosures(html,{ticker:'',accessionNumber:source.accession,documentUrl:source.url,form:'',reportDate:'',filedAt:source.filedAt}),byId=new Map(inventory.facts.map(f=>[f.id,f]));
 for(const cell of readIncomeStatementCells(extractFinancialStatements(html,inventory))){
  const fact=byId.get(cell.factId),contextRef=fact?.contextRef;if(!fact||!contextRef)continue;
  const statementRow={order:cell.order,label:cell.label,flip:cell.flip},same=facts.filter(f=>f.tag===cell.concept&&f.context===contextRef);
  if(same.length){for(const f of same)f.statementRow=statementRow;continue;}
  const context=contexts.get(contextRef),currency=units.get(fact.unitRef??''),value=Number(fact.numericValue);
  if(!context||!currency||fact.numericValue===null||!Number.isFinite(value))continue;
  facts.push({precision:fact.decimals==='INF'?Number.MAX_SAFE_INTEGER:/^-?\d+$/.test(fact.decimals??'')?Number(fact.decimals):Number.MIN_SAFE_INTEGER,tag:cell.concept,value,currency,...context,context:contextRef,source,statementRow});
 }
 if(memberLabels)for(const f of facts){const own=Object.fromEntries(Object.values(f.dimensions).flatMap(m=>memberLabels[m]?[[m,memberLabels[m]]]:[]));if(Object.keys(own).length)f.memberLabels=own;}
 if(revenueStructure)for(const f of facts){const members=Object.entries(f.dimensions).filter(entry=>!operatingSegments(entry)).map(([,m])=>m);if(members.length===1&&revenueStructure.members[members[0]])f.tables=revenueStructure.members[members[0]];}
 return {facts,issues};
}
/** A row equal to the sum of the rows directly above it is an unlabelled subtotal; it is dropped only when that makes the lines reconcile. */
function reconcile<T extends {value:number}>(items:T[],total:number):T[]|null{
 const sum=(rows:T[])=>rows.reduce((n,r)=>n+r.value,0);if(near(sum(items),total))return items;
 const kept:T[]=[];let runStart=0;
 for(const item of items){let subtotal=false;for(let j=runStart;j<=kept.length-2&&!subtotal;j++)subtotal=near(sum(kept.slice(j)),item.value);if(subtotal)runStart=kept.length;else kept.push(item);}
 return near(sum(kept),total)?kept:null;
}
const expenseGroup=(f:Fact):'research'|'sales'|'administration'|'other'=>{const name=local(f.tag),label=f.statementRow?.label??'';
 return /^ResearchAndDevelopmentExpense/.test(name)||/^research and development$/i.test(label)?'research'
  :/^(?:SellingAndMarketingExpense|SellingExpense|MarketingExpense)$/.test(name)||/^(?:(?:sales|selling) and marketing|selling|marketing)$/i.test(label)?'sales'
  :name==='GeneralAndAdministrativeExpense'||/^general and administrative$/i.test(label)?'administration':'other';};
/** One period's consolidated fact for a concept: the most precise, and only when the most precise facts agree. */
const picker=(facts:Fact[])=>(concept:string)=>{const matches=facts.filter(f=>!Object.keys(f.dimensions).length&&local(f.tag)===local(concept));if(!matches.length)return undefined;const best=Math.max(...matches.map(f=>f.precision)),top=matches.filter(f=>f.precision===best);return new Set(top.map(f=>f.value)).size===1?top[0]:undefined;};
/** The four anchors of the bridge from operating income to net income (bridge.ts) in one period, when taxes and net income are reported. */
const anchorsOf=(facts:Fact[]):BridgePeriod|null=>{const pick=picker(facts),first=(names:string[])=>names.map(pick).find(Boolean)??null,tax=first(tags.tax!),net=first(tags.net!);return tax&&net?{start:facts[0].start,end:facts[0].end,facts,pick,anchors:{revenue:first(tags.revenue!),operating:first(tags.operating!),tax,net}}:null;};
export type BridgePeriod={start:string;end:string;facts:Fact[];anchors:BridgeAnchors;pick:(concept:string)=>Fact|undefined};
/** Every quarter a document reports with taxes and net income, anchored for the bridge; the same periods the parse checks a structure against. */
export function bridgePeriods(facts:Fact[]):BridgePeriod[]{
 const buckets=new Map<string,Fact[]>();for(const f of facts){const days=(Date.parse(f.end)-Date.parse(f.start))/86400000;if(days<70||days>110)continue;const key=[f.start,f.end,f.currency].join('|');buckets.set(key,[...(buckets.get(key)??[]),f]);}
 return [...buckets.values()].map(anchorsOf).filter((p):p is BridgePeriod=>!!p);
}
type RevenueAdjustment={id:string;name:string;definition:string;fact:Fact;weight:1|-1};
/**
 * Consolidated revenue split into the members of one segment or product axis, when the filing's facts balance it
 * exactly: Σ members + reconciling items = consolidated revenue. Reconciling items are what the filing itself declares:
 * intersegment eliminations and other consolidation items reported against the axis, and the lines the filing's revenue
 * calculation adds beside the segments' concept on the way to the consolidated total (Alphabet's hedging gains:
 * Revenues = RevenueFromContractWithCustomer + RevenueNotFromContractWithCustomer, the segments reporting the first).
 * The members of one table are one split; one axis shown in two tables (Autodesk's subscription split on the statement,
 * product families in its revenue note) is two candidates, and of several balanced splits the most detailed is taken.
 */
function splitRevenue(facts:Fact[],revenueNames:string[],consolidated:Fact|undefined,structure:RevenueStructure|null|undefined,issues:string[]):{members:Map<string,Fact>;adjustments:RevenueAdjustment[]}|null{
 if(!consolidated)return null;
 const isRevenue=(f:Fact)=>revenueNames.includes(local(f.tag)),sole=(f:Fact)=>Object.entries(f.dimensions).length===1?Object.entries(f.dimensions)[0]:null;
 const eliminationFacts=facts.filter(f=>{const d=sole(f);return isRevenue(f)&&!!d&&['ConsolidationItemsAxis','StatementBusinessSegmentsAxis','ProductOrServiceAxis'].includes(local(d[0]))&&/eliminat/i.test(d[1]);});
 if(new Set(eliminationFacts.map(f=>f.value)).size>1)issues.push('CONFLICTING_REVENUE_ELIMINATIONS');
 const elimination=eliminationFacts.sort((a,b)=>b.precision-a.precision)[0];
 // Other consolidation items (corporate, reconciling items) reported against revenue, one fact per member.
 const consolidationItems=new Map<string,Fact>();for(const f of facts){const d=sole(f);if(!isRevenue(f)||!d||local(d[0])!=='ConsolidationItemsAxis'||operatingSegments(d)||eliminationFacts.includes(f))continue;const old=consolidationItems.get(d[1]);if(!old||f.precision>old.precision)consolidationItems.set(d[1],f);}
 const groups=new Map<string,{axis:string;members:Map<string,Fact>}>();
 for(const f of facts){if(eliminationFacts.includes(f))continue;const entries=Object.entries(f.dimensions).filter(entry=>!operatingSegments(entry));if(!isRevenue(f)||entries.length!==1||!['StatementBusinessSegmentsAxis','ProductOrServiceAxis'].includes(local(entries[0][0])))continue;const [axis,member]=entries[0];
  const axisKey=axis+'|'+Object.entries(f.dimensions).filter(([a])=>local(a)==='ConsolidationItemsAxis').map(([a,m])=>a+':'+m).join(',');
  // Every member of the axis together, as before tables were known, and the members of each table that shows the member.
  for(const table of ['*',...(f.tables??[])]){const key=axisKey+'|'+table,group=groups.get(key)??{axis,members:new Map<string,Fact>()};const old=group.members.get(member);if(old&&old.precision>f.precision)continue;if(old&&old.precision===f.precision&&old.value!==f.value){issues.push('CONFLICTING_SEGMENT');continue;}group.members.set(member,f);groups.set(key,group);}
 }
 const pick=(concept:string)=>{const matches=facts.filter(f=>!Object.keys(f.dimensions).length&&f.tag===concept);if(!matches.length)return undefined;const best=Math.max(...matches.map(f=>f.precision)),top=matches.filter(f=>f.precision===best);return new Set(top.map(f=>f.value)).size===1?top[0]:undefined;};
 // The lines the revenue calculation sums beside `concept` on its way up to the consolidated concept, each signed toward it.
 const calculated=(concept:string):RevenueAdjustment[][]=>{if(local(concept)===local(consolidated.tag)||!structure)return [[]];const found:RevenueAdjustment[][]=[];
  for(const role of new Set(structure.arcs.filter(a=>a.child===concept).map(a=>a.role))){const arcs=structure.arcs.filter(a=>a.role===role),items:RevenueAdjustment[]=[];let node=concept,sign:1|-1=1,reached=false;
   // With the segments' concept entering the total positively, each parent's sign toward the total is the product of the weights below it.
   for(let guard=0;guard<10&&!reached;guard++){const up=arcs.find(a=>a.child===node);if(!up)break;sign=(sign*up.weight) as 1|-1;
    for(const sibling of arcs.filter(a=>a.parent===up.parent&&a.child!==node)){const fact=pick(sibling.child);if(fact)items.push({id:local(sibling.child),name:structure.labels[sibling.child]||local(sibling.child).replace(/([a-z0-9])([A-Z])/g,'$1 $2'),definition:'revenue-reconciling:'+local(sibling.child),fact,weight:(sign*sibling.weight) as 1|-1});}
    node=up.parent;reached=local(node)===local(consolidated.tag);}
   if(reached&&sign===1)found.push(items);}
  return found.length?found:[[]];};
 const sum=(members:Map<string,Fact>)=>[...members.values()].reduce((n,f)=>n+f.value,0);
 const eliminationMember=elimination&&Object.values(elimination.dimensions)[0];
 const eliminations:RevenueAdjustment[]=elimination?[{id:'intersegment-eliminations',name:elimination.memberLabels?.[eliminationMember!]?memberName(eliminationMember!,elimination.memberLabels):'Intersegment eliminations',definition:'revenue-eliminations',fact:elimination,weight:1}]:[];
 const others:RevenueAdjustment[]=[...consolidationItems].map(([member,f])=>({id:local(member),name:memberName(member,f.memberLabels),definition:'revenue-consolidation-item:'+local(member),fact:f,weight:1}));
 const balanced:Array<{axis:string;members:Map<string,Fact>;adjustments:RevenueAdjustment[]}>=[];
 for(const {axis,members} of groups.values()){const concepts=new Set([...members.values()].map(f=>f.tag));
  const candidates=concepts.size===1?calculated([...concepts][0]):[[]];
  const adjustments=candidates.flatMap(items=>[[...eliminations,...items],[...eliminations,...others,...items]]).find(items=>near(sum(members)+items.reduce((n,a)=>n+a.weight*a.fact.value,0),consolidated.value));
  if(!adjustments)continue;
  const same=balanced.find(b=>local(b.axis)===local(axis)&&b.members.size===members.size&&[...members].every(([m,f])=>b.members.get(m)?.value===f.value));
  if(!same)balanced.push({axis,members,adjustments:adjustments.filter((a,i,all)=>all.findIndex(b=>b.id===a.id)===i)});}
 let matching=balanced;const detailed=matching.filter(m=>m.members.size>1);if(detailed.length)matching=detailed;const business=matching.filter(m=>local(m.axis)==='StatementBusinessSegmentsAxis');if(business.length)matching=business;
 if(matching.length>1&&new Set(matching.map(m=>local(m.axis))).size===1){const most=Math.max(...matching.map(m=>m.members.size));matching=matching.filter(m=>m.members.size===most);}
 if(matching.length>1){issues.push('AMBIGUOUS_REVENUE_AXIS');return null;}
 return matching[0]??null;
}
function extractGenericQuarters(html:string,source:DocumentSource,supplemental:Fact[]=[],reviewVerified=false):{quarters:BusinessFlowQuarter[];issues:string[]}{
 const issues:string[]=[];if(html.length>12000000)return {quarters:[],issues:['DOCUMENT_TOO_LARGE']};
 // A restatement is found by comparing what filings report for the same period (restatement.ts), not by wording.
 const reported=readReportedFacts(html,source);issues.push(...reported.issues);const buckets=new Map<string,Fact[]>();for(const fact of [...reported.facts,...supplemental]){const days=(Date.parse(fact.end)-Date.parse(fact.start))/86400000;if(days<70||days>110)continue;const key=[fact.start,fact.end,fact.currency].join('|');buckets.set(key,[...(buckets.get(key)??[]),fact]);}
 const fiscalFocus=source.fiscalYear??text(html.match(/<ix:nonNumeric[^>]*name=["']dei:DocumentFiscalYearFocus["'][^>]*>([\s\S]*?)<\/ix:nonNumeric>/i)?.[1]??'');
 const quarters:BusinessFlowQuarter[]=[];
 // Operating income to net income (bridge.ts). A structure read from the statement rows or kept from an earlier filing
 // must balance in every period of the document; the calculation is the issuer's own declaration and balances per period.
 const periods=[...buckets.values()].map(anchorsOf).filter((p):p is NonNullable<typeof p>=>!!p);
 const everywhere=(structure:BridgeStructure,kind:'statement'|'profile')=>periods.every(p=>applyStructure(structure,kind,p.anchors,p.pick,source.calculation));
 const statementStructure=periods.map(p=>structureFromStatement([...buckets.values()].flat(),p.anchors)).find(s=>s&&everywhere(s,'statement'))??null;
 const profileStructure=source.presentation&&everywhere(source.presentation.structure,'profile')?source.presentation.structure:null;
 const bridge=(facts:Fact[]):ResolvedBridge|null=>{const p=anchorsOf(facts);if(!p)return null;
  const calculated=structureFromCalculation(source.calculation,p.anchors);
  return (calculated&&applyStructure(calculated,'calculation',p.anchors,p.pick,source.calculation))
   ||(statementStructure&&applyStructure(statementStructure,'statement',p.anchors,p.pick,source.calculation))
   ||(profileStructure&&applyStructure(profileStructure,'profile',p.anchors,p.pick,source.calculation))||null;};
 for(const [key,facts]of buckets){const[start,end,currency]=key.split('|');const consolidated=facts.filter(f=>Object.keys(f.dimensions).length===0);
  const select=(names:string[])=>{for(const name of names){const matches=consolidated.filter(f=>local(f.tag)===name);if(matches.length){const bestPrecision=Math.max(...matches.map(f=>f.precision));const precise=matches.filter(f=>f.precision===bestPrecision);if(new Set(precise.map(f=>f.value)).size!==1){issues.push('CONFLICTING_FACT:'+name);return undefined;}return precise[0];}}return undefined;};
  const factLineage=(f:Fact):NonNullable<FlowAmount['lineage']>=>[{accession:f.source.accession,url:f.source.url,concept:f.tag,contextId:f.context,periodStart:f.start,periodEnd:f.end,dimensions:f.dimensions,parserVersion:SEC_FLOW_PARSER_VERSION}];
  const amount=(f:Fact,definition:string):FlowAmount=>({value:String(f.value),basis:f.operands?'derived':'reported',definition,comparabilityKey:'deterministic-sec-v1:'+definition+':'+f.tag,sourceIds:[...new Set((f.operands??[f]).map(v=>v.source.accession))],...(f.formula?{formula:f.formula}:{}),lineage:(f.operands??[f]).flatMap(factLineage)});
  const figures:BusinessFlowQuarter['figures']={};for(const[key,names]of Object.entries(tags)){const f=select(names!);if(f)figures[key as FlowMetric]=amount(f,key);}
  const derive=(definition:string,value:number,terms:FlowAmount[],formula:string):FlowAmount=>({value:String(value),basis:'derived',definition,comparabilityKey:'deterministic-sec-v1:'+definition+':'+terms.map(t=>t.comparabilityKey).join('|'),sourceIds:[...new Set(terms.flatMap(t=>t.sourceIds))],formula,lineage:terms.flatMap(t=>t.lineage??[])});
  const value=(k:FlowMetric)=>figures[k]?.value==null?null:Number(figures[k]!.value);
  let model:BusinessFlowQuarter['incomeModel']='standard';
  const financialExpenses:NonNullable<BusinessFlowQuarter['expenseComponents']>=[];
  if(source.industry==='financial'||source.industry==='insurance'){model=source.industry;const revenue=select(['RevenuesNetOfInterestExpense','Revenues']);const expense=select(['NoninterestExpense','CostsAndExpenses']);if(source.industry==='insurance'){const profit=select(['ProfitLoss']);if(profit)figures.net=amount(profit,'consolidated-net-including-noncontrolling-interest');const gain=select(['GainLossOnInvestments']),equity=select(['IncomeLossFromEquityMethodInvestments']);if(gain&&equity)figures.other=derive('insurance-investment-and-equity-income',gain.value+equity.value,[amount(gain,'investment-gains'),amount(equity,'equity-method-income')],'Reported investment gains (losses) + reported equity-method income');}if(revenue)figures.revenue=amount(revenue,'net-financial-revenue');if(expense){figures.operatingExpenses=amount(expense,'reported-financial-expenses');financialExpenses.push({id:source.industry==='insurance'?'reported-costs-and-expenses':'noninterest-expense',name:source.industry==='insurance'?'Reported costs and expenses':'Noninterest expense',group:'other',amount:figures.operatingExpenses});const provision=select(['ProvisionForLoanLeaseAndOtherLosses']);if(source.industry==='financial'&&provision&&local(expense.tag)==='NoninterestExpense'){const loss=amount(provision,'credit-loss-provision');financialExpenses.push({id:'credit-loss-provision',name:'Provision for credit losses',group:'other',amount:loss});figures.operatingExpenses=derive('financial-expenses',expense.value+provision.value,[figures.operatingExpenses,loss],'Reported noninterest expense + reported provision for credit losses (net revenue is already net of interest expense)');}}}
  else if(value('cost')!=null&&value('revenue')!=null){if(!figures.gross)figures.gross=derive('gross',value('revenue')!-value('cost')!,[figures.revenue!,figures.cost!],'Reported revenue − reported total cost of revenue');if(!figures.operatingExpenses&&figures.operating)figures.operatingExpenses=derive('operatingExpenses',value('gross')!-value('operating')!,[figures.gross!,figures.operating!],'Reported gross profit − reported operating income (total operating expenses)');}
  else {model='direct_operating';const expense=select(['CostsAndExpenses']);if(expense)figures.operatingExpenses=amount(expense,'reported-costs-and-expenses');}
  let afterTaxComponents:NonNullable<BusinessFlowQuarter['afterTaxComponents']>=[],presentation:BusinessFlowQuarter['presentation'];
  if(model!=='financial'&&model!=='insurance'&&figures.tax&&figures.net){
   const resolved=bridge(facts);
   if(resolved&&(!figures.pretax||Number(figures.pretax.value)===resolved.pretax.value)){
    if(!figures.pretax)figures.pretax=resolved.pretax.fact?amount(resolved.pretax.fact,'pretax'):derive('pretax',resolved.pretax.value,resolved.pretax.operands.map(o=>({...amount(o.fact,'pretax-line'),value:String(o.weight*o.fact.value)})),'Sum of the lines the filing\'s calculation places under income before income taxes');
    const seen=new Map<string,number>();
    afterTaxComponents=resolved.afterTax.filter(a=>a.value!==0).map(a=>{const base=local(a.fact.tag),count=(seen.get(base)??0)+1;seen.set(base,count);const id=count>1?`${base}~${count}`:base;
     const name=a.fact.statementRow?.label||source.calculation?.labels[a.fact.tag]||Object.entries(source.calculation?.labels??{}).find(([c])=>local(c)===base)?.[1]||base.replace(/([a-z0-9])([A-Z])/g,'$1 $2');
     const reported=amount(a.fact,'after-tax:'+id);return {id,name,amount:a.weight===1?reported:{...reported,basis:'derived' as const,value:String(a.value),formula:'− reported '+name}};});
    presentation={source:resolved.source,structure:structureKey(resolved.structure)};
   }else if(figures.pretax){
    // No structure balances: what lies between pretax income and net income is shown as one derived total.
    const residual=value('net')!-(value('pretax')!-value('tax')!);
    if(Math.abs(residual)>Math.max(1,Math.abs(value('net')!)*1e-9))afterTaxComponents=[{id:'after-tax-items',name:'Items after income taxes, net',amount:derive('after-tax-items',residual,[figures.net,figures.pretax,figures.tax],'Reported net income − (reported income before income taxes − reported income taxes)')}];
    presentation={source:afterTaxComponents.length?'degraded':'statement'};
   }else{
    figures.pretax=derive('pretax-with-after-tax-items',value('net')!+value('tax')!,[figures.net,figures.tax],'Reported net income + reported income taxes (lines after income taxes not separated)');
    presentation={source:'degraded'};
   }
  }
  if(figures.operating&&figures.pretax)figures.other=derive('other',value('pretax')!-value('operating')!,[figures.pretax!,figures.operating!],'Reported income before income taxes − reported operating income (signed other income, net)');
  const revenueNames=source.industry==='financial'?['RevenuesNetOfInterestExpense','Revenues']:source.industry==='insurance'?['Revenues']:tags.revenue!;
  const revenueSplit=splitRevenue(facts,revenueNames,figures.revenue?select([local(figures.revenue.lineage![0].concept)]):undefined,source.revenueStructure,issues);
  const revenueAdjustments:NonNullable<BusinessFlowQuarter['revenueAdjustments']>=(revenueSplit?.adjustments??[]).map(a=>{const reported=amount(a.fact,a.definition);return {id:a.id,name:a.name,amount:a.weight===1?reported:{...reported,basis:'derived' as const,value:String(-a.fact.value),formula:'− reported '+a.name}};});
  const eliminated=revenueAdjustments.some(a=>a.id==='intersegment-eliminations');
  const segments:BusinessSegment[]=[...(revenueSplit?.members??[])].map(([member,f])=>({id:member,name:memberName(member,f.memberLabels),revenue:{...amount(f,'segment:'+member),comparabilityKey:f.tag.startsWith('table:')?'table-segment:'+source.accession+':'+member+':'+f.tag:/^\d{4}$/.test(fiscalFocus)?'deterministic-sec-segment:'+fiscalFocus+':'+member+':'+f.tag:null},description:'A segment or product and service category as the filing discloses it, named by the filing; products and customers are not inferred.',products:[],customers:null,monetization:null,disclosure:eliminated?'Segment revenue includes intersegment sales; eliminations are shown separately, and neither they nor consolidated expenses are allocated to segments.':revenueAdjustments.length?'Revenue the filing reports outside its segments is shown separately as reconciling items; consolidated expenses are not allocated to segments.':'Revenue from the filing\'s segment disclosure; consolidated expenses are not allocated to segments.',sourceIds:[source.accession]}));// Non-reconciling department/management revenue is not substituted for GAAP consolidated revenue.

  const expenses=financialExpenses;
  // Operating expense lines printed between cost of revenue (or gross profit) and operating income, used only when they add up to the operating expense total.
  const statementExpenses=():typeof expenses=>{
   if(model!=='standard'||!figures.operatingExpenses)return [];
   const operatingRow=facts.find(f=>f.statementRow&&local(f.tag)==='OperatingIncomeLoss'&&!Object.keys(f.dimensions).length);if(!operatingRow)return [];
   const byOrder=new Map<number,Fact>();
   // Rows below operating income (the bridge to net income) play no part in the expense lines.
   for(const f of facts){if(!f.statementRow||f.source.url!==operatingRow.source.url||f.statementRow.order>operatingRow.statementRow!.order)continue;const old=byOrder.get(f.statementRow.order);if(old&&(old.tag!==f.tag||old.value!==f.value))return [];if(!old||f.precision>old.precision)byOrder.set(f.statementRow.order,f);}
   const rows=[...byOrder].sort((a,b)=>a[0]-b[0]).map(([,f])=>f),end=rows.findIndex(f=>local(f.tag)==='OperatingIncomeLoss');
   const start=rows.slice(0,end).findLastIndex(f=>[...tags.cost!,...tags.gross!].includes(local(f.tag))&&!Object.keys(f.dimensions).length);if(start<0)return [];
   const lines=rows.slice(start+1,end).filter(f=>!['OperatingExpenses','CostsAndExpenses'].includes(local(f.tag))&&!/^total\b/i.test(f.statementRow!.label)).map(fact=>({fact,value:fact.statementRow!.flip?-fact.value:fact.value}));
   // Statements that print expenses as deductions reconcile with the opposite orientation.
   const kept=[1,-1].map(sign=>reconcile(lines.map(l=>({...l,value:l.value*sign})),Number(figures.operatingExpenses!.value))).find(k=>k?.length);if(!kept)return [];
   const seen=new Map<string,number>();
   return kept.filter(l=>l.value!==0).map(({fact,value})=>{const base=local(fact.tag),count=(seen.get(base)??0)+1;seen.set(base,count);const id=count>1?`${base}~${count}`:base;return {id,name:fact.statementRow!.label||base,group:expenseGroup(fact),amount:{...amount(fact,'expense:'+id),value:String(value)}};});
  };
  if(!expenses.length){const lines=statementExpenses();if(lines.length){expenses.push(...lines);for(const key of ['research','sales','administration'] as const){const matches=lines.filter(c=>c.group===key);if(matches.length===1)figures[key]=matches[0].amount;else delete figures[key];}}}
  const combinedSalesAdministration=select(['SellingGeneralAndAdministrativeExpense','GainLossOnInvestments','IncomeLossFromEquityMethodInvestments']);const disclosedOperating=['research','sales','administration'].map(k=>({id:k,name:k==='research'?'Research and development':k==='sales'?'Sales and marketing':'General and administrative',group:k as 'research'|'sales'|'administration',amount:figures[k as FlowMetric]})).filter((c):c is typeof c & {amount:FlowAmount}=>!!c.amount);if(!expenses.length&&figures.research&&combinedSalesAdministration&&figures.operatingExpenses&&near(Number(figures.research.value)+combinedSalesAdministration.value,Number(figures.operatingExpenses.value))){expenses.push({id:'research',name:'Research and development',group:'research',amount:figures.research},{id:'sales-general-administration',name:'Selling, general and administrative',group:'other',amount:amount(combinedSalesAdministration,'sales-general-administration')});}if(!expenses.length&&disclosedOperating.length===3&&figures.operatingExpenses&&near(disclosedOperating.reduce((sum,c)=>sum+Number(c.amount.value),0),Number(figures.operatingExpenses.value)))expenses.push(...disclosedOperating);if(!expenses.length&&figures.operatingExpenses)expenses.push({id:'reported-expense-total',name:'Total costs and expenses',group:'other' as const,amount:figures.operatingExpenses});
  let q:BusinessFlowQuarter={id:end,label:`Three months ended ${end}`,periodStart:start,periodEnd:end,periodType:'3M',currency,scale:1,basisLabel:source.industry==='insurance'?'As reported to the SEC · investment and equity-method income shown separately · net income includes noncontrolling interests':'As reported in each SEC filing · deterministic extraction · segment comparisons across fiscal years not verified',reportedAt:source.filedAt,figures,segments,segmentsComplete:segments.length>0,...(facts.some(f=>f.source.singleSegment)?{segmentDisclosure:'single_reportable_segment' as const}:{}),...(segments.length&&revenueAdjustments.length?{revenueAdjustments}:{}),expenseComponents:expenses,otherComponents:figures.other?[{id:'reported-net-other',name:'Other income (expense), net',amount:figures.other}]:[],...(afterTaxComponents.length?{afterTaxComponents}:{}),...(presentation?{presentation}:{}),incomeModel:model,sources:[...new Map(facts.flatMap(f=>f.operands??[f]).map(f=>[f.source.accession,{id:f.source.accession,title:'SEC filing '+f.source.accession,url:f.source.url,publishedAt:f.source.filedAt}])).values()]};
  if(figures.net?.lineage?.every(l=>local(l.concept)==='IncomeLossFromContinuingOperations'))q.basisLabel+=' · income from continuing operations (excludes discontinued operations)';
  if(!figures.revenue)continue;
  if(!segments.length)q=disclosedWholeCompany(q);quarters.push(q);
 }
 return {quarters:issues.length?[]:quarters,issues:!quarters.length&&!issues.length?['NO_DIRECT_COMPARABLE_QUARTER']:issues};
}

/**
 * Known disclosure-profile mappings read actual cells/tags; no ticker or amounts are substituted.
 * `presentationReviewed`: the caller established that the filing only reclassified prior periods to its current presentation.
 */
export function extractDisclosedQuarters(html:string,source:DocumentSource,supplemental:Fact[]=[],presentationReviewed=false):{quarters:BusinessFlowQuarter[];issues:string[]}{
 if(hasDisclosureProfile(source.cik) && (presentationReviewed || !needsRestatementReview(html))){
  const inputs={sourceUrl:source.url,accession:source.accession};
  const parsed=/<ix:nonFraction/i.test(html)?parseSecBusinessFlow(html,inputs):parseSecEarningsRelease(html,inputs);
  const quarters=parsed.map(q=>buildPublishedBusinessQuarter(q,source.filedAt)).filter((q):q is BusinessFlowQuarter=>q!==null);
  if(quarters.length)return {quarters,issues:[]};
 }
 if(!/<ix:nonFraction/i.test(html)){const facts=readStatementTableFacts(html,source);if(facts.length)return extractGenericQuarters('',source,facts,true);}
 return extractGenericQuarters(html,source,supplemental,presentationReviewed);
}

/** Internal entry for facts reviewed by the cumulative-period verifier. */
export function extractVerifiedCurrentQuarters(source:DocumentSource,facts:Fact[]){return extractGenericQuarters('',source,facts,true);}
