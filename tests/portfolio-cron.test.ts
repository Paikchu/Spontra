import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import worker from "../workers/sec-cron/index.ts";
import type { IbkrSyncEnv } from "../workers/sec-cron/ibkr-sync.ts";

test("the configured Tuesday–Saturday cron dispatches the IBKR sync", async () => {
  const config = JSON.parse(await readFile(new URL("../workers/sec-cron/wrangler.jsonc", import.meta.url), "utf8"));
  const cron = config.triggers.crons.find((value: string) => value.startsWith("0 6 "));
  // Cloudflare numbers weekdays from Sunday=1; names avoid a one-day shift.
  assert.equal(cron, "0 6 * * TUE-SAT");
  const requests: Request[] = [];
  const tasks: Promise<unknown>[] = [];
  const env = {
    IBKR_FLEX_TOKEN: "123", IBKR_FLEX_QUERY_ID: "1628251", PORTFOLIO_SYNC_KEY: "test-only",
    PORTFOLIO_SERVICE: { async fetch(input: RequestInfo | URL, init?: RequestInit) {
      requests.push(new Request(input, init));
      return new Response(null, { status: 503 });
    } },
  } as IbkrSyncEnv;
  await worker.scheduled({ cron } as ScheduledController, env, { waitUntil(promise) { tasks.push(promise); } } as ExecutionContext);
  assert.equal(tasks.length, 1);
  await assert.rejects(tasks[0], /Portfolio state HTTP 503/);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).pathname, "/api/internal/portfolio/sync");
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].headers.get("x-portfolio-sync-key"), "test-only");
});

test("calendar cron calls the protected portfolio binding once", async () => {
  const requests: Request[] = [];
  const tasks: Promise<unknown>[] = [];
  const env = {
    PORTFOLIO_SYNC_KEY: "test-only", PORTFOLIO_SERVICE: { async fetch(input: RequestInfo | URL, init?: RequestInit) {
      requests.push(new Request(input, init)); return Response.json({ status: "unchanged" });
    } },
  } as IbkrSyncEnv;
  await worker.scheduled({ cron: "15 * * * *" } as ScheduledController, env, { waitUntil(promise) { tasks.push(promise); } } as ExecutionContext);
  await Promise.all(tasks);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).pathname, "/api/internal/earnings/refresh");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.get("x-portfolio-sync-key"), "test-only");
});

test("retired job endpoints never execute work and manual sync requires its key", async () => {
  const env = {} as IbkrSyncEnv;
  assert.equal((await worker.fetch(new Request("https://cron.test/jobs/MSFT", { method: "POST" }), env)).status, 410);
  assert.equal((await worker.fetch(new Request("https://cron.test/internal/portfolio/sync", { method: "POST" }), env)).status, 401);
});
