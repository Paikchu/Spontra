import { z } from "zod";
import type { AnalysisEnv } from "../operations.ts";
import type { MaterialSource, MaterialState, ParsedMaterialDocument } from "../../../../shared/analysis-contract/filing-material.ts";
import { createMaterialTable, documentCoverage, materialBlock, tableMarkdown, verifyTableCsv } from "../../../../shared/analysis-runtime/filing-material.ts";
import { decodeEntities } from "../../../../shared/analysis-runtime/financial-data/disclosure-extraction.ts";
import { readSourceBytes, type MaterialManifest } from "./archive.ts";
import { MATERIAL_PREFIX, materialDigest, materialPilotKey, materialReconciliationKey, materialStateKey } from "./store.ts";
import { parsedKey } from "./prepare.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const filename = z.string().min(1).max(200).regex(/^[^/\\]+$/);
const checks = ["original_image", "full_page_text", "numbers_and_periods", "table_cells", "locations_and_legend", "footnotes"] as const;
const transcriptSchema = z.object({title:z.string().min(1),description:z.string().min(1),text:z.string().min(1),unreadable:z.literal(false),tables:z.array(z.object({title:z.string().min(1),rowHeader:z.string(),columns:z.array(z.string()).min(1),rows:z.array(z.object({label:z.string(),cells:z.array(z.string())}).strict()).min(1),unit:z.string().nullable(),notes:z.array(z.string())}).strict()).min(1)}).strict();
export const sourceReconciliationSchema = z.object({
  approvalId:z.string().uuid(), requestId:z.string().uuid(), failedAttemptId:z.string().uuid(),
  sourceFilename:filename, sourceSha256:digest, failedExtractionSha256:digest,
  rawTranscriptionKey:z.string().min(1).max(1000), rawReviewKey:z.string().min(1).max(1000),
  candidateJson:z.string().min(1).max(80000), candidateSha256:digest, companionSha256:digest,
  review:z.object({type:z.literal("human-source-reconciliation.v1"),decision:z.literal("approved"),reviewer:z.string().trim().min(2).max(200),reviewedAt:z.string().datetime({offset:true}),
    attestation:z.literal("I personally compared the complete original image, source text, periods, figures, tables, locations, legends and footnotes, and approve this exact candidate."),
    sourceChecks:z.array(z.object({check:z.enum(checks),notes:z.string().trim().min(10).max(4000),locator:z.string().trim().min(3).max(500)}).strict()).length(checks.length),
  }).strict(),
}).strict();
const normalize=(text:string)=>text.normalize("NFKC").toLowerCase().replace(/[\u2010-\u2015−]/g,"-");
const tokens=(text:string)=>normalize(text).match(/[\p{L}\p{N}]+/gu)??[];
const words=(text:string)=>new Set(tokens(text));
const fail=(message:string):never=>{throw new Error(message);};
const providerAnswer=(raw:string):unknown=>{const value=JSON.parse(raw);const text=value.response??value.choices?.[0]?.message?.content;if(typeof text!=="string")return fail("Original provider response unreadable");return JSON.parse(text.replace(/^\s*```(?:json)?\s*/i,"").replace(/\s*```\s*$/,""));};

/** Deterministic checks supplement a declared human review, never replace it or fabricate model approval. */
export async function reconcileImageSource(env:AnalysisEnv,ticker:string,accession:string,input:z.infer<typeof sourceReconciliationSchema>){
  const db=env.DB!, identity=await materialDigest(JSON.stringify({ticker,accession,...input}));
  const admissionKey=`filing-material:human-approval:v1:${ticker}:${accession}:${input.approvalId}`;
  const prior=await db.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(admissionKey).first<{payload:string}>();
  if(prior){const receipt=JSON.parse(prior.payload);if(receipt.identity!==identity)fail("Approval id already used for different content");return {...receipt,reused:true};}
  if(await materialDigest(input.candidateJson)!==input.candidateSha256)fail("Candidate digest mismatch");
  const candidate=transcriptSchema.parse(JSON.parse(input.candidateJson));
  if(new Set(input.review.sourceChecks.map(item=>item.check)).size!==checks.length)fail("Every source-check category must be individually signed");
  const reviewedAt=Date.parse(input.review.reviewedAt);if(reviewedAt>Date.now()+60000||reviewedAt<Date.now()-24*60*60_000)fail("Human review must be current, not future-dated");
  const pilotKey=materialPilotKey(ticker,accession),stateKey=materialStateKey(ticker,accession);
  const [pilotRow,stateRow]=await Promise.all([db.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(pilotKey).first<{payload:string}>(),db.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(stateKey).first<{payload:string}>()]);
  if(!pilotRow||!stateRow)fail("Original pilot and material required");
  const pilot=JSON.parse(pilotRow!.payload),state:MaterialState=JSON.parse(stateRow!.payload);
  if(pilot.mode!=="shadow-pilot"||pilot.requestId!==input.requestId||pilot.chunkStatus!=="blocked"||state.status!=="blocked"||pilot.reconciliation)fail("Only the original blocked pilot may admit one source reconciliation");
  if(pilot.repairSource!==input.sourceFilename||pilot.repairRequestId!==input.failedAttemptId)fail("Failed source attempt does not match current pilot");
  if(!/\.(?:jpe?g|png|webp)$/i.test(input.sourceFilename))fail("Only a single raster source image is supported");
  const manifestObject=await env.SEC_FILINGS.get(`${MATERIAL_PREFIX}${ticker}/${accession}/manifest.json`);if(!manifestObject)fail("Archived manifest missing");
  const manifest:MaterialManifest=JSON.parse(await manifestObject!.text());
  if(manifest.filing.ticker!==ticker||manifest.filing.accession!==accession)fail("Manifest identity mismatch");
  const entry=manifest.entries.find(e=>e.filename===input.sourceFilename);if(!entry)fail("Source not in original accession inventory");
  const sourceId=`d${(await materialDigest(entry!.url)).slice(0,24)}`;
  const loadSource=async(id:string)=>{const row=await db.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(`filing-material:source:v1:${ticker}:${accession}:${id}`).first<{payload:string}>();if(!row)fail("Archived source receipt missing");return JSON.parse(row!.payload) as MaterialSource;};
  const source=await loadSource(sourceId);
  if(source.id!==sourceId||source.filename!==input.sourceFilename||source.sha256!==input.sourceSha256||source.url!==entry!.url)fail("Original image identity mismatch");
  await readSourceBytes(env,source); // Hash check of actual archived bytes, not caller metadata.
  const originalKey=parsedKey(state.filing,source),failedKey=`${originalKey}.recovery-${input.failedAttemptId}`;
  const failedObject=await env.SEC_FILINGS.get(failedKey);if(!failedObject)fail("Failed extraction receipt missing");
  const failedText=await failedObject!.text();if(await materialDigest(failedText)!==input.failedExtractionSha256)fail("Failed extraction changed");
  const failed:ParsedMaterialDocument=JSON.parse(failedText);
  if(failed.coverage.documentId!==source.id||failed.coverage.filename!==source.filename||!failed.coverage.issues.length)fail("Expected failed image extraction");
  const expectedIssues=failed.coverage.issues.map(issue=>`${source.filename}: ${issue}`);
  if(state.status!=="blocked"||JSON.stringify(state.issues)!==JSON.stringify(expectedIssues))fail("Other failures or material state changed; cannot bypass them");
  const rawPrefix=`sec-materials/vision-receipts/v1/${source.id}/${source.sha256}/image/${await materialDigest(failedKey)}/`;
  const rawKey=(key:string)=>key.startsWith(rawPrefix)&&/^[a-f0-9]{64}\.json$/.test(key.slice(rawPrefix.length));
  if(!rawKey(input.rawTranscriptionKey)||!rawKey(input.rawReviewKey)||input.rawTranscriptionKey===input.rawReviewKey)fail("Raw responses belong to another image or attempt");
  const [rawTranscript,rawReview]=await Promise.all([env.SEC_FILINGS.get(input.rawTranscriptionKey),env.SEC_FILINGS.get(input.rawReviewKey)]);
  if(!rawTranscript||!rawReview)fail("Original raw model responses missing");
  const rawTranscriptText=await rawTranscript!.text(),rawReviewText=await rawReview!.text();
  const originalTranscript=providerAnswer(rawTranscriptText) as {text?:unknown},originalReview=providerAnswer(rawReviewText) as {complete?:unknown;tableCount?:unknown};
  if(typeof originalTranscript.text!=="string"||originalReview.complete!==false||originalReview.tableCount!==candidate.tables.length)fail("Original failed review or independently counted table inventory mismatch");
  const companionFilename=input.sourceFilename.replace(/img\d+\.(?:jpe?g|png|webp)$/i,".htm");
  const companionEntry=manifest.entries.find(e=>e.filename===companionFilename);if(!companionEntry)fail("Same-page SEC HTML companion required");
  const companion=await loadSource(`d${(await materialDigest(companionEntry!.url)).slice(0,24)}`);
  if(companion.filename!==companionFilename||companion.url!==companionEntry!.url||companion.sha256!==input.companionSha256)fail("Companion source identity mismatch");
  const html=new TextDecoder().decode(await readSourceBytes(env,companion));
  const imageTag=[...html.matchAll(/<img\b[^>]*>/gi)].find(m=>new RegExp(`\\bsrc=["']${source.filename.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}["']`,"i").test(m[0]));
  if(!imageTag)fail("Companion does not contain this exact image");
  const end=html.indexOf("</table>",imageTag!.index),slice=html.slice(imageTag!.index!+imageTag![0].length,end);
  const font=/<font\b[^>]*\bcolor=["']white["'][^>]*>([\s\S]*?)<\/font>/i.exec(slice);if(!font)fail("Verifiable adjacent SEC text layer missing");
  const companionText=decodeEntities(font![1]!.replace(/<[^>]+>/g," ")),sourceWords=words(companionText),candidateWords=words(candidate.text);
  const missing=[...sourceWords].filter(word=>!candidateWords.has(word));if(missing.length)fail(`Candidate omits source text tokens: ${missing.slice(0,20).join(", ")}`);
  const inventedNumbers=[...candidateWords].filter(word=>/\d/.test(word)&&!sourceWords.has(word));if(inventedNumbers.length)fail(`Unsupported numeric/period tokens: ${inventedNumbers.join(", ")}`);
  const quantities=(text:string)=>new Set((normalize(text).match(/(?:[<>]=?\s*)?(?:[$€£]\s*)?\d+(?:[.,]\d+)*(?:\s*-\s*\d+(?:[.,]\d+)*)?(?:\s*(?:%|gw|mw|b|m))?/g)??[]).map(value=>value.replace(/\s+/g,"")));
  const sourceQuantities=quantities(companionText),extraQuantities=[...quantities(candidate.text)].filter(value=>!sourceQuantities.has(value));
  if(extraQuantities.length)fail(`Unsupported amount, sign, unit or range: ${extraQuantities.join(", ")}`);
  for(const table of candidate.tables)for(const row of table.rows){
    if(row.cells.length!==table.columns.length)fail("Table grid width mismatch");
    for(const value of [row.label,...row.cells])if(tokens(value).some(token=>!candidateWords.has(token)||!sourceWords.has(token)))fail("Table label/cell is absent from the complete transcript or original source text");
  }
  const base=`sec-materials/source-reconciliations/v1/${ticker}/${accession}/${source.id}/${identity}`;
  const receiptKey=`${base}/audit.json`,documentKey=`${base}/extracted.json`;
  const audit={method:"human-source-reconciliation.v1" as const,identity,approvalId:input.approvalId,requestId:input.requestId,source,failedExtractionKey:failedKey,failedExtractionSha256:input.failedExtractionSha256,originalIssues:failed.coverage.issues,rawTranscriptionKey:input.rawTranscriptionKey,rawTranscriptionSha256:await materialDigest(rawTranscriptText),rawReviewKey:input.rawReviewKey,rawReviewSha256:await materialDigest(rawReviewText),originalModelReview:originalReview,companion:{filename:companion.filename,sha256:companion.sha256,url:companion.url,text:companionText},candidateSha256:input.candidateSha256,candidateKey:`${base}/candidate.json`,review:input.review,machineChecks:{sourceTextTokenCoverage:true,numericTokenSupport:true,tableCount:candidate.tables.length}};
  const coverage=documentCoverage(source);Object.assign(coverage,{sourceImages:1,retainedImages:1,sourceTables:candidate.tables.length,retainedTables:candidate.tables.length,sourceTextChars:candidate.text.length,retainedTextChars:candidate.text.length,reconciliation:{method:audit.method,receiptKey,sourceSha256:source.sha256,candidateSha256:input.candidateSha256,reviewer:input.review.reviewer,reviewedAt:input.review.reviewedAt,failedExtractionKey:failedKey,originalIssues:failed.coverage.issues}});
  const tables=candidate.tables.map((t,index)=>{const asset=createMaterialTable(state.filing,source,t.title,{rowHeader:t.rowHeader,columns:t.columns,rows:t.rows.map(r=>({label:r.label,path:[],cells:r.cells.map(text=>({text,value:null}))})),unit:t.unit,notes:t.notes,xbrlBlock:null},index+1);const check=verifyTableCsv(asset.table,asset.csv);if(check.issues.length)fail(check.issues.join("; "));return asset;});
  const image=materialBlock(source,{kind:"image",title:candidate.title,text:`![${candidate.description.replace(/\]/g,"\\]")}](${source.url})\n\n${candidate.text}`,start:0});
  const evidence=materialBlock(source,{kind:"code",title:"Human source reconciliation — original model review failed",text:`\`\`\`json\n${JSON.stringify(audit)}\n\`\`\``,start:tables.length+1});
  const document:ParsedMaterialDocument={blocks:[image,...tables.map((t,i)=>({...materialBlock(source,{kind:"table",title:t.title,text:tableMarkdown(t.table),start:i+1}),id:t.tableId,tableId:t.tableId})),evidence],tables,facts:[],coverage};
  const documentText=JSON.stringify(document),pointer={parsedKey:documentKey,parsedHash:await materialDigest(documentText),receiptKey,identity};
  const immutable=async(key:string,value:string)=>{const existing=await env.SEC_FILINGS.get(key);if(existing){if(await existing.text()!==value)fail("Immutable reconciliation receipt conflict");return;}await env.SEC_FILINGS.put(key,value,{httpMetadata:{contentType:"application/json"},onlyIf:{etagDoesNotMatch:"*"}});};
  await immutable(audit.candidateKey,input.candidateJson);await immutable(receiptKey,JSON.stringify(audit));await immutable(documentKey,documentText);
  const pointerKey=materialReconciliationKey(ticker,accession,source.id,source.sha256);
  const accepted={identity,approvalId:input.approvalId,sourceFilename:source.filename,candidateSha256:input.candidateSha256,receiptKey,parsedKey:documentKey,mode:"shadow-pilot",resumeRequired:true};
  const guard="EXISTS(SELECT 1 FROM sec_cache WHERE cache_key=? AND payload=?) AND EXISTS(SELECT 1 FROM sec_cache WHERE cache_key=? AND payload=?) AND NOT EXISTS(SELECT 1 FROM sec_cache WHERE cache_key=?)";
  const at=new Date().toISOString(),receiptExists="EXISTS(SELECT 1 FROM sec_cache WHERE cache_key=? AND json_extract(payload,'$.identity')=?)";
  const results=await db.batch([
    db.prepare(`INSERT INTO sec_cache(cache_key,payload,fetched_at) SELECT ?,?,? WHERE ${guard} ON CONFLICT(cache_key) DO NOTHING`).bind(admissionKey,JSON.stringify(accepted),at,pilotKey,pilotRow!.payload,stateKey,stateRow!.payload,pointerKey),
    db.prepare(`INSERT INTO sec_cache(cache_key,payload,fetched_at) SELECT ?,?,? WHERE ${receiptExists} ON CONFLICT(cache_key) DO NOTHING`).bind(pointerKey,JSON.stringify(pointer),at,admissionKey,identity),
    db.prepare(`UPDATE sec_cache SET payload=json_set(payload,'$.reconciliation',json(?),'$.chunkStatus','preparing'),fetched_at=? WHERE cache_key=? AND payload=? AND ${receiptExists}`).bind(JSON.stringify(accepted),at,pilotKey,pilotRow!.payload,admissionKey,identity),
  ]);
  if(!results[0]?.meta?.changes)fail("Pilot or source changed before approval admission");
  return {...accepted,reused:false};
}
