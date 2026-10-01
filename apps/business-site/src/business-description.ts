import type { PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { CompanyBusinessContent } from "@/lib/earning-report/web/company-business-content";
/** Public qualitative context has its own disclosure period; financial amounts remain unchanged. */
export function withBusinessDescriptions(flow:PublicBusinessFlow,business:CompanyBusinessContent|null):PublicBusinessFlow{
 if(!business)return flow;
 return {...flow,quarters:flow.quarters.map(quarter=>({...quarter,sources:[...quarter.sources,...business.sources.filter(source=>!quarter.sources.some(existing=>existing.id===source.id))],segments:quarter.segments.map(segment=>{
  const description=business.groups.find(group=>group.id===segment.id);if(!description)return segment;
  return {...segment,description:description.description+"\n"+business.basisLabel,products:[...new Set([...segment.products,...description.products])],customers:description.customers??segment.customers,monetization:description.monetization??segment.monetization,disclosure:segment.disclosure+" 定性业务解释独立于季度金额，不推定产品收入或成本分配。",sourceIds:[...new Set([...segment.sourceIds,...description.sourceIds])]};
 })}))};
}
