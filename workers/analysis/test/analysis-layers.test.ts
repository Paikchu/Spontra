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
