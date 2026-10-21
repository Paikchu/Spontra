import { test } from "node:test";
import assert from "node:assert/strict";
import { aiToolEnvironment, modelFor, reasoningFor } from "../src/ai-config.ts";
import { handleAiModelsAdminRequest } from "../src/admin/ai-models.ts";
import { createAdminSession } from "../src/admin/auth.ts";
import type { AnalysisEnv } from "../src/operations.ts";

type Row = { tool: string; model: string | null; effort: string | null; updated_at: string };
function fakeDb(rows: Row[] | null) {
  return { prepare: (sql: string) => ({
    bind(...values: unknown[]) {
      return {
        all: async () => { if (!rows) throw new Error("no such table: ai_tool_settings"); return { results: rows }; },
        run: async () => {
          if (!rows) throw new Error("no such table: ai_tool_settings");
          if (sql.startsWith("DELETE")) rows.splice(rows.findIndex(r => r.tool === values[0]), 1);
          else { const row = { tool: values[0], model: values[1], effort: values[2], updated_at: values[3] } as Row; const i = rows.findIndex(r => r.tool === row.tool); if (i >= 0) rows[i] = row; else rows.push(row); }
          return {};
        },
      };
    },
  }) } as unknown as D1Database;
}

test("a tool runs on the admin's model and effort, else the deployment default for its kind", async () => {
  const base = { SEC_ANALYSIS_MODEL: "deepseek-flash", SEC_REASONING_MODEL: "deepseek-v4-pro", AI_REASONING: '{"tree":"max"}' };
  const env = await aiToolEnvironment({ ...base, DB: fakeDb([
    { tool: "library-cards", model: "deepseek-v4-pro", effort: null, updated_at: "t" },
    { tool: "tree", model: null, effort: "medium", updated_at: "t" },
    { tool: "gone", model: "deepseek-flash", effort: "low", updated_at: "t" },
    { tool: "findings", model: "claude-opus-5-5", effort: "huge", updated_at: "t" },
  ]) });
  assert.equal(modelFor(env, "library-cards"), "deepseek-v4-pro");
  assert.equal(reasoningFor(env, "library-cards"), "low");
  assert.equal(modelFor(env, "tree"), "deepseek-v4-pro");
  assert.equal(reasoningFor(env, "tree"), "medium");
  assert.equal(modelFor(env, "findings"), "deepseek-v4-pro");
  assert.equal(modelFor(env, "translate"), "deepseek-flash");
  assert.equal(modelFor({}, "web"), "deepseek-flash");
  // Before the migration the table is missing and everything follows the deployment.
  const unmigrated = await aiToolEnvironment({ ...base, DB: fakeDb(null) });
  assert.equal(reasoningFor(unmigrated, "tree"), "max");
});

test("the admin stores, lists and clears a tool's model settings", async () => {
  const rows: Row[] = [];
  const env = { DB: fakeDb(rows), REPORT_ADMIN_PASSWORD: "secret", SEC_ANALYSIS_MODEL: "deepseek-v4-pro" } as unknown as AnalysisEnv;
  const token = await createAdminSession("secret");
  const call = (path: string, body?: unknown) => handleAiModelsAdminRequest(new Request(`https://p.internal${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  const listed = await (await call("/admin/ai/models")).json() as { tools: Array<{ tool: string; model: string | null; defaultModel: string }> };
  assert.ok(listed.tools.some(t => t.tool === "web" && t.defaultModel === "deepseek-v4-pro" && t.model === null));
  const saved = await (await call("/admin/ai/models/web", { model: "deepseek-flash", effort: "low" })).json() as typeof listed;
  assert.equal(saved.tools.find(t => t.tool === "web")!.model, "deepseek-flash");
  assert.equal((await call("/admin/ai/models/web", { model: "gpt-9", effort: null })).status, 400);
  assert.equal((await call("/admin/ai/models/nope", { model: null, effort: null })).status, 404);
  await call("/admin/ai/models/web", { model: null, effort: null });
  assert.equal(rows.length, 0);
  assert.equal((await handleAiModelsAdminRequest(new Request("https://p.internal/admin/ai/models"), env)).status, 401);
});
