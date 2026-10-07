import { loadPortfolio, PortfolioUnavailableError } from "@/lib/portfolio-client";
import { buildMobilePortfolio } from "@/lib/mobile-portfolio";

export const dynamic = "force-dynamic";
export async function GET() {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const { snapshot, sync } = await loadPortfolio();
    return Response.json({ ...buildMobilePortfolio(snapshot, "live"), ...sync }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof PortfolioUnavailableError ? error.message : "持仓数据暂时无法读取。" }, { status: 503, headers });
  }
}
