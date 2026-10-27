import type { DocumentSource, Fact } from './parser.ts';
import { quarterCode } from '../../../../shared/analysis-runtime/financial-data/earnings-release.ts';

const clean = (value:string) => value.replace(/<[^>]*>/g,' ').replace(/&#(?:x([\da-f]+)|(\d+));/gi,(_,hex,dec)=>String.fromCodePoint(parseInt(hex??dec,hex?16:10))).replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/[\u200b-\u200d\ufeff]/g,'').replace(/\s+/g,' ').trim();
const months:Record<string,number>={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
const labels:Record<string,string>={
  revenues:'Revenues','total revenues':'Revenues','revenue':'Revenues','net revenue':'Revenues','net revenues':'Revenues',
  'total revenue':'Revenues','total net revenue':'Revenues','total net revenues':'Revenues','net sales':'Revenues','total net sales':'Revenues',
  'cost of revenue':'CostOfRevenue','cost of revenues':'CostOfRevenue','total cost of revenue':'CostOfRevenue','total cost of revenues':'CostOfRevenue',
  'cost of sales':'CostOfRevenue','total cost of sales':'CostOfRevenue',
  'gross profit':'GrossProfit','gross margin':'GrossProfit','total operating expenses':'OperatingExpenses',
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
  'net income and comprehensive income':'NetIncomeLoss','net loss and comprehensive loss':'NetIncomeLoss',
};
/** A label's concept, also when it prints its alternative in parentheses: "Operating income (loss)",
 * "Provision for (benefit from) income taxes" read as "operating income", "provision for income taxes". */
const conceptOf=(label:string)=>{const key=label.toLowerCase();return labels[key]??labels[key.replace(/\s*\((?:loss|income|benefit(?:\s+from)?|expense|provision(?:\s+for)?|gain|profit)\)\s*/g,' ').replace(/\s+/g,' ').trim()];};
/** A row's printed label without its footnote or note references: "NET REVENUE (Notes 20, 31 and 37)" → "NET REVENUE". */
const rowLabel=(row:Cell[])=>(row.find(c=>c.text)?.text??'').replace(/(?:\s*\((?:Notes?\s[^)]*|\d+|[a-z])\))+\s*$/i,'').replace(/\s*:$/,'').trim();
/** ISO codes for the currencies a statement title names; a title naming any other currency is not read. */
const currencies:Array<[RegExp,string]>=[[/^new\s+taiwan\s+dollars?$/i,'TWD'],[/^(?:u\.?s\.?\s+)?dollars?$/i,'USD'],[/^hong\s+kong\s+dollars?$/i,'HKD'],[/^canadian\s+dollars?$/i,'CAD'],[/^australian\s+dollars?$/i,'AUD'],[/^singapore\s+dollars?$/i,'SGD'],[/^(?:japanese\s+)?yen$/i,'JPY'],[/^(?:korean\s+)?won$/i,'KRW'],[/^euros?$/i,'EUR'],[/^(?:renminbi|chinese\s+yuan|yuan)$/i,'CNY'],[/^(?:pounds?\s+sterling|british\s+pounds?)$/i,'GBP'],[/^swiss\s+francs?$/i,'CHF'],[/^(?:indian\s+)?rupees?$/i,'INR']];
/** Scale and currency from the statement title: "(In Thousands of New Taiwan Dollars, …)" → thousands of TWD.
 * A title without a named currency is USD only under the "$ in millions" convention, or when the table's own amounts
 * are printed with a bare "$" ("(in millions, except per share data)"); anything unrecognised is null, never USD. */
function statementUnit(preceding:string,table:string):{scale:number;currency:string}|null {
  const scaleOf=(word:string)=>word.toLowerCase()==='millions'?1e6:1e3;
  const named=preceding.match(/\bin\s+(millions|thousands)\s+of\s+((?:[A-Za-z.]+\s+){0,2}(?:dollars?|yen|won|euros?|renminbi|yuan|pounds?(?:\s+sterling)?|francs?|rupees?|reais|real|pesos?|rand|kronor|kroner|krona|rupiah|baht|ringgit|shekels?|lira|zloty|forint))\b/i);
  if(named){const code=currencies.find(([pattern])=>pattern.test(named[2].trim()))?.[1];return code?{scale:scaleOf(named[1]),currency:code}:null;}
  const scaleMatch=preceding.match(/\bin\s+(millions|thousands)\b(?:\s+of\s+(?:U\.?S\.?\s+)?dollars)?/i);
  const dollarCells=[...table.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].some(cell=>/^\$(?:\s*[\d(].*)?$/.test(clean(cell[1])));
  return scaleMatch&&(/(?:U\.?S\.?\s+dollars|USD|\$)/i.test(preceding)||dollarCells)?{scale:scaleOf(scaleMatch[1]),currency:'USD'}:null;
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
/** A row holding an amount (not a year) ends the header block. */
const amountRow=(row:Cell[])=>row.some(c=>!/^(?:19|20)\d{2}$/.test(c.text)&&/^\(?[+-]?\d[\d,]*(?:\.\d+)?\)?$/.test(c.text.replace(/[$\s]/g,'')));
const isoDay=(t:number)=>new Date(t).toISOString().slice(0,10);
/** The period each column reports, read from all header cells that cover it, so a duration, a date and a year
 * printed in separate rows or cells ("Three Months Ended" / "July 26," / "2026") read as one header.
 * A table that prints any date other than a month end keeps a 52/53-week calendar: each of its periods runs
 * 13 weeks per quarter back from its end, even one that happens to end on a month end.
 * Quarter-code columns ("4Q25 3Q25 2Q25") are dated from `latestQuarterEnd`, the newest quarter the document dates
 * itself: the newest code ends there and each earlier code three months before. The codes must then name that
 * quarter's own fiscal year: the year its fourth quarter ends in. */
function periodColumns(headers:Cell[][],latestQuarterEnd?:string) {
 const width=Math.max(0,...headers.flatMap(row=>row.map(c=>c.column+c.span)));
 // A printed header reaches to the next printed header in its row: filings often draw a group heading
 // ("Three Months Ended March 31,") narrower than the year columns beneath it.
 const reach=headers.map(row=>{const printed=row.filter(c=>c.text);return printed.map((c,i)=>({text:c.text,from:c.column,to:Math.max(c.column+c.span,printed[i+1]?.column??width)}));});
 const read:Array<{column:number;months:number;weeks:number;year:number;month:number;day:number;monthEnd:boolean}>=[];
 const coded:Array<{column:number;code:number}>=[];
 for(let column=0;column<width;column++){
  const text=reach.map(row=>row.find(c=>c.from<=column&&column<c.to)?.text??'').filter(Boolean).join(' ');
  if(/%|\bchange\b|constant\s+currency|non-gaap|as\s+adjusted/i.test(text))continue;
  const kind=text.match(/\b(three|six|nine|twelve)\s+months?\b|\b(quarter)s?\s+ended\b|\b(13|26|39|52|53)\s+weeks?\b|\b(?:fiscal\s+)?(year)\s+ended\b/i);
  const dates=[...text.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(20\d{2})\b/gi)];
  const code=quarterCode(text);
  if(!kind&&!dates.length&&code!==null){coded.push({column,code});continue;}
  if(!kind||dates.length!==1)continue;
  const months3=kind[1]?{three:3,six:6,nine:9,twelve:12}[kind[1].toLowerCase()]!:kind[2]?3:kind[3]?Math.round(Number(kind[3])/13)*3:12;
  const [,name,dayText,yearText]=dates[0],month=months[name.toLowerCase()],day=Number(dayText),year=Number(yearText);
  const lastDay=new Date(Date.UTC(year,month,0)).getUTCDate();
  if(day<1||day>lastDay)continue;
  read.push({column,months:months3,weeks:kind[3]?Number(kind[3]):months3/3*13,year,month,day,monthEnd:day===lastDay});
 }
 const weekly=read.some(r=>!r.monthEnd);
 const periods=new Map<number,{start:string;end:string}>();
 for(const r of read){
  const end=Date.UTC(r.year,r.month-1,r.day);
  periods.set(r.column,{start:weekly?isoDay(end-(r.weeks*7-1)*86400000):isoDay(Date.UTC(r.year,r.month-r.months,1)),end:isoDay(end)});
 }
 const anchor=latestQuarterEnd?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
 if(coded.length&&anchor&&!weekly){
  const year=Number(anchor[1]),month=Number(anchor[2]),newest=Math.max(...coded.map(c=>c.code));
  const fiscalYearEnd=new Date(Date.UTC(year,month-1+(4-(newest%4||4))*3,1));
  if(isoDay(Date.UTC(year,month,0))===latestQuarterEnd&&fiscalYearEnd.getUTCFullYear()===Math.floor((newest-1)/4))
   for(const c of coded){
    const back=(newest-c.code)*3;
    periods.set(c.column,{start:isoDay(Date.UTC(year,month-3-back,1)),end:isoDay(Date.UTC(year,month-back,0))});
   }
 }
 return periods;
}
/** The newest quarter end the document dates in its own words ("three months ended December 31, 2025"), filed at most
 * 120 days after it: the quarter a release reports. Coded columns are dated from it; nothing else is. */
function latestQuarterEnd(html:string,filedAt:string):string|undefined {
 const filed=Date.parse(filedAt);
 return clean(html).match(/\b(?:three\s+months|quarters?)\s+ended\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+20\d{2}/gi)
  ?.map(text=>{const [,name,day,year]=text.match(/(\w+)\s+(\d{1,2}),?\s+(20\d{2})$/)!;return isoDay(Date.UTC(Number(year),months[name.toLowerCase()]-1,Number(day)));})
  .filter(end=>Date.parse(end)<=filed&&filed-Date.parse(end)<=120*86400000).sort().at(-1);
}
/** The first amount a row prints under one period, wherever the header's span puts it. */
function amountAt(row:Cell[],periods:Map<number,{start:string;end:string}>,period:{start:string;end:string}):Cell|undefined {
 return row.find(c=>{const p=periods.get(c.column);return p?.start===period.start&&p.end===period.end&&/^\(?[+-]?\d+(?:\.\d+)?\)?$/.test(c.text.replace(/[$,\s]/g,''));});
}
const uniquePeriods=(periods:Map<number,{start:string;end:string}>)=>[...new Map([...periods.values()].map(p=>[p.start+'|'+p.end,p])).values()];
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
  for(const period of uniquePeriods(periods)){
   const reference=statement.find(f=>f.tag==='table:Revenues'&&f.start===period.start&&f.end===period.end);
   if(!reference)continue;
   const column=[...periods].find(([,p])=>p.start===period.start&&p.end===period.end)![0];
   const at=(row:Cell[])=>{const cell=amountAt(row,periods,period);return cell?cellValue(cell,row,scale):null;};
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
const PRETAX='IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest';
/**
 * Statements print expenses as positive amounts; a line of other operating income printed beside them is a credit.
 * Which line that is follows from the statement's own arithmetic, not its wording: the operating lines must sum to
 * gross profit (revenue, on a statement without cost of revenue) less operating income in every dated column, and at
 * most one line may need the opposite orientation.
 * No consistent reading means no line is turned.
 */
function creditLines(facts:Fact[],lineRows:number[],direct:boolean):Set<number> {
  const row=(f:Fact)=>Number(f.context.match(/:row-(\d+):/)?.[1]);
  const byPeriod=new Map<string,Fact[]>();
  for(const f of facts){const key=f.start+'|'+f.end;byPeriod.set(key,[...(byPeriod.get(key)??[]),f]);}
  const reconciles=(credit:number|null)=>{
    let checked=0;
    for(const period of byPeriod.values()){
      const of=(tag:string)=>period.find(f=>f.tag==='table:'+tag)?.value;
      const revenue=of('Revenues'),cost=of('CostOfRevenue'),operating=of('OperatingIncomeLoss'),gross=of('GrossProfit')??(revenue!=null&&cost!=null?revenue-cost:direct?revenue:undefined);
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
 * (a title naming no currency is USD under the "$ in millions" convention or when its amounts print a bare "$"),
 * with dated three-, six-, nine- or twelve-month (or "quarter ended") columns; year-to-date columns are not read. */
export function readStatementTableFacts(html:string,source:DocumentSource):Fact[] {
  const output:Fact[]=[];
  const tables=[...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)];
  const quarterEnd=latestQuarterEnd(html,source.filedAt);
  let boundary=0;
  for(const [tableIndex,match] of tables.entries()) {
    const grid=rows(match[0]);
    const firstAmount=grid.findIndex(amountRow);
    // The title is read from the text after the last table of amounts (a title set in its own table still counts)
    // and from the statement's own header rows.
    const preceding=clean(html.slice(Math.max(boundary,match.index!-2500),match.index))+' '+grid.slice(0,firstAmount<0?0:firstAmount).flat().map(c=>c.text).join(' ');
    if(firstAmount>=0)boundary=match.index!+match[0].length;
    if(firstAmount<0)continue;
    const title=[...preceding.matchAll(/consolidated\s+statements?\s+of\s+(?:comprehensive\s+)?(?:operations|income|loss|earnings|profit\s+or\s+loss)|\bincome\s+statements?\b(?!\s+data)/gi)].at(-1);
    if(!title)continue;
    // Only the statement's own heading decides non-GAAP: a release's GAAP statement often follows a paragraph about non-GAAP measures.
    const heading=preceding.slice(0,title.index).split(/[.:;]\s/).at(-1)+preceding.slice(title.index);
    if(/non-gaap/i.test(heading))continue;
    const unit=statementUnit(heading,match[0]);if(!unit)continue;
    const {scale,currency}=unit;
    const printed=grid.map(rowLabel),tags=printed.map(conceptOf);
    if(!tags.includes('Revenues'))continue;
    // Rows printed above the revenue total are its lines, read under their own labels; the parse uses them only when they add up to it.
    const revenueAt=grid.findIndex((row,i)=>tags[i]==='Revenues'&&amountRow(row));
    for(let i=firstAmount;i<revenueAt;i++)if(!tags[i]&&printed[i]&&amountRow(grid[i])&&!/^total\b/i.test(printed[i]))tags[i]=lineTag(printed[i]);
    // A statement without cost of revenue or gross profit prints its operating lines straight after the revenue total.
    const direct=!tags.some(tag=>tag==='GrossProfit'||tag==='CostOfRevenue');
    const operatingAt=tags.indexOf('OperatingIncomeLoss'),openAt=operatingAt<0?-1:direct?(revenueAt<operatingAt?revenueAt:-1):tags.slice(0,operatingAt).findLastIndex(tag=>tag==='GrossProfit'||tag==='CostOfRevenue');
    const lineRows:number[]=[];
    if(openAt>=0)for(let i=openAt+1;i<operatingAt;i++){
      if(!tags[i]&&printed[i]&&!/^total\b/i.test(printed[i]))tags[i]=lineTag(printed[i]);
      if(tags[i]&&!OPERATING_TOTALS.has(tags[i]))lineRows.push(i);
    }
    // Rows between operating income and income before taxes (interest, investment gains, equity-method results) are
    // read under their own labels too; a dash among them reads as zero, which the bridge accepts only where it balances.
    const pretaxAt=operatingAt<0?-1:tags.findIndex((tag,i)=>i>operatingAt&&tag===PRETAX);
    const otherRows=new Set<number>();
    if(pretaxAt>=0)for(let i=operatingAt+1;i<pretaxAt;i++){
      if(!tags[i]&&printed[i]&&!/^total\b/i.test(printed[i]))tags[i]=lineTag(printed[i]);
      if(tags[i])otherRows.add(i);
    }
    const periods=periodColumns(grid.slice(0,firstAmount),quarterEnd);
    const facts:Fact[]=[];
    for(const [rowIndex,row] of grid.entries()) {
      const tag=tags[rowIndex];if(!tag)continue;
      // An all-capitals heading reads in sentence case; the words are the statement's own.
      const label=printed[rowIndex]===printed[rowIndex].toUpperCase()?printed[rowIndex][0]+printed[rowIndex].slice(1).toLowerCase():printed[rowIndex];
      // One amount per period: the first a row prints under that period's header span.
      // A dash or blank elsewhere remains unknown; it is never silently converted to zero.
      for(const period of uniquePeriods(periods)) {
        const cell=amountAt(row,periods,period);
        if(!cell){
          if(otherRows.has(rowIndex)&&row.some(c=>{const p=periods.get(c.column);return p?.start===period.start&&p.end===period.end&&/^[—–-]+$/.test(c.text.replace(/[$\s]/g,''));}))
            facts.push({source,tag:`table:${tag}`,value:0,currency,...period,context:`table-${tableIndex}:row-${rowIndex}:dash`,dimensions:{},precision:-Math.log10(scale),statementRow:{order:rowIndex,label,flip:false}});
          continue;
        }
        const raw=cell.text.replace(/[$,\s]/g,'');
        const next=row.find(c=>c.column===cell.column+cell.span);
        const value=Number(raw.replace(/[()]/g,''))*scale*(raw.startsWith('(')||next?.text===')'?-1:1);
        facts.push({source,tag:`table:${tag}`,value,currency,...period,context:`table-${tableIndex}:row-${rowIndex}:column-${cell.column}`,dimensions:{},precision:(raw.split('.')[1]?.replace(/\)/g,'').length??0)-Math.log10(scale),statementRow:{order:rowIndex,label,flip:false}});
      }
    }
    // Keep a single presentation for all concepts. Do not combine a partial statement with
    // management tables or another filing to manufacture completeness.
    const concepts=new Set(facts.map(f=>f.tag));
    if(!concepts.has('table:Revenues'))continue;
    // A statement prints its revenue total once per period; two different totals (reported and managed basis) are a summary.
    const revenues=facts.filter(f=>f.tag==='table:Revenues');
    if(revenues.some(f=>revenues.some(g=>g.start===f.start&&g.end===f.end&&g.value!==f.value)))continue;
    const credits=creditLines(facts,lineRows.filter(r=>facts.some(f=>f.statementRow!.order===r)),direct);
    for(const f of facts)if(credits.has(f.statementRow!.order))f.statementRow={...f.statementRow!,flip:true};
    return withFirstQuarters([...facts,...segmentFacts(html,source,facts,scale)]);
  }
  return output;
}
