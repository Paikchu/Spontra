/** Runs the installed Pi provider and durable Harness against localhost only. No model credential or paid request. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, MemoryStorage, createRegistry, hook, GenerationTask, CompactionTask, ProviderDoc } from '@earendil-works/pi-durable';
import { installProviderRequestGate } from '../workers/analysis/src/pi/request-budget.ts';

const db = new DatabaseSync(':memory:');
db.exec("CREATE TABLE allowance (id TEXT PRIMARY KEY, state TEXT, calls_reserved INTEGER, max_calls INTEGER)");
let calls = 0, failing = false;
const server = createServer((request, response) => {
  calls++;
  request.resume();
  if (failing) { response.writeHead(500, {'content-type':'application/json','retry-after-ms':'1'}); response.end(JSON.stringify({error:{message:'synthetic failure'}})); return; }
  response.writeHead(200, {'content-type':'text/event-stream'});
  const chunk = {id:'synthetic',object:'chat.completion.chunk',created:1,model:'synthetic',choices:[{index:0,delta:{role:'assistant',content:'Synthetic answer.'},finish_reason:null}]};
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.write(`data: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}})}\n\n`);
  response.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const model = {id:'synthetic',name:'synthetic',api:'openai-completions',provider:'synthetic',baseUrl,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:100};
const reserve = () => { if (!db.prepare("UPDATE allowance SET calls_reserved=calls_reserved+1 WHERE id='run' AND state='running' AND calls_reserved<max_calls RETURNING calls_reserved").get()) throw new Error('allowance exhausted or stopped'); };
const reset = (max, state='running') => { calls=0; failing=false; db.prepare("INSERT OR REPLACE INTO allowance VALUES ('run',?,0,?)").run(state,max); };
function modelsFor(resolve = async () => reserve) {
  const models = createModels();
  models.setProvider(createProvider({id:'synthetic',name:'synthetic',baseUrl,auth:{apiKey:{name:'Synthetic key',resolve:async()=>({auth:{apiKey:'local-only'}})}},models:[model],api:openAICompletionsApi()}));
  installProviderRequestGate(models, resolve);
  return models;
}
const context = {messages:[{role:'user',content:'Synthetic request',timestamp:1}]};
const results=[];
try {
  reset(0);
  await modelsFor().completeSimple(model,context,{sessionId:'zero'});
  assert.equal(calls,0);results.push({case:'zero allowance',actualProviderRequests:calls});

  reset(1);failing=true;
  const retryResult=await modelsFor().completeSimple(model,context,{sessionId:'retry',maxRetries:2,maxRetryDelayMs:10});
  assert.equal(calls,1);assert.equal(retryResult.stopReason,'error');results.push({case:'transport retry after cap',actualProviderRequests:calls});

  reset(1);
  await Promise.all(Array.from({length:10},(_,i)=>modelsFor().completeSimple(model,context,{sessionId:`concurrent-${i}`})));
  assert.equal(calls,1);results.push({case:'10 concurrent sessions share one atomic reservation',actualProviderRequests:calls});

  reset(10,'stopped');await modelsFor().completeSimple(model,context,{sessionId:'stopped'});
  assert.equal(calls,0);results.push({case:'stopped run',actualProviderRequests:calls});

  reset(1);await modelsFor().completeSimple(model,context,{sessionId:'before-restart'});await modelsFor().completeSimple(model,context,{sessionId:'after-restart'});
  assert.equal(calls,1);results.push({case:'new registry preserves persisted allowance',actualProviderRequests:calls});

  reset(0);await modelsFor(async()=>null).completeSimple(model,context,{sessionId:'legacy'});
  assert.equal(calls,1);results.push({case:'non-opted-in legacy request unchanged',actualProviderRequests:calls});

  reset(1);
  const identities=new Set();let advisoryErrors=0,compactions=0;
  const registry=createRegistry();
  const remember=async(api,ctx)=>{const saved=await api.snapshot(ProviderDoc,api.conversationId,ctx);assert.ok(saved?.sessionId);identities.add(saved.sessionId);};
  registry.install({name:'budget-journey',hooks:[hook(GenerationTask,{beforeRequest:async(_request,api,ctx)=>{await remember(api,ctx);throw new Error('Synthetic advisory-hook rejection');}}),hook(CompactionTask,{beforeCompact:async(_request,api,ctx)=>{compactions++;await remember(api,ctx);}})]});
  const models=modelsFor(async identity=>{assert.ok(identities.has(identity),'Persisted provider identity reaches transport');return reserve;});
  const harness=await Harness.open(new MemoryStorage(),{models,registry,onReport:r=>{if(r.kind==='extension_error')advisoryErrors++;},settings:{retry:{enabled:false},compaction:{enabled:false,keepRecentTokens:0,reserveTokens:100}}},BACKGROUND_CONTEXT);
  try {
    const root=await harness.root(BACKGROUND_CONTEXT,{agent:{model:{provider:'synthetic',modelId:'synthetic'}}});
    await (await root.submit({type:'input',content:'First synthetic request'},BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    assert.equal(calls,1);
    const denied=await (await root.submit({type:'input',content:'Second request must be denied'},BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    assert.equal(calls,1);assert.equal(denied.status,'unanswered');assert.ok(advisoryErrors>=2);
    results.push({case:'actual Harness swallows advisory errors but transport blocks post-cap request',actualProviderRequests:calls,advisoryErrors});
    const task=await root.compact('Synthetic compaction must share the same exhausted cap.',BACKGROUND_CONTEXT);
    await harness.waitForTask(task,BACKGROUND_CONTEXT);
    assert.ok(compactions>0);assert.equal(calls,1);
    results.push({case:'actual automatic-summary provider path shares same gate',actualProviderRequests:calls,compactions});
  } finally {await harness.close(BACKGROUND_CONTEXT);}
  console.log(JSON.stringify({status:'passed',results,paidCalls:0,tokenBudget:'reported-usage soft threshold; not a hard charge cap'},null,2));
} finally {await new Promise(resolve=>server.close(resolve));db.close();}
