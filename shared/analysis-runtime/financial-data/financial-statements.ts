import {parseMarkup, normalizedText, nodeText, descendants, type Element, type FilingDisclosures, type DisclosureLocator} from './disclosure-extraction.ts';

export const STATEMENTS_VERSION='sec-financial-statements.v1';
export interface StatementCell {
 column:number; rowSpan:number; colSpan:number; header:boolean; text:string; locator:DisclosureLocator;
 facts:{id:string;concept:string;value:string|null;status:string;period:FilingDisclosures['contexts'][number]['period']|null;unit:string|null;scale:string|null;dimensions:{axis:string;value:string}[]}[];
}
export interface StatementTable {id:string;title:string;section:string;precedingText:string;locator:DisclosureLocator;rows:{cells:StatementCell[]}[];columns:number;issues:string[]}
export interface FinancialStatements {
 version:string;status:'extracted'|'not_located';title:string;locator:DisclosureLocator|null;source:FilingDisclosures['source'];
 text:string;tables:StatementTable[];headings:{title:string;locator:DisclosureLocator}[];
 coverage:{tables:number;rows:number;cells:number;facts:number;linkedFacts:number;textCharacters:number;issues:string[]};
}
const loc=(n:Element):DisclosureLocator=>({start:n.start,end:n.end,elementId:n.attributes.id??n.attributes.name??null});
const ancestor=(n:Element,tag:string):Element|null=>{for(let p=n.parent;p;p=p.parent)if(p.local===tag)return p;return null;};
const itemNumber=(s:string)=>s.match(/\bitem[\s_.-]*(\d+[a-z]?)/i)?.[1]?.toLowerCase();
/** Extract the document's explicitly linked Financial Statements item, including notes.
 * Original cells are retained (including blank/dash cells); only XBRL facts supply normalized values.
 * This is a source-table representation, not a guessed cross-company accounting taxonomy.
 */
export function extractFinancialStatements(html:string,inventory:FilingDisclosures):FinancialStatements {
 const {nodes}=parseMarkup(html),anchors=new Map<string,Element>();
 for(const n of nodes){const id=n.attributes.id??n.attributes.name;if(id&&!anchors.has(id))anchors.set(id,n);}
 const links=nodes.filter(n=>n.local==='a'&&n.attributes.href?.startsWith('#')).map(n=>({node:n,title:normalizedText(n),target:anchors.get(n.attributes.href.slice(1))})).filter(x=>x.target&&x.target.start>x.node.end);
 const root=links.find(x=>/^(?:item\s*\d+[.\s]*)?(?:consolidated\s+)?financial statements\b/i.test(x.title)&&!/^notes\b/i.test(x.title));
 const empty:FinancialStatements={version:STATEMENTS_VERSION,status:'not_located',title:'Financial Statements',locator:null,source:inventory.source,text:'',tables:[],headings:[],coverage:{tables:0,rows:0,cells:0,facts:0,linkedFacts:0,textCharacters:0,issues:['FINANCIAL_STATEMENTS_SECTION_NOT_LOCATED']}};
 if(!root?.target)return empty;
 let sectionRoot=root.target;
 const boundary=(start:number,item:string|undefined)=>{
  const nextItems=links.filter(x=>x.target!.start>start&&itemNumber(x.target!.attributes.id??x.title)&&itemNumber(x.target!.attributes.id??x.title)!==item).map(x=>x.target!.start);
  const endings=links.filter(x=>x.target!.start>start&&/^(?:index (?:of|to) exhibits|signatures|form 10-k summary)$/i.test(x.title)).map(x=>x.target!.start);
  return [...nextItems,...endings];
 };
 let start=sectionRoot.start,ends=boundary(start,itemNumber(sectionRoot.attributes.id??root.title)),end=ends.length?Math.min(...ends):html.length;
 const issues:string[]=[];
 // Some 10-Ks explicitly place Item 8 financial statements in Part IV, Item 15.
 // Follow that in-document cross-reference; do not mistake the short Item 8 pointer for a complete chapter.
 const initialText=nodeText(parseMarkup(html.slice(start,end)).root,{blocks:true});
 if(!nodes.some(n=>n.local==='table'&&n.start>=start&&n.end<=end)&&/separate section|incorporat/i.test(initialText)){
  const referenced=[...initialText.matchAll(/item\s+(\d+)/gi)].map(m=>m[1]).filter(n=>n!==itemNumber(sectionRoot.attributes.id??root.title)).at(-1);
  const target=referenced?nodes.find(n=>n.start>end&&itemNumber(n.attributes.id??'')===referenced):undefined;
  if(target){sectionRoot=target;start=target.start;ends=boundary(start,referenced);end=ends.length?Math.min(...ends):html.length;}
  else issues.push('REFERENCED_FINANCIAL_STATEMENTS_NOT_LOCATED');
 }
 if(!ends.length)issues.push('NEXT_SEC_ITEM_NOT_LOCATED_SECTION_EXTENDS_TO_DOCUMENT_END');
 const inside=nodes.filter(n=>n.start>=start&&n.end<=end);
 const headings=links.filter(x=>x.target!.start>=start&&x.target!.start<end).map(x=>({title:x.title,locator:loc(x.target!)}));
 for(const n of inside){if(!['p','div','h1','h2','h3','h4'].includes(n.local)||ancestor(n,'table'))continue;const title=normalizedText(n);if(title.length<220&&/^(?:note\s+)?\d{1,2}[.\s]+[A-Z]/.test(title)&&/font-weight\s*:\s*(?:bold|[6-9]00)|<b[ >]|<strong[ >]/i.test(html.slice(n.start,n.end)))headings.push({title,locator:loc(n)});}
 headings.sort((a,b)=>a.locator.start-b.locator.start);
 const sectionFacts=inventory.facts.filter(f=>!f.hidden&&f.source.locator.start>=start&&f.source.locator.end<=end),linked=new Set<string>();
 const tableNodes=inside.filter(n=>n.local==='table');
 const tables:StatementTable[]=tableNodes.map((table,i)=>{
  const heading=headings.filter(h=>h.locator.start<=table.start).at(-1)?.title??root.title;
  const rows=descendants(table).filter(n=>n.local==='tr'&&ancestor(n,'table')===table);
  const occupied=new Map<number,number>(),tableIssues:string[]=[];let columns=0;
  const result=rows.map((row,r)=>{let column=0;return {cells:descendants(row).filter(n=>['td','th'].includes(n.local)&&ancestor(n,'tr')===row&&ancestor(n,'table')===table).map(cell=>{
   while((occupied.get(column)??0)>r)column++;
   const span=(name:string)=>{const raw=cell.attributes[name];if(!raw)return 1;const v=Number(raw);if(!Number.isSafeInteger(v)||v<1||v>1000){tableIssues.push(`INVALID_${name.toUpperCase()}:${cell.start}`);return 1;}return v;};
   const colSpan=span('colspan'),rowSpan=span('rowspan'),at=column;
   for(let c=at;c<at+colSpan;c++)occupied.set(c,r+rowSpan);column+=colSpan;columns=Math.max(columns,column);
   const facts=sectionFacts.filter(f=>f.source.locator.start>=cell.start&&f.source.locator.end<=cell.end).map(f=>{linked.add(f.id);return {id:f.id,concept:f.concept.name,value:f.normalizedValue,status:f.status,period:f.context?.period??null,unit:f.unit?[f.unit.numerator.map(u=>u.name).join('*'),f.unit.denominator.map(u=>u.name).join('*')].filter(Boolean).join('/'):f.unitRef,scale:f.scale,dimensions:f.context?.dimensions.map(d=>({axis:d.axis.name,value:d.member?.name??d.value}))??[]};});
   return {column:at,colSpan,rowSpan,header:cell.local==='th',text:nodeText(cell,{blocks:true,documentTextMode:true}).replace(/\s+/g,' ').trim(),locator:loc(cell),facts};
  })};});
  if(!table.closed)tableIssues.push('UNCLOSED_TABLE');
  const beforeStart=i?tableNodes[i-1].end:start;
  const precedingText=beforeStart<table.start?nodeText(parseMarkup(html.slice(beforeStart,table.start)).root,{blocks:true,documentTextMode:true}).replace(/\s+/g,' ').trim():'';
  return {precedingText,id:`table-${i+1}`,title:`${heading} · Table ${i+1}`,section:heading,locator:loc(table),rows:result,columns,issues:tableIssues};
 });
 const images=inside.filter(n=>n.local==='img');if(images.length)issues.push(`IMAGE_CONTENT_REQUIRES_REVIEW:${images.length}`);
 if(!tables.length)issues.push('NO_TABLES_IN_IDENTIFIED_FINANCIAL_STATEMENTS');
 const sectionTree=parseMarkup(html.slice(start,end));const text=nodeText(sectionTree.root,{blocks:true,documentTextMode:true}).replace(/[\t \u00a0]+/g,' ').trim();
 return {version:STATEMENTS_VERSION,status:'extracted',title:root.title,locator:{start,end,elementId:sectionRoot.attributes.id??sectionRoot.attributes.name??null},source:inventory.source,text,tables,headings,coverage:{tables:tables.length,rows:tables.reduce((n,t)=>n+t.rows.length,0),cells:tables.reduce((n,t)=>n+t.rows.reduce((s,r)=>s+r.cells.length,0),0),facts:sectionFacts.length,linkedFacts:linked.size,textCharacters:text.length,issues:[...issues,...tables.flatMap(t=>t.issues)]}};
}
