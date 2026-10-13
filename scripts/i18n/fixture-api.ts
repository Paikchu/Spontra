/**
 * Serves the fixture company as the read API in the business site's dev server, so the pages can be opened in
 * either language with no network: BUSINESS_SITE_FIXTURES=1 npm run dev, then /companies/ACME?lang=zh-CN.
 */
import type { Plugin } from "vite";
import { capital, company, events, filings, findings, TICKER } from "./fixture.ts";

const RESOURCES: Record<string, unknown> = {
  "": company,
  "/capital": { status: "ready", capital },
  "/findings": { status: "ready", findings },
  "/events": { status: "ready", events },
  "/filings": { status: "ready", filings },
  "/fundamentals": { status: "unavailable" },
};

export function fixtureApi(): Plugin {
  return {
    name: "business-site-fixture-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = req.url?.match(/^\/api\/business\/v1\/companies\/([^/?]+)(\/[a-z]+)?(?:\?|$)/);
        if (!match) return next();
        const body = match[1] === TICKER ? RESOURCES[match[2] ?? ""] : undefined;
        res.statusCode = body ? 200 : 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body ?? { error: "not in fixture" }));
      });
    },
  };
}
