import { handleDesktopRequest } from "@/lib/desktop-auth";
import { getD1 } from "@/db";
import { readPortfolioSnapshotWithSource } from "@/lib/portfolio-store";
import { portfolioSnapshot } from "@/lib/site-data";
import { readCalendar } from "@/lib/earnings-store";
import { emptyCalendar } from "@/lib/earnings-live";
import { buildPortfolioPresentation } from "@/packages/client/src/portfolio";
import { savePlanRequest } from "@/lib/save-plan-request";
import { GET as stock } from "@/app/api/stocks/[ticker]/route";
import { GET as plans } from "@/app/api/plans/route";
import { GET as plan } from "@/app/api/plans/[ticker]/route";
import { GET as quotes } from "@/app/api/quotes/route";
import { GET as earnings } from "@/app/api/earnings/route";
import { GET as symbols } from "@/app/api/symbols/route";
import { GET as research } from "@/app/api/research/feed/route";
import { GET as search } from "@/app/api/analysis/v1/search/route";
import { GET as filings } from "@/app/api/analysis/v1/companies/[ticker]/filings/route";
import { GET as filing } from "@/app/api/analysis/v1/companies/[ticker]/filings/[accession]/route";
import { GET as analysis } from "@/app/api/analysis/v1/companies/[ticker]/analysis/route";
import { GET as fundamentals } from "@/app/api/analysis/v1/companies/[ticker]/fundamentals/route";
export const dynamic = "force-dynamic";

async function dispatch(request: Request, path: string[]): Promise<Response> {
  const route = path.join("/");
  if (request.method === "PUT") {
    if (path.length === 2 && path[0] === "plans") return savePlanRequest(request, { params: Promise.resolve({ ticker: path[1] }) });
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (route === "connection") return Response.json({ connected: true, version: 1 });
  if (route === "portfolio") {
    const db = await getD1();
    const { snapshot, source } = await readPortfolioSnapshotWithSource(db).catch(() => ({ snapshot: portfolioSnapshot, source: "fallback" as const }));
    const calendar = await readCalendar(db).catch(() => emptyCalendar());
    return Response.json({ source, asOf: snapshot.generatedAt, presentation: buildPortfolioPresentation(snapshot, calendar) });
  }
  if (route === "plans") return plans();
  if (route === "quotes") return quotes(request);
  if (route === "earnings") return earnings();
  if (route === "symbols") return symbols(request);
  if (route === "research/feed") return research(request);
  if (route === "analysis/v1/search") return search(request);
  if (path.length === 2 && path[0] === "stocks") return stock(request, { params: Promise.resolve({ ticker: path[1] }) });
  if (path.length === 2 && path[0] === "plans") return plan(request, { params: Promise.resolve({ ticker: path[1] }) });
  if (path[0] === "analysis" && path[1] === "v1" && path[2] === "companies") {
    const context = { params: Promise.resolve({ ticker: path[3], accession: path[5] }) };
    if (path.length === 5 && path[4] === "filings") return filings(request, context);
    if (path.length === 6 && path[4] === "filings") return filing(request, context);
    if (path.length === 5 && path[4] === "analysis") return analysis(request, context);
    if (path.length === 5 && path[4] === "fundamentals") return fundamentals(request, context);
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { env } = await import("cloudflare:workers");
  const token = (env as { DESKTOP_ACCESS_TOKEN?: string }).DESKTOP_ACCESS_TOKEN;
  return handleDesktopRequest(request, token, async () => dispatch(request, (await context.params).path));
}
export const GET = handle;
export const PUT = handle;
