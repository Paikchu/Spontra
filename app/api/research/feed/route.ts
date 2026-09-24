import { researchBackend } from "@/lib/research-backend";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const cursor = new URL(request.url).searchParams.get("cursor");
  if (cursor && !/^\d{1,15}$/.test(cursor)) return Response.json({ error: "Invalid cursor" }, { status: 400 });
  try {
    const result = await researchBackend(`/research/feed${cursor ? `?cursor=${cursor}` : ""}`);
    if (!result.ok) return Response.json({ error: "研究服务暂不可用" }, { status: 503, headers: { "cache-control": "no-store" } });
    return new Response(result.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch { return Response.json({ error: "研究服务暂不可用" }, { status: 503, headers: { "cache-control": "no-store" } }); }
}
