import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import worker from "../workers/sec-cron/index.ts";
import type { IbkrSyncEnv } from "../workers/sec-cron/ibkr-sync.ts";
import { createPortfolioDatabase } from "./helpers/portfolio-database.ts";
import { runPortfolioJob, type PortfolioJobsEnv } from "../worker/portfolio-jobs.ts";
import { emptyCalendar, type CalendarState } from "../lib/earnings-live.ts";

test("sync worker only owns the existing IBKR schedule and records failed attempts", async () => {
  const config = JSON.parse(await readFile(new URL("../workers/sec-cron/wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(config.triggers.crons, ["0 6 * * TUE-SAT"]);
  assert.equal(config.services, undefined);
  const { database, sqlite } = createPortfolioDatabase();
  try {
    const env = { DB: database } as IbkrSyncEnv;
    const tasks: Promise<unknown>[] = [];
    const context = { waitUntil(promise: Promise<unknown>) { tasks.push(promise); } } as ExecutionContext;
    await worker.scheduled({ cron: config.triggers.crons[0] } as ScheduledController, env, context);
    await assert.rejects(tasks[0], /previous data retained/);
    assert.equal(sqlite.prepare("SELECT status FROM portfolio_sync_attempt").get()?.status, "failed");
    await worker.scheduled({ cron: "15 * * * *" } as ScheduledController, env, context);
    await worker.scheduled({ cron: "*/5 * * * *" } as ScheduledController, env, context);
    assert.equal(tasks.length, 1);
  } finally { sqlite.close(); }
});

test("app research cron obtains holdings via the read API and sends the universe directly to the analysis service", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(config.triggers.crons, ["*/5 * * * *", "15 * * * *"]);
  const calls: string[] = [];
  const env = {
    PORTFOLIO_READ_TOKEN: "read", RESEARCH_SYNC_KEY: "research",
    PORTFOLIO_DATA_SERVICE: { fetch: async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({ portfolio: { positions: [{ symbol: "AAPL" }, { symbol: "AAPL" }, { symbol: "MSFT" }], generatedAt: "2026-10-06T06:00:00Z" } });
    } },
    EARNING_REPORT_PIPELINE: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      assert.deepEqual(JSON.parse(String(init?.body)), { tickers: ["AAPL", "MSFT"], asOf: "2026-10-06T06:00:00Z" });
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer research");
      return Response.json({ status: "ok" });
    } },
  } as PortfolioJobsEnv;
  await runPortfolioJob("*/5 * * * *", env);
  assert.deepEqual(calls.map(url => new URL(url).pathname), ["/api/v1/portfolio", "/research/universe"]);
});

test("app calendar cron reads its own calendar while uninitialized portfolio never replaces research holdings", async () => {
  let queries = 0;
  const env = {
    DB: { prepare(sql: string) { assert.match(sql, /earnings_calendar_state/); queries++; return { first: async () => ({ payload: JSON.stringify({ lastAttemptAt: new Date().toISOString() }) }) }; } },
    PORTFOLIO_READ_TOKEN: "read",
    PORTFOLIO_DATA_SERVICE: { fetch: async () => Response.json({ portfolio: null, syncStatus: "uninitialized" }) },
    EARNING_REPORT_PIPELINE: { fetch: async () => { throw new Error("Should not clear the research universe"); } },
  } as unknown as PortfolioJobsEnv;
  assert.deepEqual(await runPortfolioJob("15 * * * *", env), { status: "recently_checked" });
  assert.equal(queries, 1);
  assert.deepEqual(await runPortfolioJob("*/5 * * * *", env), { status: "uninitialized" });
});

test("hourly calendar refresh filters by API holdings and persists only app calendar data", async (t) => {
  let apiReads = 0;
  let written: CalendarState | undefined;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(new URL(url).hostname, "api.nasdaq.com");
    return Response.json({ data: { rows: [{ symbol: "AAPL", name: "Apple" }, { symbol: "MSFT", name: "Microsoft" }] } });
  });
  const env = {
    DB: { prepare(sql: string) {
      assert.match(sql, /earnings_calendar_state/);
      return {
        first: async () => ({ payload: JSON.stringify(emptyCalendar()) }),
        bind(payload: string) { return { run: async () => { written = JSON.parse(payload); } }; },
      };
    } },
    PORTFOLIO_READ_TOKEN: "read",
    PORTFOLIO_DATA_SERVICE: { fetch: async () => {
      apiReads++;
      return Response.json({ portfolio: { positions: [{ symbol: "AAPL" }] } });
    } },
  } as unknown as PortfolioJobsEnv;
  assert.equal((await runPortfolioJob("15 * * * *", env)).status, "ready");
  assert.equal(apiReads, 1);
  assert.ok(written?.events.length);
  assert.ok(written.events.every(event => event.symbol === "AAPL"));
});

test("retired endpoints never execute work and manual sync requires its own key", async () => {
  const env = {} as IbkrSyncEnv;
  assert.equal((await worker.fetch(new Request("https://cron.test/jobs/MSFT", { method: "POST" }), env)).status, 410);
  assert.equal((await worker.fetch(new Request("https://cron.test/internal/portfolio/sync", { method: "POST" }), env)).status, 401);
});
