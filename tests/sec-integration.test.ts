import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("stock details and reports share the current analysis backend", async () => {
  const stock = await source("app/positions/[ticker]/StockDetail.tsx");
  assert.match(stock, /@\/app\/analysis\/stocks\/\[ticker\]\/SecFilingsSection/);
  const report = await source("app/positions/[ticker]/sec/[accession]/page.tsx");
  assert.match(report, /redirect\(`/);
  assert.match(report, /\/analysis\/stocks\//);
  const client = await source("lib/sec-cloudflare-client.ts");
  assert.match(client, /getAnalysisBackendRuntime/);
  assert.doesNotMatch(client, /earning-report-analysis-sec-web/);
});

test("retired SEC writes stay disabled and the investment cron has no analysis engine", async () => {
  for (const path of ["feed", "context", "jobs", "publish", "model-key", "memory/claim", "memory/commit"]) {
    const route = await source(`app/api/internal/sec/${path}/route.ts`);
    assert.match(route, /status: 410/);
    assert.doesNotMatch(route, /getD1|saveAnalysis/);
  }
  const config = JSON.parse(await source("workers/sec-cron/wrangler.jsonc"));
  assert.deepEqual(config.triggers.crons, ["*/5 * * * *", "0 6 * * TUE-SAT", "15 * * * *"]);
  assert.equal(config.workflows, undefined);
  assert.equal(config.r2_buckets, undefined);
  const worker = await source("workers/sec-cron/index.ts");
  assert.doesNotMatch(worker, /WorkflowEntrypoint|runSecRefresh|runSecMemorySweep/);
});
