import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readCompanyNarrative } from "../../shared/analysis-runtime/business-narrative";
import { readOperatingMetrics } from "../../shared/analysis-runtime/operating-metrics";

/**
 * Dev only: a hand-written narrative is served from the pipeline's authored files, through the same
 * reader the Worker uses, so the map can be previewed before the pipeline publishes it. Every
 * other route still goes to the proxied API; a ticker without an authored file falls through.
 */
function authoredNarrative(): Plugin {
  return { name: "authored-narrative", apply: "serve", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const match = /^\/api\/business\/v1\/companies\/([A-Z][A-Z0-9.-]{0,11})\/(narrative|metrics)$/.exec(req.url ?? "");
      if (!match) return next();
      const [, ticker, resource] = match;
      try {
        const folder = resource === "narrative" ? "narrative" : "operating-metrics";
        const raw: unknown = JSON.parse(await readFile(new URL(`../../workers/pipeline/src/${folder}/authored/${ticker}.json`, import.meta.url), "utf8"));
        const body = resource === "narrative" ? readCompanyNarrative(raw, ticker) : readOperatingMetrics(raw, ticker);
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify({ schemaVersion: resource === "narrative" ? "business-narrative-response.v1" : "operating-metrics-response.v1", status: body ? "ready" : "unavailable", [resource]: body }));
      } catch { next(); }
    });
  } };
}

export default defineConfig({root:fileURLToPath(new URL(".",import.meta.url)),plugins:[react(),authoredNarrative()],resolve:{alias:{"@":fileURLToPath(new URL("../../",import.meta.url))}},build:{outDir:"dist",emptyOutDir:true},server:{host:"127.0.0.1",port:4188,proxy:{"/api":process.env.BUSINESS_SITE_API??"http://127.0.0.1:8788"}},css:{postcss:{plugins:[]}}});
