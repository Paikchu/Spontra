import { proxyAnalysisRead } from "@/lib/earning-report/web/analysis-proxy.ts";

/**
 * Reads the backend's SEC XBRL snapshot. SEC discovery refreshes it independently;
 * loading this page never starts provider requests or database writes.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await context.params;
  const url = new URL(request.url);
  return proxyAnalysisRead(request, (client) => client.getFundamentals(ticker, {
    metrics: url.searchParams.get("metrics"),
    periodCount: url.searchParams.get("periodCount"),
  }));
}
