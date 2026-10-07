import { matchesPortfolioReadToken } from "./auth.ts";
import { readPortfolioResponse } from "./portfolio-store.ts";
import type { IbkrSyncEnv } from "./ibkr-sync.ts";

export async function handlePortfolioRead(request: Request, env: IbkrSyncEnv, now = new Date()): Promise<Response> {
  const headers = { "cache-control": "private, no-store" };
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || !matchesPortfolioReadToken(authorization.slice(7), env)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405, headers: { ...headers, allow: "GET" } });
  try {
    return Response.json(await readPortfolioResponse(env.DB, now), { headers });
  } catch {
    return Response.json({ error: "Portfolio storage unavailable" }, { status: 503, headers });
  }
}
