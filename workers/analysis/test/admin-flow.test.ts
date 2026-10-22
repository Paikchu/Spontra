import { test } from "node:test";
import assert from "node:assert/strict";
import { flowGraph, readFlow } from "../src/admin/flow.ts";

test("the flow graph is the registry's events between the drawn tasks, in columns by the longest chain before each", () => {
  const { nodes, edges } = flowGraph();
  const depth = (id: string) => nodes.find(n => n.id === id)!.depth;
  assert.equal(depth("sec-discovery"), 0);
  assert.ok(depth("collect") < depth("map-derive") && depth("map-derive") < depth("findings") && depth("findings") < depth("analyst"));
  assert.deepEqual(edges.find(e => e.from === "collect" && e.to === "map-derive")?.events, ["financials.published", "filing.archived"]);
  assert.ok(edges.some(e => e.from === "findings" && e.to === "analyst" && e.events.includes("findings.published")));
  // Library cards and tags are not drawn, so nothing leads to them.
  assert.ok(edges.every(e => nodes.some(n => n.id === e.to) && e.to !== "library-cards"));
});

/** A D1 stand-in answering each query of the flow read by what it selects. */
function fakeDb(tables: { due: unknown[]; log: unknown[] }) {
  const result = (sql: string) => sql.includes("FROM pipeline_due") ? tables.due : sql.includes("FROM pipeline_log") ? tables.log : [];
  return { prepare: (sql: string) => { const statement = { bind: () => statement, all: async () => ({ results: result(sql) }), first: async () => null }; return statement; } } as unknown as D1Database;
}

test("a task's state and the event that started it come from the due table and the pipeline log", async () => {
  const now = Date.parse("2026-10-22T14:00:00Z"), at = (m: number) => new Date(now - m * 60_000).toISOString();
  const db = fakeDb({
    due: [
      { task: "findings", dueAt: at(-5), firstAt: at(1), causeId: "e-derived" },
      { task: "tree", dueAt: at(20), firstAt: at(3), causeId: "e-published" },
    ],
    log: [
      { messageId: "t-tree-2", causeId: "t-tree-1", kind: "task", name: "tree", outcome: "later", createdAt: at(3) },
      { messageId: "e-derived", causeId: "t-derive", kind: "event", name: "map.derived", outcome: "routed", createdAt: at(1.5) },
      { messageId: "t-derive", causeId: "e-published", kind: "task", name: "map-derive", outcome: "done", createdAt: at(2) },
      { messageId: "t-tree-1", causeId: "e-published", kind: "task", name: "tree", outcome: "later", createdAt: at(20) },
      { messageId: "e-published", causeId: "t-collect", kind: "event", name: "financials.published", outcome: "routed", createdAt: at(25) },
      { messageId: "t-collect", causeId: "e-requested", kind: "task", name: "collect", outcome: "failed", createdAt: at(26) },
      { messageId: "e-requested", causeId: null, kind: "event", name: "collection.requested", outcome: "routed", createdAt: at(30) },
    ],
  });
  const flow = await readFlow(db, "TTMI", now);
  const node = (id: string) => flow.nodes.find(n => n.id === id)!;
  assert.deepEqual([node("findings").state, node("findings").via], ["queued", { from: "map-derive", event: "map.derived" }]);
  assert.deepEqual([node("tree").state, node("tree").via], ["running", { from: "collect", event: "financials.published" }]);
  assert.deepEqual([node("map-derive").state, node("map-derive").at], ["done", at(2)]);
  assert.deepEqual([node("collect").state, node("collect").via], ["failed", { from: "admin", event: "collection.requested" }]);
  assert.equal(node("admin").state, "done");
  assert.equal(node("explainer").state, "idle");
});
