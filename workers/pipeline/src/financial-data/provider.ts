import type {Job} from './store.ts';
import type {DocumentBatch} from './collect.ts';
import {extractDisclosedQuarters, readReportedFacts, SEC_FLOW_PARSER_VERSION, type Fact, type DocumentSource} from './parser.ts';
import {priorPresentationOnly,reviewedCurrentPair} from './period-review.ts';
export interface SecReader {
 read(url:string):Promise<Response>;
 /** Persist exact bytes and all encountered facts independently of the chart projection. */
 archive?(source:DocumentSource,html:string,metadata?:{form?:string;reportDate?:string}):Promise<void>;
}
/** One reader is shared by the bounded consumer. It is not a promise of account-wide rate limiting. */
export function throttledSecReader(userAgent:string,fetcher:typeof fetch=fetch,delayMs=500):SecReader{
 if(!userAgent.trim())throw new Error('SEC contact user-agent is required');let next=0;
 return {read:async(url)=>{const parsed=new URL(url);if(parsed.protocol!=='https:'||!['www.sec.gov','data.sec.gov'].includes(parsed.hostname))throw new Error('Non-SEC source denied');const wait=Math.max(0,next-Date.now());next=Math.max(next,Date.now())+delayMs;if(wait)await new Promise(resolve=>setTimeout(resolve,wait));const response=await fetcher(url,{headers:{'user-agent':userAgent,accept:'application/json,text/html'},signal:AbortSignal.timeout(25000)});if([403,429].includes(response.status))throw new Error('SEC_ACCESS_PAUSED');if(!response.ok)throw new Error('SEC_SOURCE_UNAVAILABLE');return response;}};
}
async function readBoundedReport(response:Response):Promise<string>{
 if(Number(response.headers.get('content-length'))>12000000||!response.body)throw new Error('SEC_DOCUMENT_UNAVAILABLE');
 const reader=response.body.getReader(),decoder=new TextDecoder(),parts:string[]=[];let bytes=0;
 try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>12000000){await reader.cancel();throw new Error('SEC_DOCUMENT_UNAVAILABLE');}parts.push(decoder.decode(part.value,{stream:true}));}parts.push(decoder.decode());}finally{reader.releaseLock();}
 const html=parts.join('');if(!html.trim())throw new Error('SEC_DOCUMENT_UNAVAILABLE');return html;
}
/** A filing's primary document plus at most two same-filing Exhibit 99 documents, each size-bounded. */
export async function readFilingDocuments(primaryUrl:string,reader:SecReader):Promise<Array<{url:string;html:string}>>{
 const response=await reader.read(primaryUrl);if(Number(response.headers.get('content-length'))>12000000)throw new Error('Document too large');
 const html=await readBoundedReport(response);const documents=[{url:primaryUrl,html}];
 // Earnings 8-K primary documents often link their actual GAAP statements in Exhibit 99.
 // Follow at most two same-filing named exhibits, never an arbitrary outbound URL.
 const folder=primaryUrl.slice(0,primaryUrl.lastIndexOf('/')+1);
 const candidates = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
  .filter(row => /\b99(?:\.\d+)?\b/.test(row[1].replace(/<[^>]*>/g,' ')))
  .flatMap(row => [...row[1].matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(link=>link[1]));
 candidates.push(...[...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m=>m[1]).filter(path=>/ex[-_]?99/i.test(path)));
 const exhibits=[...new Set(candidates.map(path=>{try{return new URL(path,primaryUrl);}catch{return null;}})
  .filter((url):url is URL=>!!url&&url.href.startsWith(folder)&&url.href!==primaryUrl&&!url.search&&!url.hash&&/^[A-Za-z0-9_.-]+\.html?$/i.test(url.pathname.split('/').at(-1)!)).map(url=>url.href))].slice(0,2);
 for(const url of exhibits){const exhibit=await reader.read(url);if(Number(exhibit.headers.get('content-length'))>12000000)throw new Error('Document too large');const body=await readBoundedReport(exhibit);if(documents.reduce((n,d)=>n+d.html.length,0)+body.length>16000000)throw new Error('SEC_DOCUMENT_UNAVAILABLE');documents.push({url,html:body});}
 return documents;
}
export async function readSecDocumentBatch(job:Job,reader:SecReader,maxDocuments=2):Promise<DocumentBatch>{
 const cik=job.cik;if(!/^\d{10}$/.test(cik))throw new Error('Invalid CIK');const cursor=JSON.parse(job.cursor||'{}') as {documents?:Array<{url:string;accession:string;filedAt:string;periodEnd:string;form?:string}>;index?:number;industry?:DocumentSource['industry'];expectedPeriodEnd?:string;parserVersion?:string;reportedFacts?:Fact[];reviewDocuments?:Array<{source:DocumentSource;eligible:boolean}>;reviewRequired?:boolean;foreign?:boolean};
 if(cursor.parserVersion!==SEC_FLOW_PARSER_VERSION){cursor.index=0;cursor.parserVersion=SEC_FLOW_PARSER_VERSION;delete cursor.reportedFacts;delete cursor.reviewDocuments;delete cursor.reviewRequired;delete cursor.documents;}
 if(!cursor.documents){
  const response=await reader.read(`https://data.sec.gov/submissions/CIK${cik}.json`);const data=await response.json() as {cik:string|number;sic?:string;filings?:{recent?:{form:string[];accessionNumber:string[];primaryDocument:string[];filingDate:string[];reportDate:string[];items?:string[]}}};if(String(data.cik).padStart(10,'0')!==cik)throw new Error('Issuer identity mismatch');const recent=data.filings?.recent;if(!recent)throw new Error('Missing submissions');cursor.foreign=recent.form.some(form=>/^20-F/.test(form))&&!recent.form.some(form=>/^10-[QK]/.test(form));cursor.expectedPeriodEnd=cursor.foreign?undefined:recent.form.map((form,i)=>/^10-[QK](\/A)?$/.test(form)?recent.reportDate[i]:'').filter(v=>/^\d{4}-\d{2}-\d{2}$/.test(v)).sort().at(-1);const sic=Number(data.sic);cursor.industry=sic>=6300&&sic<6500?'insurance':sic>=6000&&sic<6300?'financial':'standard';cursor.documents=[];
  for(let i=0;i<recent.form.length&&cursor.documents.length<(cursor.foreign?32:10);i++){
   if(!/^(?:10-[QK]|20-F)(\/A)?$/.test(recent.form[i])&&!(cursor.foreign&&recent.form[i]==='6-K')&&!(recent.form[i]==='8-K'&&recent.items?.[i]?.includes('2.02')))continue;const accession=recent.accessionNumber[i],doc=recent.primaryDocument[i];if(!/^\d{10}-\d{2}-\d{6}$/.test(accession)||!/^[A-Za-z0-9_.-]+\.html?$/.test(doc))continue;
   const folder=`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-','')}/`;
   cursor.documents.push({url:folder+doc,accession,filedAt:recent.filingDate[i],periodEnd:recent.reportDate[i],form:recent.form[i]});
  }
  // The current statement and its adjacent filing provide the cumulative bridge.
  // Preserve Oracle's existing earnings-exhibit profile order.
  if(!cursor.foreign&&cik!=='0001341439')cursor.documents.sort((a,b)=>Number(a.form==='8-K')-Number(b.form==='8-K')||b.periodEnd.localeCompare(a.periodEnd));
  cursor.index=0;
  if(!cursor.documents.length)throw new Error('NO_SUPPORTED_FILINGS');
 }
 const quarters=[];const index=cursor.index??0;const selected=cursor.documents.slice(index,index+Math.max(1,Math.min(3,maxDocuments)));
 for(const document of selected){
  const documents=await readFilingDocuments(document.url,reader);
  for(const content of documents){
   const source={...document,url:content.url,cik,industry:cursor.industry??'unknown'};
   await reader.archive?.(source,content.html,{form:document.form,reportDate:document.periodEnd});
   const parsed=extractDisclosedQuarters(content.html,source),reported=readReportedFacts(content.html,source);
   if(reported.issues.length)throw new Error('SEC_FACT_FORMAT_UNSUPPORTED');
   if(cursor.foreign&&parsed.quarters.length){const latest=parsed.quarters.map(q=>q.periodEnd).sort().at(-1)!;if(!cursor.expectedPeriodEnd||latest>cursor.expectedPeriodEnd)cursor.expectedPeriodEnd=latest;}
   const expected=cursor.expectedPeriodEnd;
   const relevant=reported.facts.filter(f=>!expected||(f.end<=expected&&Date.parse(f.start)>=Date.parse(expected)-380*86400000));
   if(relevant.length){cursor.reportedFacts=[...(cursor.reportedFacts??[]),...relevant];cursor.reviewDocuments=[...(cursor.reviewDocuments??[]),{source,eligible:priorPresentationOnly(content.html)}];}
   if(parsed.issues.includes('RESTATEMENT_REVIEW_REQUIRED')&&relevant.length){cursor.reviewRequired=true;if(!priorPresentationOnly(content.html))throw new Error('RESTATEMENT_REVIEW_REQUIRED');}
   else quarters.push(...parsed.quarters);
   if(expected&&cursor.reportedFacts?.length){const review=reviewedCurrentPair(cursor.reportedFacts,expected,cursor.reviewDocuments??[]);if(review.reviewed){cursor.index=index+selected.length;return {quarters:review.quarters,nextCursor:JSON.stringify(cursor),finished:true,expectedPeriodEnd:expected};}}
  }
 }

 cursor.index=index+selected.length;if(cursor.reviewRequired&&cursor.index>=cursor.documents.length)throw new Error('RESTATEMENT_REVIEW_REQUIRED');return {quarters,nextCursor:JSON.stringify(cursor),finished:cursor.index>=cursor.documents.length,expectedPeriodEnd:cursor.expectedPeriodEnd};
}

export async function discoverDataIssuer(ticker:string,reader:SecReader):Promise<{cik:string;tickers:string[];name:string;industry:'unknown'}>{
 const raw=await (await reader.read('https://www.sec.gov/files/company_tickers_exchange.json')).json() as {fields:string[];data:unknown[][]};
 if(!Array.isArray(raw.fields)||!Array.isArray(raw.data))throw new Error('Invalid SEC issuer directory');
 const symbol=raw.fields.indexOf('ticker'),cik=raw.fields.indexOf('cik'),name=raw.fields.indexOf('name');
 if(symbol<0||cik<0||name<0)throw new Error('Invalid SEC issuer directory');
 const canonical=ticker.toUpperCase().replaceAll("-", ".");
 const row=raw.data.find(row=>String(row[symbol]).toUpperCase().replaceAll("-", ".")===canonical);if(!row)throw new Error('SEC_ISSUER_NOT_FOUND');const identifier=String(row[cik]).padStart(10,'0');if(!/^\d{10}$/.test(identifier))throw new Error('Invalid issuer identity');
 return {cik:identifier,tickers:[ticker],name:String(row[name]),industry:'unknown'};
}
