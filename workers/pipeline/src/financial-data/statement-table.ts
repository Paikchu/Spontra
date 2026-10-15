import type { DocumentSource, Fact } from './parser.ts';

const clean = (value:string) => value.replace(/<[^>]*>/g,' ').replace(/&#(?:x([\da-f]+)|(\d+));/gi,(_,hex,dec)=>String.fromCodePoint(parseInt(hex??dec,hex?16:10))).replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/[\u200b-\u200d\ufeff]/g,'').replace(/\s+/g,' ').trim();
const months:Record<string,number>={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
const labels:Record<string,string>={
  revenues:'Revenues','total revenues':'Revenues','revenue':'Revenues','net revenue':'Revenues','net revenues':'Revenues',
  'cost of revenue':'CostOfRevenue','gross profit':'GrossProfit','total operating expenses':'OperatingExpenses',
  'research and development':'ResearchAndDevelopmentExpense','general and administrative':'GeneralAndAdministrativeExpense','marketing':'SellingAndMarketingExpense',
  'total operating costs and expenses':'CostsAndExpenses',
  'total costs and expenses':'CostsAndExpenses',
  'loss from operations':'OperatingIncomeLoss','income from operations':'OperatingIncomeLoss',
  'operating income':'OperatingIncomeLoss','operating loss':'OperatingIncomeLoss',
  'net income / (loss) before income taxes':'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
  'income / (loss) before income taxes':'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
  'income before income taxes':'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
  'income before income tax':'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
  'loss before income taxes':'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
  'income tax expense':'IncomeTaxExpenseBenefit','provision for income taxes':'IncomeTaxExpenseBenefit',
  'net income / (loss) from continuing operations':'IncomeLossFromContinuingOperations',
  'net income (loss) from continuing operations':'IncomeLossFromContinuingOperations',
  'net income / (loss)':'NetIncomeLoss','net income (loss)':'NetIncomeLoss','net income':'NetIncomeLoss','net loss':'NetIncomeLoss',
};
/** A row's printed label without its footnote or note references: "NET REVENUE (Notes 20, 31 and 37)" → "NET REVENUE". */
const rowLabel=(row:Cell[])=>(row.find(c=>c.text)?.text??'').replace(/\s*\((?:Notes?\s[^)]*|\d+)\)\s*$/i,'').trim();
/** ISO codes for the currencies a statement title names; a title naming any other currency is not read. */
const currencies:Array<[RegExp,string]>=[[/^new\s+taiwan\s+dollars?$/i,'TWD'],[/^(?:u\.?s\.?\s+)?dollars?$/i,'USD'],[/^hong\s+kong\s+dollars?$/i,'HKD'],[/^canadian\s+dollars?$/i,'CAD'],[/^australian\s+dollars?$/i,'AUD'],[/^singapore\s+dollars?$/i,'SGD'],[/^(?:japanese\s+)?yen$/i,'JPY'],[/^(?:korean\s+)?won$/i,'KRW'],[/^euros?$/i,'EUR'],[/^(?:renminbi|chinese\s+yuan|yuan)$/i,'CNY'],[/^(?:pounds?\s+sterling|british\s+pounds?)$/i,'GBP'],[/^swiss\s+francs?$/i,'CHF'],[/^(?:indian\s+)?rupees?$/i,'INR']];
/** Scale and currency from the statement title: "(In Thousands of New Taiwan Dollars, …)" → thousands of TWD.
 * A title without a named currency is USD only under the "$ in millions" convention; anything unrecognised is null, never USD. */
function statementUnit(preceding:string):{scale:number;currency:string}|null {
  const scaleOf=(word:string)=>word.toLowerCase()==='millions'?1e6:1e3;
  const named=preceding.match(/\bin\s+(millions|thousands)\s+of\s+((?:[A-Za-z.]+\s+){0,2}(?:dollars?|yen|won|euros?|renminbi|yuan|pounds?(?:\s+sterling)?|francs?|rupees?|reais|real|pesos?|rand|kronor|kroner|krona|rupiah|baht|ringgit|shekels?|lira|zloty|forint))\b/i);
  if(named){const code=currencies.find(([pattern])=>pattern.test(named[2].trim()))?.[1];return code?{scale:scaleOf(named[1]),currency:code}:null;}
  const scaleMatch=preceding.match(/(?:in|\$\s*in)\s+(millions|thousands)\s+(?:of\s+(?:U\.?S\.?\s+)?dollars)?/i);
  return scaleMatch&&/(?:U\.?S\.?\s+dollars|USD|\$)/i.test(preceding)?{scale:scaleOf(scaleMatch[1]),currency:'USD'}:null;
}
type Cell={text:string;column:number;span:number};
function rows(table:string):Cell[][] {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row=>{
    let column=0;
    return [...row[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map(cell=>{
      const span=Number(cell[1].match(/colspan=["'](\d+)["']/i)?.[1]??1),value={text:clean(cell[2]),column,span};column+=span;return value;
    });
  });
}
function periodColumns(headers:Cell[][]) {
 const periods=new Map<number,{start:string;end:string}>();
    for(const row of headers) for(const group of row) {
      const date=group.text.match(/^(?:For\s+the\s+)?(Three|Six|Nine)\s+months\s+ended\s+(\w+)\s+(\d{1,2}),?$/i);
      if(!date)continue;
      const month=months[date[2].toLowerCase()],day=Number(date[3]),duration={three:3,six:6,nine:9}[date[1].toLowerCase()]!;
      if(!month)continue;
      for(const yearRow of headers) for(const cell of yearRow) {
        if(cell.column<group.column||cell.column>=group.column+group.span||!/^20\d{2}$/.test(cell.text))continue;
        const year=Number(cell.text);
        if(new Date(Date.UTC(year,month,0)).getUTCDate()!==day)continue;
        periods.set(cell.column,{start:new Date(Date.UTC(year,month-duration,1)).toISOString().slice(0,10),end:new Date(Date.UTC(year,month-1,day)).toISOString().slice(0,10)});
      }
    }
 return periods;
}
function cellValue(cell:Cell,row:Cell[],scale:number):number|null {
 const raw=cell.text.replace(/[$,\s]/g,'');
 if(!/^\(?[+-]?\d+(?:\.\d+)?\)?$/.test(raw))return null;
 const next=row.find(c=>c.column===cell.column+cell.span);
 return Number(raw.replace(/[()]/g,''))*scale*(raw.startsWith('(')||next?.text===')'?-1:1);
}
/** Segment rows are accepted only inside an explicitly totalled revenue section.
 * The statement supplies units; both the segment subtotal and consolidated total
 * must reconcile in the same dated column. Elimination is an independent fact. */
function segmentFacts(html:string,source:DocumentSource,statement:Fact[],scale:number):Fact[] {
 const result:Fact[]=[];
 for(const [tableIndex,match] of [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].entries()) {
  const grid=rows(match[0]),label=(row:Cell[])=>row.find(c=>c.text)?.text??'';
  const begin=grid.findIndex(row=>/^revenues?:?$/i.test(label(row))),subtotal=grid.findIndex(row=>/^total segment revenues?$/i.test(label(row)));
  const total=grid.findIndex(row=>/^total revenues?$/i.test(label(row)));
  if(begin<0||subtotal<=begin||total<=subtotal)continue;
  const periods=periodColumns(grid.slice(0,begin));
  for(const [column,period] of periods){
   const reference=statement.find(f=>f.tag==='table:Revenues'&&f.start===period.start&&f.end===period.end);
   if(!reference)continue;
   const at=(row:Cell[])=>{const cell=row.find(c=>c.column===column);return cell?cellValue(cell,row,scale):null;};
   const businesses=grid.slice(begin+1,subtotal).map((row,i)=>({row,index:begin+1+i,name:label(row),value:at(row)})).filter(r=>r.name);
   const adjustments=grid.slice(subtotal+1,total).map((row,i)=>({row,index:subtotal+1+i,name:label(row),value:at(row)})).filter(r=>r.name);
   const sum=at(grid[subtotal]),consolidated=at(grid[total]);
   if(!businesses.length||businesses.some(r=>r.value===null||r.value<0)||adjustments.some(r=>!/(?:eliminations?|intersegment)/i.test(r.name)||r.value===null)||sum===null||consolidated===null)continue;
   const near=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1,Math.abs(b)*1e-9);
   if(!near(businesses.reduce((n,r)=>n+r.value!,0),sum)||!near(sum+adjustments.reduce((n,r)=>n+r.value!,0),consolidated)||!near(consolidated,reference.value))continue;
   for(const r of [...businesses,...adjustments])result.push({source,tag:'table:Revenues',value:r.value!,currency:reference.currency,...period,context:`table-${tableIndex}:row-${r.index}:column-${column}`,dimensions:businesses.includes(r)?{'table:StatementBusinessSegmentsAxis':r.name}:{'table:ConsolidationItemsAxis':'EliminationsMember'},precision:reference.precision});
  }
 }
 return result;
}
function withFirstQuarters(facts:Fact[]):Fact[] {
 const output=[...facts];
 for(const current of facts.filter(f=>(Date.parse(f.end)-Date.parse(f.start))/86400000<110)) {
  const cumulative=facts.find(f=>f.tag===current.tag&&JSON.stringify(f.dimensions)===JSON.stringify(current.dimensions)&&f.end===current.end&&f.start<current.start&&(Date.parse(f.end)-Date.parse(f.start))/86400000<200);
  if(!cumulative)continue;
  const end=new Date(Date.parse(current.start)-86400000).toISOString().slice(0,10);
  output.push({...cumulative,end,value:Math.round((cumulative.value-current.value)*1e6)/1e6,context:`derived:${cumulative.context}-${current.context}`,operands:[cumulative,current],formula:'First quarter = six months to date − second quarter, same statement and basis'});
 }
 return output;
}
/** Rows printed between gross profit (or cost of revenue) and operating income, read under their own labels so the
 * operating bridge keeps every line, including ones the label map does not name. */
const lineTag=(label:string)=>label.replace(/[^A-Za-z0-9]+/g,' ').trim().split(' ').map(w=>w[0].toUpperCase()+w.slice(1).toLowerCase()).join('');
const OPERATING_TOTALS=new Set(['OperatingExpenses','CostsAndExpenses']);
/**
 * Statements print expenses as positive amounts; a line of other operating income printed beside them is a credit.
 * Which line that is follows from the statement's own arithmetic, not its wording: the operating lines must sum to
 * gross profit less operating income in every dated column, and at most one line may need the opposite orientation.
 * No consistent reading means no line is turned.
 */
function creditLines(facts:Fact[],lineRows:number[]):Set<number> {
  const row=(f:Fact)=>Number(f.context.match(/:row-(\d+):/)?.[1]);
  const byPeriod=new Map<string,Fact[]>();
  for(const f of facts){const key=f.start+'|'+f.end;byPeriod.set(key,[...(byPeriod.get(key)??[]),f]);}
  const reconciles=(credit:number|null)=>{
    let checked=0;
    for(const period of byPeriod.values()){
      const of=(tag:string)=>period.find(f=>f.tag==='table:'+tag)?.value;
      const revenue=of('Revenues'),cost=of('CostOfRevenue'),operating=of('OperatingIncomeLoss'),gross=of('GrossProfit')??(revenue!=null&&cost!=null?revenue-cost:undefined);
      const lines=lineRows.map(r=>period.find(f=>row(f)===r));
      if(gross==null||operating==null||lines.some(f=>!f))continue;
      checked++;
      if(Math.abs(lines.reduce((sum,f)=>sum+(row(f!)===credit?-f!.value:f!.value),0)-(gross-operating))>1)return false;
    }
    return checked>0;
  };
  if(!lineRows.length||reconciles(null))return new Set();
  const credits=lineRows.filter(r=>reconciles(r));
  return new Set(credits.length===1?credits:[]);
}
/** Non-XBRL SEC statements: bind amounts to explicit header columns, never flattened
 * numeric positions (which can mistake note numbers for amounts). No company-specific rules.
 * Full statements of operations, income or comprehensive income qualify, in the currency and scale their title names
 * (a title naming no currency is read as USD only under the "$ in millions" convention), with dated 3M/6M/9M columns. */
export function readStatementTableFacts(html:string,source:DocumentSource):Fact[] {
  const output:Fact[]=[];
  for(const [tableIndex,match] of [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].entries()) {
    const preceding=clean(html.slice(Math.max(0,match.index!-2500),match.index));
    if(!/consolidated\s+statements?\s+of\s+(?:comprehensive\s+)?(?:operations|income|loss|profit\s+or\s+loss)/i.test(preceding)||/non-gaap/i.test(preceding.slice(-500)))continue;
    const unit=statementUnit(preceding);if(!unit)continue;
    const {scale,currency}=unit;
    const grid=rows(match[0]);
    const printed=grid.map(rowLabel),tags=printed.map(label=>labels[label.toLowerCase()]);
    const firstData=tags.indexOf('Revenues');
    if(firstData<0)continue;
    const operatingAt=tags.indexOf('OperatingIncomeLoss'),openAt=operatingAt<0?-1:tags.slice(0,operatingAt).findLastIndex(tag=>tag==='GrossProfit'||tag==='CostOfRevenue');
    const lineRows:number[]=[];
    if(openAt>=0)for(let i=openAt+1;i<operatingAt;i++){
      if(!tags[i]&&printed[i]&&!/^total\b/i.test(printed[i]))tags[i]=lineTag(printed[i]);
      if(tags[i]&&!OPERATING_TOTALS.has(tags[i]))lineRows.push(i);
    }
    const periods=periodColumns(grid.slice(0,firstData));
    const facts:Fact[]=[];
    for(const [rowIndex,row] of grid.entries()) {
      const tag=tags[rowIndex];if(!tag)continue;
      // An all-capitals heading reads in sentence case; the words are the statement's own.
      const label=printed[rowIndex]===printed[rowIndex].toUpperCase()?printed[rowIndex][0]+printed[rowIndex].slice(1).toLowerCase():printed[rowIndex];
      for(const cell of row) {
        const period=periods.get(cell.column);if(!period)continue;
        const raw=cell.text.replace(/[$,\s]/g,'');
        // A dash or blank remains unknown; it is never silently converted to zero.
        if(!/^\(?[+-]?\d+(?:\.\d+)?\)?$/.test(raw))continue;
        const next=row.find(c=>c.column===cell.column+cell.span);
        const value=Number(raw.replace(/[()]/g,''))*scale*(raw.startsWith('(')||next?.text===')'?-1:1);
        facts.push({source,tag:`table:${tag}`,value,currency,...period,context:`table-${tableIndex}:row-${rowIndex}:column-${cell.column}`,dimensions:{},precision:(raw.split('.')[1]?.replace(/\)/g,'').length??0)-Math.log10(scale),statementRow:{order:rowIndex,label,flip:false}});
      }
    }
    // Keep a single presentation for all concepts. Do not combine a partial statement with
    // management tables or another filing to manufacture completeness.
    const concepts=new Set(facts.map(f=>f.tag));
    if(!concepts.has('table:Revenues'))continue;
    const credits=creditLines(facts,lineRows.filter(r=>facts.some(f=>f.statementRow!.order===r)));
    for(const f of facts)if(credits.has(f.statementRow!.order))f.statementRow={...f.statementRow!,flip:true};
    return withFirstQuarters([...facts,...segmentFacts(html,source,facts,scale)]);
  }
  return output;
}
