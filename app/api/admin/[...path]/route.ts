import { handleReportAdminProxy } from "@/lib/report-admin-proxy";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
async function handle(request: Request, context: Context) {
  return handleReportAdminProxy(request, (await context.params).path);
}
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
