import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("actual Workers runtime executes market and search requests without unsupported redirect modes", async t => {
  const compiled = await build({ stdin: { contents: `
    import {readProviderJson} from './workers/pipeline/src/research/market.ts';
    import {TavilyProvider} from './workers/pipeline/src/web-search/tavily.ts';
    export default {async fetch(){
      const market=await readProviderJson('https://quote.example.com/data',fetch);
      const search=await new TavilyProvider('fixture-only').search({query:'Oracle business'});
      return Response.json({market,search});
    }};`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser" });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: "2026-08-26", script: compiled.outputFiles[0].text,
    outboundService: async request => new Response(JSON.stringify(new URL(request.url).hostname === "api.tavily.com"
      ? { results: [{ title: "Disclosure", url: "https://example.com/ir", content: "Evidence", score: 1 }] }
      : { value: 42 }), { headers: { "content-type": "application/json" } }),
  }));
  t.after(() => mf.dispose());
  const response = await mf.dispatchFetch("https://test.local/");
  assert.equal(response.status, 200);
  const body = await response.json() as { market: { value: number }; search: { results: unknown[] } };
  assert.equal(body.market.value, 42);
  assert.equal(body.search.results.length, 1);
});
