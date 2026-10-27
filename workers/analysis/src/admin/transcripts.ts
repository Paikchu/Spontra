import type { AnalysisEnv } from '../operations.ts';
import { authenticateAdmin } from './auth.ts';
import { listTranscripts, transcriptDetail } from '../transcripts/library.ts';
import {json} from './http.ts';
export async function handleTranscriptAdminRequest(request:Request,env:AnalysisEnv):Promise<Response> {
  if(!await authenticateAdmin(request,env.REPORT_ADMIN_PASSWORD))return json({error:'请登录财报管理后台。'},401);
  if(request.method!=='GET')return json({error:'Method not allowed'},405);
  if(!env.DB)return json({error:'数据服务暂时不可用。'},503);
  const url=new URL(request.url);
  if(url.pathname==='/admin/transcripts')return json(await listTranscripts(env,url));
  const id=decodeURIComponent(url.pathname.slice('/admin/transcripts/'.length));
  const detail=await transcriptDetail(env,id);
  return detail?json(detail):json({error:'未找到该 Transcript。'},404);
}
