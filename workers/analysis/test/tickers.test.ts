import assert from "node:assert/strict";
import { test } from "node:test";
import { allowData, canonicalTicker, dataTickers, normalizeTicker, tickerList } from "../../../shared/analysis-runtime/financial-data/policy.ts";
import { parseIssuerDirectory } from "../src/pipeline/discovery.ts";

test("a second share class resolves to the ticker the data is kept under, wherever a ticker enters", () => {
  assert.equal(canonicalTicker(" goog "), "GOOGL");
  assert.equal(canonicalTicker("GOOGL"), "GOOGL");
  assert.equal(canonicalTicker("brk.b"), "BRK.B");
  assert.equal(canonicalTicker("brk-b"), "BRK.B");
  assert.equal(normalizeTicker("goog"), "GOOGL");
  assert.equal(normalizeTicker("BRK-B"), "BRK.B");
  assert.deepEqual(tickerList("goog, brk-b,ORCL"), ["BRK.B", "GOOGL", "ORCL"]);
  const tickers = dataTickers({ SEC_DATA_TICKERS: "ORCL,GOOG,GOOGL,META" });
  assert.deepEqual([...tickers].sort(), ["GOOGL", "META", "ORCL"]);
  assert.equal(allowData(tickers, "goog"), true);
  assert.equal(normalizeTicker("ABCDEFGHIJKL"), "ABCDEFGHIJKL");
  assert.equal(normalizeTicker("1ABC"), "");
  assert.throws(() => tickerList("ORCL, not a ticker"));
});

test("the issuer directory maps every symbol to its CIK and files the second class under the data ticker", () => {
  const directory = parseIssuerDirectory({ fields: ["cik", "name", "ticker", "exchange"], data: [
    [1652044, "Alphabet Inc.", "GOOGL", "Nasdaq"], [1652044, "Alphabet Inc.", "GOOG", "Nasdaq"], [1067983, "BERKSHIRE HATHAWAY INC", "BRK-B", "NYSE"], ["x", "bad", "BAD", ""],
  ] });
  assert.deepEqual(directory, { GOOGL: "0001652044", "BRK.B": "0001067983" });
  assert.deepEqual(parseIssuerDirectory({ fields: ["name"], data: [] }), {});
});
