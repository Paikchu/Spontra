import type { DocumentSource, Fact } from './parser.ts';

const clean = (value:string) => value.replace(/<[^>]*>/g,' ').replace(/&#(?:x([\da-f]+)|(\d+));/gi,(_,hex,dec)=>String.fromCodePoint(parseInt(hex??dec,hex?16:10))).replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/[\u200b-\u200d\ufeff]/g,'').replace(/\s+/g,' ').trim();
const months:Record<string,number>={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
const labels:Record<string,string>={
  revenues:'Revenues','total revenues':'Revenues','revenue':'Revenues',
  'total operating costs and expenses':'CostsAndExpenses',
  'total costs and expenses':'CostsAndExpenses',
  'loss from operations':'OperatingIncomeLoss','income from operations':'OperatingIncomeLoss',
  'operating income':'OperatingIncomeLoss','operating loss':'OperatingIncomeLoss',
  'net income / (loss) before income taxes':'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
  'income / (loss) before income taxes':'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
  'income before income taxes':'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
  'loss before income taxes':'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
  'income tax expense':'IncomeTaxExpenseBenefit','provision for income taxes':'IncomeTaxExpenseBenefit',
  'net income / (loss) from continuing operations':'IncomeLossFromContinuingOperations',
  'net income (loss) from continuing operations':'IncomeLossFromContinuingOperations',
  'net income / (loss)':'NetIncomeLoss','net income (loss)':'NetIncomeLoss','net income':'NetIncomeLoss','net loss':'NetIncomeLoss',
};
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
      const date=group.text.match(/^(Three|Six|Nine) months ended (\w+) (\d{1,2}),?$/i);
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
  output.push({...cumulative,end,value:Math.round((cumulative.value-current.value)*1e6)/1e6,context:`derived:${cumulative.context}-${current.context}`,operands:[cumulative,current],formula:'同一份报表、相同口径的六个月累计 − 第二季度 = 第一季度'});
 }
 return output;
}
/** Non-XBRL SEC statements: bind amounts to explicit header columns, never flattened
 * numeric positions (which can mistake note numbers for amounts). No company-specific rules.
 * Only full GAAP statements with an explicit USD scale and dated 3M/6M/9M columns qualify. */
export function readStatementTableFacts(html:string,source:DocumentSource):Fact[] {
  const output:Fact[]=[];
  for(const [tableIndex,match] of [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].entries()) {
    const preceding=clean(html.slice(Math.max(0,match.index!-2500),match.index));
    if(!/consolidated\s+statements?\s+of\s+(?:operations|income|loss)/i.test(preceding)||/non-gaap/i.test(preceding.slice(-500)))continue;
    const scaleMatch=preceding.match(/(?:in|\$\s*in)\s+(millions|thousands)\s+(?:of\s+(?:U\.?S\.?\s+)?dollars)?/i);
    if(!scaleMatch||!/(?:U\.?S\.?\s+dollars|USD|\$)/i.test(preceding))continue;
    const scale=scaleMatch[1].toLowerCase()==='millions'?1e6:1e3;
    const grid=rows(match[0]);
    const firstData=grid.findIndex(row=>labels[row.find(c=>c.text)?.text.toLowerCase()??'']==='Revenues');
    if(firstData<0)continue;
    const periods=periodColumns(grid.slice(0,firstData));
    const facts:Fact[]=[];
    for(const [rowIndex,row] of grid.entries()) {
      const label=row.find(c=>c.text)?.text.toLowerCase().replace(/\s*\(\d+\)$/,'')??'',tag=labels[label];if(!tag)continue;
      for(const cell of row) {
        const period=periods.get(cell.column);if(!period)continue;
        const raw=cell.text.replace(/[$,\s]/g,'');
        // A dash or blank remains unknown; it is never silently converted to zero.
        if(!/^\(?[+-]?\d+(?:\.\d+)?\)?$/.test(raw))continue;
        const next=row.find(c=>c.column===cell.column+cell.span);
        const value=Number(raw.replace(/[()]/g,''))*scale*(raw.startsWith('(')||next?.text===')'?-1:1);
        facts.push({source,tag:`table:${tag}`,value,currency:'USD',...period,context:`table-${tableIndex}:row-${rowIndex}:column-${cell.column}`,dimensions:{},precision:(raw.split('.')[1]?.replace(/\)/g,'').length??0)-Math.log10(scale)});
      }
    }
    // Keep a single presentation for all concepts. Do not combine a partial statement with
    // management tables or another filing to manufacture completeness.
    const concepts=new Set(facts.map(f=>f.tag));
    if(!concepts.has('table:Revenues'))continue;
    return withFirstQuarters([...facts,...segmentFacts(html,source,facts,scale)]);
  }
  return output;
}
