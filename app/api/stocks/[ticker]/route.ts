import { loadStock } from "@/lib/stock-context";
export async function GET(_request: Request, context: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await context.params;
  try { return Response.json(await loadStock(ticker), { headers: { "cache-control": "private, no-store" } }); }
  catch { return Response.json({ error: "未找到对应的美股或 ETF。" }, { status: 404 }); }
}
