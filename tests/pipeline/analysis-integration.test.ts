import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import worker from "../../workers/pipeline/src/worker.ts";
import { handleAnalysisReadRequest } from "../../workers/pipeline/src/read-api/router.ts";
import {
  TEST_READ_TOKEN,
  createAnalysisDatabase,
  readEnv,
} from "./helpers/analysis-backend.ts";
import {
  FIXTURE_TICKER,
  seedAnalysisFixtures,
  seedCompanyAnalysisPublication,
  seedFundamentals,
} from "./helpers/analysis-fixtures.ts";
import type { SqliteD1Database } from "./helpers/sqlite-d1.ts";

const execFileAsync = promisify(execFile);

/**
 * Integration, in two senses.
 *
 * First: the Worker's **actual default export** — the object Cloudflare invokes — is exercised for
 * both `fetch` and `scheduled`, so routing, the health/readiness split and the Cron wiring are
 * tested as deployed rather than as imagined by a test double.
 *
 * Second: the read API is served over a real HTTP socket and read by `examples/analysis-backend-
 * consumer.mjs` as a separate OS process, using only the documented API and a read credential. That
 * subprocess shares no code with this repository's `lib/` and holds no database — which is the
 * whole claim the refactor makes about external consumers.
 *
 * What this does *not* prove is Service Binding behaviour inside workerd; see the acceptance report
 * for the `wrangler dev` commands that remain unrun here.
 */
async function seededDatabase(): Promise<SqliteD1Database> {
  const database = await createAnalysisDatabase();
  await seedAnalysisFixtures(database);
  seedCompanyAnalysisPublication(database);
  seedFundamentals(database, { fetchedAt: new Date().toISOString() });
  return database;
}

function pipelineEnv(database: SqliteD1Database, overrides: Record<string, unknown> = {}) {
  return {
    ...readEnv(database),
    SEC_REFRESH_KEY: "admin-secret",
    SEC_TRACKED_TICKERS: FIXTURE_TICKER,
    ...overrides,
  } as never;
}

test("the deployed Worker routes reads, control and probes to the right handler", async () => {
  const database = await seededDatabase();
  const env = pipelineEnv(database);

  const read = await worker.fetch(
    new Request(`https://pipeline.test/api/v1/companies/${FIXTURE_TICKER}/filings`, {
      headers: { authorization: `Bearer ${TEST_READ_TOKEN}` },
    }),
    env,
  );
  assert.equal(read.status, 200);

  // A POST under the read prefix is refused by the read router, never handed to a control handler.
  const posted = await worker.fetch(
    new Request(`https://pipeline.test/api/v1/companies/${FIXTURE_TICKER}/filings`, {
      method: "POST",
      headers: { "x-sec-refresh-key": "admin-secret" },
    }),
    env,
  );
  assert.equal(posted.status, 405);

  // The control plane still works, and still answers on its own paths with its own secret.
  const control = await worker.fetch(
    new Request(`https://pipeline.test/jobs/${FIXTURE_TICKER}`, { method: "POST" }),
    pipelineEnv(database, { SEC_ANALYSIS_WORKFLOW: { async create() { return { id: "wf-1" }; } } }),
  );
  assert.equal(control.status, 401, "an unauthenticated control request is still rejected");

  const authorisedControl = await worker.fetch(
    new Request(`https://pipeline.test/jobs/${FIXTURE_TICKER}`, {
      method: "POST",
      headers: { "x-sec-refresh-key": "admin-secret" },
    }),
    pipelineEnv(database, { SEC_ANALYSIS_WORKFLOW: { async create() { return { id: "wf-1" }; } } }),
  );
  assert.equal(authorisedControl.status, 202);
  database.close();
});

test("health is liveness only; readiness reports dependencies without revealing values", async () => {
  const database = await seededDatabase();
  const health = await worker.fetch(new Request("https://pipeline.test/health"), pipelineEnv(database));
  const healthBody = await health.text();
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(healthBody), { status: "ok" });
  assert.equal(health.headers.get("cache-control"), "no-store");

  const ready = await worker.fetch(new Request("https://pipeline.test/ready"), pipelineEnv(database, { AI_API_KEY: "secret-model-key" }));
  const readyBody = await ready.text();
  assert.equal(ready.status, 200);
  const parsed = JSON.parse(readyBody) as { status: string; checks: Record<string, boolean> };
  assert.equal(parsed.status, "ready");
  // Booleans only — never a secret, a value, or a hostname.
  assert.equal(Object.values(parsed.checks).every((value) => typeof value === "boolean"), true);
  assert.doesNotMatch(readyBody, /secret-model-key|admin-secret|test-read-secret|MSFT/);

  // A deployment that cannot serve reads says so, rather than reporting healthy.
  const degraded = await worker.fetch(
    new Request("https://pipeline.test/ready"),
    { SEC_TRACKED_TICKERS: FIXTURE_TICKER } as never,
  );
  assert.equal(degraded.status, 503);
  assert.equal((await degraded.json() as { status: string }).status, "degraded");
  database.close();
});

/** A17: reads are independent of the model. Readiness agrees, and so does the read path. */
test("readiness does not require a model credential, and reads work without one", async () => {
  const database = await seededDatabase();
  const ready = await worker.fetch(new Request("https://pipeline.test/ready"), pipelineEnv(database));
  const parsed = await ready.json() as { status: string; checks: { modelConfigured: boolean } };
  assert.equal(ready.status, 200);
  assert.equal(parsed.checks.modelConfigured, false);
  assert.equal(parsed.status, "ready");
  database.close();
});

/** A19: the Cron handler still runs every sweep it ran before, plus the fundamentals one. */
test("the scheduled handler still drives every existing sweep, and the new one", async () => {
  const database = await seededDatabase();
  const started: string[] = [];
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value: unknown) => { logs.push(String(value)); };
  try {
    await worker.scheduled({} as ScheduledController, pipelineEnv(database, {
      SEC_ANALYSIS_WORKFLOW: { async create() { started.push("sec"); return { id: "sec-1" }; } },
      SEC_MEMORY_WORKFLOW: { async create() { started.push("memory"); return { id: "memory-1" }; } },
      COMPANY_ANALYSIS_WORKFLOW: { async create() { started.push("company"); return { id: "company-1" }; } },
    }));
  } finally {
    console.log = originalLog;
  }
  assert.ok(started.includes("sec"), "the SEC refresh sweep must still run on the schedule");
  const payload = JSON.parse(logs.at(-1)!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload), ["event", "analysis", "memory", "companyAnalysis", "fundamentals"]);
  database.close();
});

/**
 * A03. The example consumer runs as a separate process against a real socket. It never imports this
 * repository's code, so a green run here is evidence about the HTTP contract, not about shared types.
 */
test("an independent HTTP consumer reads a report with only the API and a read credential", async () => {
  const database = await seededDatabase();
  const env = readEnv(database);
  const server = createServer((incoming, outgoing) => {
    const request = new Request(`http://127.0.0.1${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers as Record<string, string>,
    });
    handleAnalysisReadRequest(request, env).then(async (response) => {
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    }).catch(() => { outgoing.writeHead(500); outgoing.end("{}"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [fileURLToPath(new URL("../../examples/analysis-backend-consumer.mjs", import.meta.url)), FIXTURE_TICKER],
      {
        env: {
          ...process.env,
          ANALYSIS_API_URL: `http://127.0.0.1:${port}`,
          ANALYSIS_READ_TOKEN: TEST_READ_TOKEN,
        },
      },
    );
    const report = JSON.parse(stdout) as {
      apiVersion: string;
      filings: { count: number; total: number };
      latestFiling: {
        publishedResult: string;
        latestRun: string;
        contentRevision: string;
        keyMetrics: Array<{ metricKey: string; evidenceIds: string[] }>;
        quality: { verificationStatus: string };
        provenance: string;
        reportingPeriod: { reportDate: string; periodId: string };
      };
      companyAnalysis: { publishedResult: string; headline: string; highlights: Array<{ evidenceRefs: string[] }> };
      fundamentals: { available: boolean; source: string };
    };

    assert.equal(report.apiVersion, "analysis-api.v1");
    assert.equal(report.filings.total, 5);
    assert.equal(report.latestFiling.publishedResult, "complete");
    assert.equal(report.latestFiling.latestRun, "succeeded");
    assert.equal(report.latestFiling.contentRevision, "aaaa1111");
    assert.equal(report.latestFiling.provenance, "sec_edgar");
    assert.equal(report.latestFiling.reportingPeriod.periodId, `${FIXTURE_TICKER}:2026-06-30:annual`);
    // Facts and their evidence, without parsing prose.
    assert.deepEqual(report.latestFiling.keyMetrics, [{ metricKey: "revenue", value: "1,000", status: "verified", evidenceIds: ["ev-1"] }] as never);
    assert.equal(report.latestFiling.quality.verificationStatus, "verified");
    assert.equal(report.companyAnalysis.publishedResult, "ready");
    assert.deepEqual(report.companyAnalysis.highlights[0]?.evidenceRefs, ["evidence-1"]);
    assert.equal(report.fundamentals.available, true);
    assert.equal(report.fundamentals.source, "sec_xbrl");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  }
});

test("the same consumer is refused, over the same socket, without a valid credential", async () => {
  const database = await seededDatabase();
  const env = readEnv(database);
  const server = createServer((incoming, outgoing) => {
    handleAnalysisReadRequest(
      new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers: incoming.headers as Record<string, string> }),
      env,
    ).then(async (response) => {
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [fileURLToPath(new URL("../../examples/analysis-backend-consumer.mjs", import.meta.url)), FIXTURE_TICKER],
        { env: { ...process.env, ANALYSIS_API_URL: `http://127.0.0.1:${port}`, ANALYSIS_READ_TOKEN: "test-consumer.wrong-secret-0123456789" } },
      ),
      (error: unknown) => {
        assert.match(String((error as { stderr?: string }).stderr ?? ""), /Credential rejected \(401\)/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  }
});
