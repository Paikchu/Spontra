import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnalysisEnv } from "../src/operations.ts";
import { SEC_ANALYSIS_SCHEMA_VERSION } from "../src/sec/analysis.ts";
import { sweepStorage } from "../src/storage/sweep.ts";

const now = Date.parse("2026-11-02T00:00:00Z");
const artifacts = (ticker: string) => [
  `filings/${ticker}/prepared.json`,
  `analysis/${ticker}/accession/${SEC_ANALYSIS_SCHEMA_VERSION}/brief.json`,
];

function fixture(protection: "policy" | "task", failedTable?: string) {
  const failure = new Error(`D1 unavailable: ${failedTable}`);
  const deleted: string[] = [];
  const listed: string[] = [];
  const queries: string[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind() { return statement; },
        async first() { return null; },
        async run() { return { meta: { changes: 0 } }; },
        async all() {
          queries.push(sql);
          if (failedTable && sql.includes(failedTable)) throw failure;
          if (sql.includes("business_feature_settings")) return { results: [{ ticker: "ORCL", feature: "reports", generate: 1 }, ...protection === "policy"
            ? [{ ticker: "ADHOC", feature: "reports", generate: 1 }] : []] };
          if (sql.includes("financial_maintenance_tasks")) return { results: protection === "task"
            ? [{ ticker: "ADHOC" }] : [] };
          if (sql.includes("financial_company_settings") || sql.includes("ai_tool_settings") || sql.includes("web_search_cache")) return { results: [] };
          throw new Error(`Unexpected query: ${sql}`);
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  const bucket = {
    async list({ prefix }: { prefix: string }) {
      listed.push(prefix);
      return { objects: ["ORCL", "ADHOC", "UNUSED"].flatMap(artifacts)
        .filter(key => key.startsWith(prefix))
        .map(key => ({ key, uploaded: new Date(now), size: 1 })), truncated: false };
    },
    async delete(keys: string[]) { deleted.push(...keys); },
  } as unknown as R2Bucket;
  const env = { DB: db, SEC_FILINGS: bucket, SEC_AI_ENABLED: "true" } as AnalysisEnv;
  return { env, failure, deleted, listed, queries };
}

for (const [protection, table] of [
  ["policy", "financial_company_settings"],
  ["policy", "business_feature_settings"],
  ["task", "financial_maintenance_tasks"],
] as const) {
  test(`AC-2: ${table} failure aborts the sweep before deleting protected artifacts`, async () => {
    const f = fixture(protection, table);
    const outcome = await sweepStorage(f.env, now).then(() => null, error => error);
    assert.ok(f.queries.some(sql => sql.includes(table)), "the failing protection read must be reached");
    assert.deepEqual(f.deleted, [], "failed protection reads must not permit R2 deletion");
    assert.equal(outcome, f.failure, "the original failure must propagate so the task can retry");
    assert.deepEqual(f.listed, [], "resolve protection inputs before scanning R2");
  });
}

for (const protection of ["policy", "task"] as const) {
  test(`AC-2: successful ${protection} reads protect an off-list company and allow ordinary cleanup`, async () => {
    const f = fixture(protection);
    const result = await sweepStorage(f.env, now);
    assert.equal(result.done, true);
    assert.deepEqual(f.deleted, artifacts("UNUSED"));
    assert.deepEqual(result.deleted, { "filings/": 1, "analysis/": 1 });
  });
}
