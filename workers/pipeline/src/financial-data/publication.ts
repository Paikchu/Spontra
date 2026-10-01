import {AnalysisRequestError} from '../read-api/contract-support/errors.ts';
import {publicFlowSchema} from '../../../../shared/analysis-runtime/financial-data/schema.ts';
import {D1SecRepository} from '../sec/d1.ts';
import {businessFlowCacheKey} from '../sec/business-flow-cache.ts';
import {newestPair} from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import {withLegacyInterestFormula} from '../../../../shared/analysis-runtime/financial-data/disclosed-quarter.ts';
import type {CompleteFlowPublication} from '../../../../shared/analysis-contract/complete-business-flow.ts';
import type {PublicBusinessFlow} from '../../../../shared/analysis-contract/business-flow.ts';
import {checkCompleteFlow} from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
/** Reads only the pointer to complete immutable versions, never staged quarters. */
export async function readCompletePublication(db:D1Database,cik:string):Promise<CompleteFlowPublication>{
 const row=await db.prepare(`SELECT v.payload_json FROM financial_complete_current c JOIN financial_complete_versions v ON v.version_id=c.version_id WHERE c.cik=?`).bind(cik).first<{payload_json:string}>();
 const attempt=await db.prepare(`SELECT status,reasons_json,updated_at FROM financial_collection_jobs WHERE cik=? ORDER BY generation DESC LIMIT 1`).bind(cik).first<{status:string;reasons_json:string;updated_at:string}>();
 const flow=row?publicFlowSchema.parse(JSON.parse(row.payload_json)):null;if(flow&&!checkCompleteFlow(flow).complete)throw new Error('Published snapshot failed validation');
 return {schemaVersion:'complete-business-flow.v1',status:flow?'ready':attempt?.status==='unavailable'?'unavailable':'preparing',flow,reasons:attempt&&attempt.status!=='succeeded'?JSON.parse(attempt.reasons_json):flow?[]:['MISSING_TWO_QUARTERS'],outdated:!!flow&&!!attempt&&attempt.status!=='succeeded',lastAttemptAt:attempt?.updated_at??null};
}

/** Data-only public projection: no AI payload, no staged partial quarters, no read-side refresh. */
export async function readCompletePublicationForTicker(db:D1Database,ticker:string):Promise<CompleteFlowPublication>{
 ticker=ticker.trim().toUpperCase();if(!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker))throw new AnalysisRequestError('INVALID_TICKER','Invalid company ticker.');
 const identity=await db.prepare('SELECT cik FROM financial_collection_jobs WHERE ticker=? ORDER BY generation DESC LIMIT 1').bind(ticker).first<{cik:string}>();
 const current=identity?await readCompletePublication(db,identity.cik):null;
 if(current?.flow)return current;
 // Preserve an already verified legacy complete snapshot during the migration.
 const legacy=await new D1SecRepository(db).getCache<PublicBusinessFlow>(businessFlowCacheKey(ticker));
 if(legacy?.payload.ticker===ticker){const flow=newestPair(withLegacyInterestFormula(publicFlowSchema.parse(legacy.payload)));if(checkCompleteFlow(flow).complete)return {schemaVersion:'complete-business-flow.v1',status:'ready',flow,reasons:current?.reasons??[],outdated:!!identity,lastAttemptAt:current?.lastAttemptAt??null};}
 return current??{schemaVersion:'complete-business-flow.v1',status:'preparing',flow:null,reasons:['MISSING_TWO_QUARTERS'],outdated:false,lastAttemptAt:null};
}
