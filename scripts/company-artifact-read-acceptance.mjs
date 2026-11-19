/** Exercise the real BFF handler with missing/stored/failed upstream responses; no network calls. */
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const server=await createServer({configFile:'apps/business-site/vite.config.ts',server:{middlewareMode:true},appType:'custom'});
const evidence=[];
try{
 const {handle}=await server.ssrLoadModule(fileURLToPath(new URL('../apps/business-site/worker/index.ts',import.meta.url)));
 const env={PUBLIC_READ_LIMIT:{limit:async()=>({success:true})}},ctx={waitUntil(){}};
 async function visit(path,status,body){return handle(new Request(`https://acceptance.invalid/api/business/v1/companies/NBIS/${path}`),env,ctx,async()=>Response.json(body,{status}));}
 const absent=await visit('artifacts/company-analysis',404,{error:'No such resource'});
 assert.equal(absent.status,200);assert.equal((await absent.json()).artifact,null);assert.match(absent.headers.get('cache-control'),/no-store/);evidence.push('missing company artifact: 200/null, not cached');
 const failed=await visit('artifacts/company-analysis',500,{error:'storage failure'});assert.equal(failed.status,503);evidence.push('real upstream failure: 503');
 const limited=await visit('artifacts/company-analysis',429,{error:'rate'});assert.equal(limited.status,429);evidence.push('rate limit remains 429');
 const other=await visit('artifacts/dossier/synthetic',404,{error:'No such resource'});assert.equal(other.status,200);assert.equal((await other.json()).artifact,null);assert.match(other.headers.get('cache-control'),/no-store/);evidence.push('missing dossier artifact: 200/null, not cached');
 const ready=await visit('artifacts/company-analysis',200,{artifact:{ticker:'NBIS',html:'<p>Stored report</p>'}});assert.equal(ready.status,200);assert.equal((await ready.json()).status,'ready');evidence.push('stored company artifact remains ready');
 console.log(JSON.stringify({checks:evidence.length,evidence,networkCalls:0},null,2));
}finally{await server.close();}
