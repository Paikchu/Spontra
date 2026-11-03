import { test } from "node:test";
import assert from "node:assert/strict";
import { directoryPage } from "../src/admin/business-map.ts";
import { LAYERS, type Layer } from "../../../shared/analysis-contract/business-features.ts";
import { layersAbove } from "../../../shared/analysis-runtime/business-features.ts";
import type { IssuerEntry } from "../src/catalog/issuer-directory.ts";

const off = Object.fromEntries(LAYERS.map(l => [l, false])) as Record<Layer, boolean>;
const entries: IssuerEntry[] = [["BRK.B", "BERKSHIRE HATHAWAY INC", "NYSE", "1067983"], ["BRK.A", "BERKSHIRE HATHAWAY INC", "NYSE", "1067983"],
  ["CRWV", "CoreWeave, Inc.", "Nasdaq", "1769628"], ["SPY", "SPDR S&P 500", "NYSE", "884394"], ["AAPL", "Apple Inc.", "Nasdaq", "320193"]];
const layers = (t: string) => t === "CRWV" ? { ...off, map: true } : off;

test("the companies page lists one row per issuer, no ETFs, the companies with layer 1 on first", () => {
  const all = directoryPage(entries, t => t === "SPY", layers, "", "all", 1);
  assert.deepEqual(all.rows.map(r => r.ticker), ["CRWV", "AAPL", "BRK.B"]);
  assert.deepEqual(all.rows.find(r => r.ticker === "BRK.B")!.classes, ["BRK.A"]);
  assert.deepEqual(directoryPage(entries, t => t === "SPY", layers, "", "on", 1).rows.map(r => r.ticker), ["CRWV"]);
  assert.deepEqual(directoryPage(entries, () => false, layers, "berk", "all", 1).rows.map(r => r.ticker), ["BRK.B"]);
});

test("closing a layer closes every layer above it", () => {
  assert.deepEqual(layersAbove("filings"), ["findings", "tree", "valuation"]);
  assert.deepEqual(layersAbove("valuation"), []);
});

test("the findings read layer 2 only: map changes reach them through the per-period extract", async () => {
  const { SUBSCRIPTIONS, TASKS } = await import("../src/pipeline/registry.ts");
  for (const event of ["map.derived", "guidance.published", "fundamentals.updated"] as const) {
    const tasks = SUBSCRIPTIONS[event]!.map(s => s.task);
    assert.ok(tasks.includes("extract") && !tasks.includes("findings"), event);
  }
  assert.deepEqual(SUBSCRIPTIONS["extract.published"]!.map(s => s.task), ["findings", "items"]);
  assert.equal(TASKS.extract.scope, "filings");
  assert.equal(TASKS.items.scope, "filings");
  const { ITEM_POLICY } = await import("../src/items/recipe.ts");
  assert.ok(!ITEM_POLICY.allow!.includes("findings"), "a filing analysis never reads the findings built on it");
});

test("the layers above read a filing's analysis and the passages it quoted, never the filing", async () => {
  const { listFilingAnalyses, readFilingAnalysis } = await import("../src/items/library.ts");
  const passage = (id: string, filedAt: string) => ({ passageId: id, documentId: `d-${id}`, title: `CRWV 10-Q ${filedAt}`, form: "10-Q", filedAt, url: "https://www.sec.gov/x", path: ["Liquidity"], text: "We expect capital expenditures to increase.", table: null });
  const item = (id: string, periodEnd: string, filedAt: string) => ({ schemaVersion: "item-analysis.v1", ticker: "CRWV", itemId: id, itemKind: "report", periodEnd, generatedAt: filedAt, version: "items.v1",
    finding: { title: `Report ${periodEnd}`, judgment: { text: `Capex rose in ${periodEnd}.`, sourceIds: [] } }, materials: [], passages: [passage(`p-${id}`, filedAt)], sources: [], trace: [] });
  const cache: Record<string, unknown> = {
    "items:v1:CRWV": { version: "items.v1", fingerprint: "f", generatedAt: "", items: [{ id: "0001-26-000001", kind: "report", written: true }, { id: "0001-26-000002", kind: "report", written: true }, { id: "0001-26-000003", kind: "current", written: false }] },
    "item-analysis:v1:CRWV:0001-26-000001": item("0001-26-000001", "2026-03-31", "2026-05-10"),
    "item-analysis:v1:CRWV:0001-26-000002": item("0001-26-000002", "2026-06-30", "2026-08-10"),
  };
  const db = { prepare: () => { let key = ""; const s = { bind: (k: string) => { key = k; return s; }, first: async () => cache[key] ? { cache_key: key, payload: JSON.stringify(cache[key]), fetched_at: "" } : null }; return s; } } as unknown as D1Database;
  const list = await listFilingAnalyses(db, "CRWV");
  assert.deepEqual(list.map(a => a.periodEnd), ["2026-06-30", "2026-03-31"]);
  const read = await readFilingAnalysis(db, "CRWV", "0001-26-000001");
  assert.equal(read?.judgment, "Capex rose in 2026-03-31.");
  assert.deepEqual(read?.passages.map(p => p.passageId), ["p-0001-26-000001"]);
  assert.equal(await readFilingAnalysis(db, "CRWV", "0001-26-000003"), null);
});

test("a layer waits while a lower layer's run is still due for the company, and not for a stuck one", async () => {
  const { unsettledBelow } = await import("../src/pipeline/ai-tasks.ts");
  const now = new Date("2026-11-04T12:00:00Z");
  const due = [
    { ticker: "CRWV", task: "items", due_at: "2026-11-04T12:05:00Z", first_requested_at: "2026-11-04T11:50:00Z" },
    { ticker: "CRWV", task: "library-cards", due_at: "2026-11-04T13:00:00Z", first_requested_at: "2026-11-03T00:00:00Z" },
    { ticker: "CRWV", task: "translate", due_at: "2026-11-04T12:05:00Z", first_requested_at: "2026-11-04T11:50:00Z" },
  ];
  const db = { prepare: () => { let binds: unknown[] = []; const s = { bind: (...b: unknown[]) => { binds = b; return s; }, all: async () => {
    const [ticker, tasks, at, since] = binds as [string, string, string, string];
    return { results: due.filter(r => r.ticker === ticker && (JSON.parse(tasks) as string[]).includes(r.task) && r.due_at > at && r.first_requested_at > since) };
  } }; return s; } } as unknown as D1Database;
  const env = { DB: db } as never;
  assert.deepEqual(await unsettledBelow(env, "CRWV", ["map", "filings"], now), ["items"]);
  assert.deepEqual(await unsettledBelow(env, "ORCL", ["map", "filings"], now), []);
});
