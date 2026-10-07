import { getCloudflareSecFeed } from "@/lib/sec-cloudflare-client";
import { loadSecurity } from "@/lib/site-data";
import { PortfolioUnavailableError } from "@/lib/portfolio-client";

export async function GET(_request: Request, context: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await context.params;
  try {
    const security = await loadSecurity(ticker);
    if (!security) return Response.json({ error: "未找到对应的美股或 ETF。" }, { status: 404 });
    if (security.type === "etf") return Response.json({ ticker: security.symbol, company: null, filings: [], fetchedAt: null, status: "not_applicable" });
    return Response.json(await getCloudflareSecFeed(security.symbol), { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PortfolioUnavailableError) return Response.json({ error: error.message }, { status: 503, headers: { "cache-control": "private, no-store" } });
    return Response.json({ error: "SEC 数据读取失败。" }, { status: 502 });
  }
}
