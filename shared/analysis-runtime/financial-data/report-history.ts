import type { PublicBusinessFlow } from '../../analysis-contract/business-flow.ts';
import { publicFlowSchema } from './schema.ts';
import { checkCompleteQuarter } from './completeness.ts';

/** Eight reported quarters, bounded to two years from the newest report, never fabricated missing periods. */
export function readReportHistory(raw: unknown, ticker: string): PublicBusinessFlow | null {
 const parsed=publicFlowSchema.safeParse(raw);
 if(!parsed.success || parsed.data.ticker!==ticker)return null;
 const candidates=parsed.data.quarters.filter(q=>checkCompleteQuarter(q).complete).sort((a,b)=>b.periodEnd.localeCompare(a.periodEnd));
 const newest=candidates[0];if(!newest)return null;
 const cutoff=new Date(newest.periodEnd);cutoff.setUTCFullYear(cutoff.getUTCFullYear()-2);
 const seen=new Set<string>();
 const quarters=candidates.filter(q=>{if(Date.parse(q.periodEnd)<=cutoff.getTime()||seen.has(q.periodEnd))return false;seen.add(q.periodEnd);return true;}).slice(0,8);
 return {...parsed.data,quarters};
}
