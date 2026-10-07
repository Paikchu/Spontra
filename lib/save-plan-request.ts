import { getD1 } from "@/db";
import { validateHoldingPlanInput } from "@/lib/holding-plan";
import { saveHoldingPlan } from "@/lib/holding-plan-store";
import { loadSecurity } from "@/lib/site-data";
import { PortfolioUnavailableError } from "@/lib/portfolio-client";

export async function savePlanRequest(request: Request, context: { params: Promise<{ ticker: string }> }) {
  const { ticker: rawTicker } = await context.params;
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON。" }, { status: 400 });
  }
  const validation = validateHoldingPlanInput(rawTicker, payload);
  if (!validation.ok) return Response.json({ error: validation.error }, { status: 400 });
  try {
    const security = await loadSecurity(validation.value.ticker);
    if (!security) return Response.json({ error: "未找到对应的美股或 ETF。" }, { status: 404 });
    const plan = await saveHoldingPlan(await getD1(), security.name, validation.value);
    return Response.json({ plan }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PortfolioUnavailableError) return Response.json({ error: error.message }, { status: 503, headers: { "cache-control": "private, no-store" } });
    return Response.json({ error: "计划暂时无法保存，请稍后重试。" }, { status: 500 });
  }
}
