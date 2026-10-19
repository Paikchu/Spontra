/**
 * Serves the fixture company as the read API in the business site's dev server, so the pages can be opened in
 * either language with no network: BUSINESS_SITE_FIXTURES=1 npm run dev, then /companies/ACME?lang=zh-CN.
 * `POST /__fixture/publish` stands in for the pipeline publishing: every revision moves, and the findings and events
 * each gain a row, so an open page's update notice and entrance can be seen.
 */
import type { Plugin } from "vite";
import { capital, company, events, filings, findings, TICKER } from "./fixture.ts";

let published = 0;
const revision = () => new Date(Date.UTC(2026, 7, 10) + published * 3_600_000).toISOString();

function resources(): Record<string, unknown> {
  const extra = findings.findings.find(f => f.id === "margin")!;
  const later = Array.from({ length: published }, (_, i) => ({
    finding: { ...extra, id: `margin-${i + 1}`, severity: 3, title: `Gross margin dips, round ${String.fromCharCode(65 + i)}` },
    event: { ...events.events.find(e => e.id === "e-exec")!, id: `e-exec-${i + 1}`, filedAt: `2026-08-${String(11 + i).padStart(2, "0")}`, eventDate: `2026-08-${String(11 + i).padStart(2, "0")}` },
  }));
  const rev = revision();
  return {
    "": company,
    "/revision": { schemaVersion: "revisions.v1", ticker: TICKER, revisions: { company: rev, capital: rev, findings: rev, fundamentals: rev, events: rev, filings: rev } },
    "/capital": { status: "ready", capital },
    "/findings": { status: "ready", findings: { ...findings, findings: [...later.map(l => l.finding).reverse(), ...findings.findings] }, passages: [
      { passageId: "pfixturenote01", documentId: "d1", title: `${TICKER} 10-Q`, form: "10-Q", filedAt: "2026-08-05", url: "https://www.sec.gov/", path: ["MD&A", "Cash flows"], text: "Depreciation and amortization increased as new capacity was placed in service.", table: null },
      { passageId: "pfixturenote02", documentId: "d0", title: `${TICKER} 10-K`, form: "10-K", filedAt: "2026-02-20", url: "https://www.sec.gov/", path: ["MD&A", "Liquidity"], text: "We expect depreciation to rise as we place additional capacity in service.", table: null },
    ] },
    "/events": { status: "ready", events: { ...events, events: [...later.map(l => l.event).reverse(), ...events.events] } },
    "/filings": { status: "ready", filings },
    "/fundamentals": { status: "unavailable" },
  };
}

export function fixtureApi(): Plugin {
  return {
    name: "business-site-fixture-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/__fixture/publish" && req.method === "POST") {
          published++;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ published, revision: revision() }));
          return;
        }
        const match = req.url?.match(/^\/api\/business\/v1\/companies\/([^/?]+)(\/[a-z]+)?(?:\?|$)/);
        if (!match) return next();
        const body = match[1] === TICKER ? resources()[match[2] ?? ""] : undefined;
        res.statusCode = body ? 200 : 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body ?? { error: "not in fixture" }));
      });
    },
  };
}
