import assert from "node:assert/strict";
import { test } from "node:test";
import { allowData, canonicalTicker, dataTickers, normalizeTicker, tickerList } from "../../../shared/analysis-runtime/financial-data/policy.ts";
import { issuerFromTitle, parseIssuerDirectory, parseListings, primaryTicker } from "../src/catalog/issuer-directory.ts";

test("a ticker reads in one spelling wherever it enters; no share class is mapped in code", () => {
  assert.equal(canonicalTicker(" goog "), "GOOG");
  assert.equal(canonicalTicker("brk.b"), "BRK.B");
  assert.equal(canonicalTicker("brk-b"), "BRK.B");
  assert.equal(normalizeTicker("googl"), "GOOGL");
  assert.equal(normalizeTicker("BRK-B"), "BRK.B");
  assert.deepEqual(tickerList("goog, brk-b,ORCL"), ["BRK.B", "GOOG", "ORCL"]);
  const tickers = dataTickers({ SEC_DATA_TICKERS: "ORCL,GOOGL,googl,META" });
  assert.deepEqual([...tickers].sort(), ["GOOGL", "META", "ORCL"]);
  assert.equal(allowData(tickers, "googl"), true);
  assert.equal(normalizeTicker("ABCDEFGHIJKL"), "ABCDEFGHIJKL");
  assert.equal(normalizeTicker("1ABC"), "");
  assert.throws(() => tickerList("ORCL, not a ticker"));
});

test("the issuer directory files a second share class under the class EDGAR lists first for the issuer", () => {
  const entries = parseIssuerDirectory({ fields: ["cik", "name", "ticker", "exchange"], data: [
    [1000001, "Example Holdings Inc.", "EXA", "Nasdaq"], [1000001, "Example Holdings Inc.", "EXB", "Nasdaq"], [1000002, "SAMPLE CORP", "SMP-B", "NYSE"], [1000002, "SAMPLE CORP", "SMP-A", "NYSE"], ["x", "bad", "BAD", ""],
  ] });
  assert.deepEqual(entries.map(e => [e[0], e[3]]), [["EXA", "0001000001"], ["EXB", "0001000001"], ["SMP.B", "0001000002"], ["SMP.A", "0001000002"], ["BAD", ""]]);
  assert.equal(primaryTicker(entries, "exb"), "EXA");
  assert.equal(primaryTicker(entries, "EXA"), "EXA");
  assert.equal(primaryTicker(entries, "smp-a"), "SMP.B");
  assert.equal(primaryTicker(entries, "BAD"), "BAD");
  assert.equal(primaryTicker(entries, "NONE"), "NONE");
  assert.equal(primaryTicker([], "EXB"), "EXB");
});

test("a listing title names the company without its share-class wording, and the listing says whether it is an ETF", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => `Y|Z${String.fromCharCode(65 + i % 26)}${String.fromCharCode(65 + Math.floor(i / 26) % 26)}${String.fromCharCode(65 + Math.floor(i / 676))}|Filler ${i} Common Stock|N| |N|100|N||||N`);
  const text = ["Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares",
    "Y|EXA|Example Holdings Inc. - Class A Common Stock|Q|Q|N|40|N|N||EXA|N", "Y|SMP.B|Sample Corp. New Common Stock|N| |N|40|N||SMP.B|SMP.B|N",
    "Y|FND|Example Index Fund ETF|P| |Y|100|N||FND|FND|N", "Y|ZZZZT|Test Issue Common Stock|Q|Q|N|100|Y|N||ZZZZT|N", "Y|SMP$A|Sample Corp. Depositary Shares|N| |N|100|N||SMPpA|SMP-A|N",
    ...rows, "File Creation Time: 1030202618:02|||||"].join("\r\n");
  const listings = parseListings(text);
  assert.deepEqual(listings.slice(0, 3), [["EXA", "Example Holdings Inc. - Class A Common Stock", false], ["SMP.B", "Sample Corp. New Common Stock", false], ["FND", "Example Index Fund ETF", true]]);
  assert.ok(!listings.some(l => l[0] === "ZZZZT" || l[0].includes("$")));
  assert.throws(() => parseListings("Symbol|Security Name|ETF\nEXA|Example|N"), /Invalid/);
  assert.equal(issuerFromTitle("Example Holdings Inc. - Class A Common Stock"), "Example Holdings Inc.");
  assert.equal(issuerFromTitle("Sample Corp. New Common Stock"), "Sample Corp.");
  assert.equal(issuerFromTitle("Example Index Fund ETF"), "Example Index Fund ETF");
});
