import { getD1 } from "@/db";
import { readPortfolioSnapshot } from "@/lib/portfolio-store";
import { researchBackend } from "@/lib/research-backend";

export async function POST(request: Request) {
  const { env } = await import("cloudflare:workers");
  const key = (env as unknown as { PORTFOLIO_SYNC_KEY?: string }).PORTFOLIO_SYNC_KEY;
  if (!key || request.headers.get("x-portfolio-sync-key") !== key) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const db = await getD1();
  const exists = await db.prepare("SELECT id FROM portfolio_state WHERE id='current'").first();
  // A bundled demo snapshot must never silently become the live monitoring universe.
  if (!exists) return Response.json({ error: "Live portfolio unavailable" }, { status: 503 });
  const snapshot = await readPortfolioSnapshot(db);
  const tickers = [...new Set(snapshot.positions.map(position => position.symbol.toUpperCase()))].filter(ticker => /^[A-Z0-9.^=-]{1,20}$/.test(ticker));
  const response = await researchBackend("/research/universe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tickers, asOf: snapshot.generatedAt }) });
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
