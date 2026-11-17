import { parseHtml, type HtmlNode } from "../../../../shared/analysis-runtime/artifact/html.ts";
import { runTool, type ToolOutcome } from "../tools/registry.ts";
import { filingOperatorHarness, type FilingSpec, type FilingState } from "./recipe.ts";
import { filingOperatorPlanSchema, stableOperatorValue } from "./operator-plan.ts";
import type { AnalysisEnv } from "../operations.ts";
import { sha256 } from "../sha256.ts";
import { packState } from "../pi/state.ts";
import type { z } from "zod";

export type FilingOperatorPlan=z.infer<typeof filingOperatorPlanSchema>;
type ShadowHook=Parameters<typeof filingOperatorHarness>[3];
export type OperatorToolRecord={sequence:number;name:string;input:unknown;outcome:ToolOutcome;beforeHash:string;afterHash:string};

/** Fixed original sources, real tools and derived state only. No author model is opened here. */
export async function executeFilingOperatorPlan(env:AnalysisEnv,spec:FilingSpec,state:FilingState,plan:FilingOperatorPlan,onShadow:ShadowHook,record:(entry:OperatorToolRecord)=>Promise<void>){
  const harness=await filingOperatorHarness(env,spec,state,onShadow),tools=harness.recipe.tools(state),policy=harness.recipe.policy;
  const allowed=new Set(["read_filing_markdown","find_filing_tables","read_filing_table","query_facts","read_public_research","record_public_research_use","compute","revise_evidence","close_lead","record_investment_impact","chart_facts","write_blocks"]);
  const pinned=new Set([spec.material.accession,...(state.periodic?.materials??[]).map(ref=>ref.accession)]);
  let sequence=0;
  const call=async(name:string,input:Record<string,unknown>)=>{
    if(!allowed.has(name))throw new Error(`Operator tool is not allowed: ${name}`);
    if(typeof input.accession==="string"&&!pinned.has(input.accession))throw new Error("Operator reads cannot add an unfrozen filing");
    const beforeHash=await sha256(packState(state));
    const outcome=await runTool(tools,{...policy,allow:[...allowed]}, {name,input},{state,signal:AbortSignal.timeout(10*60_000),recipe:harness.recipe.id,stage:(_name,work)=>work()});
    await record({sequence:++sequence,name,input,outcome,beforeHash,afterHash:await sha256(packState(state))});
    if(outcome.error||outcome.asked)throw new Error(`Operator tool ${name} rejected: ${outcome.observation}`);
    return outcome;
  };
  if(!state.periodic)throw new Error("Periodic checkpoint required");
  const existingResults=new Set(Object.keys(state.periodic.computed));
  for(const [old,next]of Object.entries(plan.oldToNew))if(!existingResults.has(old)||!plan.computeCalls.some(call=>call.expectedResultId===next))throw new Error("oldToNew must name original results and actual new compute calls");
  const initialChainIds=new Set((state.periodic.investmentChains??[]).map(chain=>chain.id));
  if(initialChainIds.size!==plan.investmentChains.length||new Set(plan.investmentChains.map(chain=>chain.id)).size!==initialChainIds.size||plan.investmentChains.some(chain=>!initialChainIds.has(chain.id)))throw new Error("The plan must rerecord each existing investment chain exactly once");
  for(const read of plan.pinnedReads)await call(read.tool,read.args);
  if(plan.researchUses.length)await call("read_public_research",{});
  for(const use of plan.researchUses){await call("read_public_research",{reportId:use.reportId,claimId:use.claimId});await call("record_public_research_use",use);}
  for(const compute of plan.computeCalls){
    const expectedId=`c${Object.keys(state.periodic.computed).length+1}`;
    if(expectedId!==compute.expectedResultId||existingResults.has(expectedId))throw new Error("Ordered compute expectedResultId does not match the next appended result");
    await call("compute",compute.args);
    const result=state.periodic.computed[expectedId];
    if(!result||!result.provenance||result.formula!==compute.args.formula)throw new Error("The real compute tool did not record the expected typed result");
    if(compute.expected&&(result.unit!==compute.expected.unit||Math.abs(result.value-compute.expected.value)>Math.max(1,Math.abs(compute.expected.value))*compute.expected.tolerance))throw new Error(`Actual compute result ${expectedId} disagrees with its expected assertion`);
  }
  for(const correction of plan.evidenceCorrections){
    await call("revise_evidence",correction);
    const actual=state.periodic.evidence.find(note=>note.id===correction.id);
    if(!actual||actual.statement!==correction.statement||actual.quote!==correction.quote||actual.section!==correction.section||stableOperatorValue(actual.facts)!==stableOperatorValue(correction.facts))throw new Error("Evidence correction did not actually land");
  }
  for(const lead of plan.closeLeads.leads)if(!state.periodic.leads.some(item=>item.id===lead.id))throw new Error("Only an existing lead may be corrected");
  if(plan.closeLeads.leads.length)await call("close_lead",plan.closeLeads);
  for(const lead of plan.closeLeads.leads){const actual=state.periodic.leads.find(item=>item.id===lead.id);if(!actual||actual.verdict!==lead.verdict||actual.finding!==lead.finding||stableOperatorValue(actual.evidence??[])!==stableOperatorValue(lead.evidence))throw new Error("Lead correction did not actually land");}
  for(const chain of plan.investmentChains)await call("record_investment_impact",chain);
  for(const chart of plan.charts)await call("chart_facts",chart);
  // One block per call: write_blocks' normal batch interface may report partial success.
  for(const block of plan.blocks){
    await call("write_blocks",{blocks:[{id:block.id,html:block.html}]});
    const actual=state.composer.blocks.find(item=>item.id===block.id);
    if(!actual||block.title!==undefined&&actual.title!==block.title||block.sources!==undefined&&stableOperatorValue([...actual.sources].sort())!==stableOperatorValue([...block.sources].sort()))throw new Error(`Block ${block.id} did not match its title/source assertions`);
  }
  const refs=new Set<string>(),charts=new Set<string>();
  const walk=(nodes:HtmlNode[])=>{for(const node of nodes)if(node.type==="element"){for(const[key,value]of node.attrs){if(key==="data-ref"||key==="data-source")refs.add(value);if(key==="data-chart")charts.add(value);}walk(node.children);}};
  for(const block of state.composer.blocks){for(const source of block.sources)refs.add(source);walk(parseHtml(block.html).nodes);}
  for(const chart of charts)for(const ref of state.periodic.chartRefs?.[chart]??[])refs.add(ref);
  for(const chain of state.periodic.investmentChains??[])for(const ref of [...chain.sourceIds,...chain.computationRefs])refs.add(ref);
  const visit=(id:string)=>{for(const input of Object.keys(state.periodic!.computed[id]?.inputs??{}))if(!refs.has(input)){refs.add(input);visit(input);}for(const input of state.periodic!.impactComputations?.[id]?.provenance?.inputs??[])if(!refs.has(input.sourceId)){refs.add(input.sourceId);visit(input.sourceId);}};
  for(const ref of [...refs])visit(ref);
  if(Object.keys(plan.oldToNew).some(old=>refs.has(old)))throw new Error("A retired computation is still reachable from the report, charts or investment chains");
  return {state,toolCalls:sequence};
}
