import { test } from "node:test";
import assert from "node:assert/strict";
import { aiToolEnvironment, modelFor, reasoningFor } from "../src/ai-config.ts";
import { handleAiModelsAdminRequest } from "../src/admin/ai-models.ts";
import { createAdminSession } from "../src/admin/auth.ts";
import type { SecPipelineEnv } from "../src/operations.ts";

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
  const base = { SEC_ANALYSIS_MODEL: "claude-sonnet-5-5", SEC_REASONING_MODEL: "claude-opus-5-5", AI_REASONING: '{"tree":"max"}' };
  const env = await aiToolEnvironment({ ...base, DB: fakeDb([
    { tool: "library-cards", model: "claude-haiku-5-5", effort: null, updated_at: "t" },
    { tool: "tree", model: null, effort: "medium", updated_at: "t" },
    { tool: "gone", model: "claude-haiku-5-5", effort: "low", updated_at: "t" },
    { tool: "findings", model: "gpt-9", effort: "huge", updated_at: "t" },
  ]) });
  assert.equal(modelFor(env, "library-cards"), "claude-haiku-5-5");
  assert.equal(reasoningFor(env, "library-cards"), "low");
  assert.equal(modelFor(env, "tree"), "claude-opus-5-5");
  assert.equal(reasoningFor(env, "tree"), "medium");
  assert.equal(modelFor(env, "findings"), "claude-opus-5-5");
  assert.equal(modelFor(env, "translate"), "claude-sonnet-5-5");
  assert.equal(modelFor({}, "web"), "claude-opus-5-5");
  // Before the migration the table is missing and everything follows the deployment.
  const unmigrated = await aiToolEnvironment({ ...base, DB: fakeDb(null) });
  assert.equal(reasoningFor(unmigrated, "tree"), "max");
});

test("the admin stores, lists and clears a tool's model settings", async () => {
  const rows: Row[] = [];
  const env = { DB: fakeDb(rows), REPORT_ADMIN_PASSWORD: "secret", SEC_ANALYSIS_MODEL: "claude-opus-5-5" } as unknown as SecPipelineEnv;
  const token = await createAdminSession("secret");
  const call = (path: string, body?: unknown) => handleAiModelsAdminRequest(new Request(`https://p.internal${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  const listed = await (await call("/admin/ai/models")).json() as { tools: Array<{ tool: string; model: string | null; defaultModel: string }> };
  assert.ok(listed.tools.some(t => t.tool === "web" && t.defaultModel === "claude-opus-5-5" && t.model === null));
  const saved = await (await call("/admin/ai/models/web", { model: "claude-haiku-5-5", effort: "low" })).json() as typeof listed;
  assert.equal(saved.tools.find(t => t.tool === "web")!.model, "claude-haiku-5-5");
  assert.equal((await call("/admin/ai/models/web", { model: "gpt-9", effort: null })).status, 400);
  assert.equal((await call("/admin/ai/models/nope", { model: null, effort: null })).status, 404);
  await call("/admin/ai/models/web", { model: null, effort: null });
  assert.equal(rows.length, 0);
  assert.equal((await handleAiModelsAdminRequest(new Request("https://p.internal/admin/ai/models"), env)).status, 401);
});
