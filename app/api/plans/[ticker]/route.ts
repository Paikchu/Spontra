import { savePlanRequest } from "@/lib/save-plan-request";
import { getD1 } from "@/db";
import { getHoldingPlan } from "@/lib/holding-plan-store";
import { isSameOriginRequest } from "@/lib/request-security";
import { loadSecurity } from "@/lib/site-data";
import { PortfolioUnavailableError } from "@/lib/portfolio-client";

export async function GET(_request: Request, context: { params: Promise<{ ticker: string }> }) {

  const { ticker } = await context.params;
  try {
    const security = await loadSecurity(ticker);
    if (!security) return Response.json({ error: "未找到对应的美股或 ETF。" }, { status: 404 });
    const plan = await getHoldingPlan(await getD1(), security.symbol);
    return Response.json({ plan }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PortfolioUnavailableError) return Response.json({ error: error.message }, { status: 503, headers: { "cache-control": "private, no-store" } });
    return Response.json({ error: "计划暂时无法读取，请稍后重试。" }, { status: 500 });
  }
}

export async function PUT(request: Request, context: { params: Promise<{ ticker: string }> }) {
  if (!isSameOriginRequest(request)) return Response.json({ error: "请求来源无效。" }, { status: 403 });

  return savePlanRequest(request, context);
}
