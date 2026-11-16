import type { ResearchDependency } from "../../../../shared/analysis-contract/public-research.ts";
import type { ValuationPublication } from "../../../../shared/analysis-contract/valuation.ts";
import { publicResearchTools, type ResearchContextState } from "../company-research/context-tools.ts";
import { openComposer, registerSource } from "../artifact/document.ts";
import type { AnyTool } from "../tools/registry.ts";
import type { AnalysisEnv } from "../operations.ts";
import { sha256 } from "../sha256.ts";
import type { ValuationState } from "./tools.ts";

function adapter(state:ValuationState):ResearchContextState{
  const context=state.publicContextState??={composer:openComposer({kind:"company-analysis",ticker:state.input.ticker,subject:state.input.ticker,title:"Valuation public context",lang:"en"})};
  for(const evidence of state.evidence.values())if(!evidence.documentId?.startsWith("public-research:"))registerSource(context.composer,evidence.evidenceId,{title:evidence.title,url:evidence.url,kind:evidence.kind==="sec"?"sec":"web"});
  return context;
}
export function valuationPublicResearchTools(env:AnalysisEnv,frozen:ValuationState["publicResearch"]):AnyTool<ValuationState>[] {
  const background=publicResearchTools<ResearchContextState>(frozen,env.BUSINESS_SITE_ORIGIN);
  return background.tools.map(tool=>({...tool,nativeSearch:undefined,
    execute:async(args,ctx)=>{
      const state=adapter(ctx.state),result=await tool.execute(args,{...ctx,state});
      if(tool.name==="read_public_research"&&args.reportId&&args.claimId&&!result.error){
        const item=frozen?.reports.find(r=>r.report.reportId===args.reportId),claim=item?.report.claims.find(c=>c.id===args.claimId);
        if(item&&claim){
          const text=JSON.stringify({reportId:item.report.reportId,version:item.report.version,claim,sources:item.report.sources.filter(s=>claim.sourceIds.includes(s.id)),observations:item.report.observations.filter(o=>claim.observationIds.includes(o.id))});
          const contentSha256=await sha256(text),evidenceId=`e${(await sha256(`public:${item.report.reportId}:${item.report.version}:${claim.id}`)).slice(0,10)}`;
          ctx.state.evidence.set(evidenceId,{evidenceId,kind:"web",title:`${item.report.title}: ${claim.title}`,url:env.BUSINESS_SITE_ORIGIN?`${env.BUSINESS_SITE_ORIGIN}/research/${encodeURIComponent(item.report.reportId)}?version=${item.report.version}#claim-${claim.id}`:null,documentId:`public-research:${item.report.reportId}:${item.report.version}`,passageId:claim.id,form:null,publishedAt:item.report.publishedAt,fetchedAt:ctx.state.now,excerpt:text,contentSha256,path:claim.id});
          (ctx.state.publicEvidence??={})[evidenceId]={reportId:item.report.reportId,version:item.report.version,claimId:claim.id};
          return {...result,observation:`${result.observation}\nValuation citation ID: ${evidenceId}. Record applicability with the original reportId/version/claimId before using this evidence.`};
        }
      }
      return result;
    },observe:(args,value,state)=>tool.observe(args,value,adapter(state)),
  }));
}
export function valuationPublicResearchGate(state:ValuationState):string|null{
  if(!state.publicResearch)return null; // A historical pre-integration checkpoint keeps its original information set.
  const context=adapter(state),background=publicResearchTools(state.publicResearch);
  const issue=background.precheck(context);if(issue)return issue;
  for(const {report} of state.publicResearch.reports)if(!(context.researchUses??[]).some(use=>use.reportId===report.reportId&&use.version===report.version))return `Record an adopted, rejected or not_applicable public claim decision for ${report.reportId}; use company evidence, never industry-average exposure.`;
  const payload=JSON.stringify({dimensions:[...state.dimensions.values()],calculation:state.calc,composition:state.composed});
  for(const [id,dependency] of Object.entries(state.publicEvidence??{}))if(payload.includes(id)&&!(context.researchUses??[]).some(use=>use.reportId===dependency.reportId&&use.version===dependency.version&&use.claimId===dependency.claimId))return `Record applicability before citing public valuation evidence ${id}.`;
  return null;
}
export function valuationPublicDependencies(state:ValuationState):NonNullable<ValuationPublication["researchDependencies"]>{
  return (state.publicContextState?.researchUses??[]).filter(use=>use.decision==="adopted").map(use=>{
    const claim=state.publicResearch?.reports.find(r=>r.report.reportId===use.reportId&&r.report.version===use.version)?.report.claims.find(c=>c.id===use.claimId);
    if(!claim)throw new Error("Adopted valuation claim missing from frozen context");
    return {reportId:use.reportId,version:use.version,claimId:use.claimId,shockId:claim.shockId,financialVariable:use.financialVariable,companyEvidenceIds:use.companySources,reason:use.reason};
  });
}
export type ValuationPublicEvidence = Record<string,ResearchDependency>;
