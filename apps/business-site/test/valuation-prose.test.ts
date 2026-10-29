import assert from "node:assert/strict";
import { test } from "node:test";
import { citationOrder, leadSentence, pathLeaf, proseBlocks, proseParts } from "../src/valuation-prose.ts";

test("citations are numbered in reading order, with uncited evidence after", () => {
  const order = citationOrder(["Growth [eaaaaaaaaaa][ebbbbbbbbbb].", "Again [eaaaaaaaaaa] and [ecccccccccc]."], ["edddddddddd", "ebbbbbbbbbb"]);
  assert.deepEqual([...order], [["eaaaaaaaaaa", 1], ["ebbbbbbbbbb", 2], ["ecccccccccc", 3], ["edddddddddd", 4]]);
});

test("adjacent citations form one group; separated ones stay apart", () => {
  assert.deepEqual(proseParts("Revenue rose [eaaaaaaaaaa][ebbbbbbbbbb]; RPO [ecccccccccc]."), [
    { kind: "text", text: "Revenue rose " }, { kind: "cites", ids: ["eaaaaaaaaaa", "ebbbbbbbbbb"] },
    { kind: "text", text: "; RPO " }, { kind: "cites", ids: ["ecccccccccc"] }, { kind: "text", text: "." },
  ]);
  assert.deepEqual(proseParts("No citations."), [{ kind: "text", text: "No citations." }]);
});

test("run-in capitalised headings become their own blocks; acronyms in sentences do not", () => {
  const text = "PUBLIC FACTS (as reported). Growth: Q1 revenue +30%. RPO $664B vs $455B. GAAP EPS $1.92 rose. MANAGEMENT GUIDANCE. FY27 EPS $8.10.\n\nIS THE PATH ALREADY THE BASE CASE? No — it is not. READ-THROUGH. The edge is real.";
  assert.deepEqual(proseBlocks(text), [
    { heading: "PUBLIC FACTS (as reported)", text: "Growth: Q1 revenue +30%. RPO $664B vs $455B. GAAP EPS $1.92 rose." },
    { heading: "MANAGEMENT GUIDANCE", text: "FY27 EPS $8.10." },
    { heading: "IS THE PATH ALREADY THE BASE CASE?", text: "No — it is not." },
    { heading: "READ-THROUGH", text: "The edge is real." },
  ]);
  assert.deepEqual(proseBlocks("Verdict: no support.\n\nThe business is not broken."), [
    { heading: null, text: "Verdict: no support." }, { heading: null, text: "The business is not broken." },
  ]);
});

test("a dimension's lead is its first sentence without citations", () => {
  assert.equal(leadSentence("Delivery is beating plans on every line [eaaaaaaaaaa][ebbbbbbbbbb]. Q1 revenue +30% vs. the 27–29% guide."), "Delivery is beating plans on every line.");
  assert.equal(leadSentence("Revenue of $19.3B rose 30% [eaaaaaaaaaa]."), "Revenue of $19.3B rose 30%.");
  assert.equal(leadSentence("No stop here"), "No stop here");
  assert.equal(leadSentence("该模式已被证明行之有效。2027 财年第一季度总营收增长 30%。"), "该模式已被证明行之有效。");
});

test("a source path is named by its last step", () => {
  assert.equal(pathLeaf("Item 2. Management’s Discussion › Results of Operations › Liquidity and Capital Resources:"), "Liquidity and Capital Resources");
  assert.equal(pathLeaf("kalkinemedia.com"), "kalkinemedia.com");
  assert.equal(pathLeaf(null), null);
});
