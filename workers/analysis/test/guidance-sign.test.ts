import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeForMatch, quoteNumbers, readExtractedGuidance, verifyGuidance } from "../../../shared/analysis-runtime/guidance.ts";

function verify(quote: string, low: number, high: number, amount = false) {
  const [item] = readExtractedGuidance({ items: [{
    metric: amount ? "free_cash_flow" : "eps", measure: amount ? "amount" : "per_share",
    segment: null, label: "Guidance", basis: "gaap", direction: null,
    horizon: "annual", form: "range", fiscalYear: 2026, fiscalQuarter: null,
    unit: amount ? "USD" : "USD_per_share", currency: "USD", low, high,
    text: quote, quote,
  }] });
  assert.ok(item, "fixture must parse as extracted guidance");
  return verifyGuidance(item, normalizeForMatch(quote));
}

const cases = [
  { quote: "We expect EPS of -$0.15 to -$0.10.", low: -0.15, high: -0.10 },
  { quote: "We expect EPS of $−0.15 to $−0.10.", low: -0.15, high: -0.10 },
  { quote: "We expect EPS of ($0.15) to ($0.10).", low: -0.15, high: -0.10 },
  { quote: "We expect net loss per share of $0.10 to $0.15.", low: -0.15, high: -0.10 },
  { quote: "We expect a loss of $0.10 to $0.15 per share.", low: -0.15, high: -0.10 },
  { quote: "We expect $0.10 to $0.15 loss per share.", low: -0.15, high: -0.10 },
  { quote: "We expect free cash flow of -$150 to -$100 million.", low: -150e6, high: -100e6, amount: true },
  { quote: "We expect free cash flow of ($150 million) to ($100 million).", low: -150e6, high: -100e6, amount: true },
  { quote: "We expect negative free cash flow of $100 to $150 million.", low: -150e6, high: -100e6, amount: true },
  { quote: "We expect free cash flow to be negative $100 to $150 million.", low: -150e6, high: -100e6, amount: true },
] as const;

for (const entry of cases) {
  const amount = "amount" in entry && entry.amount;
  test(`accept signed monetary guidance: ${entry.quote}`, () => {
    const result = verify(entry.quote, entry.low, entry.high, amount);
    assert.deepEqual(result.issues, []);
    assert.deepEqual([result.item?.low, result.item?.high], [entry.low, entry.high]);
  });

  test(`reject positive magnitudes against negative evidence: ${entry.quote}`, () => {
    const result = verify(entry.quote, -entry.high, -entry.low, amount);
    assert.equal(result.item, null);
    assert.ok(result.issues.some(issue => issue.includes("does not appear in the quote")));
  });
}

for (const quote of ["We expect EPS of $0.10 to $0.15.", "We expect EPS of $0.10-$0.15.", "We expect EPS of $0.10–$0.15."]) {
  test(`positive guidance keeps its sign: ${quote}`, () => {
    assert.deepEqual(verify(quote, 0.10, 0.15).issues, []);
    assert.equal(verify(quote, -0.15, -0.10).item, null);
  });
}

test("ordinary scaled USD guidance keeps its sign", () => {
  const quote = "We expect free cash flow of $100 to $150 million.";
  assert.deepEqual(verify(quote, 100e6, 150e6, true).issues, []);
  assert.equal(verify(quote, -150e6, -100e6, true).item, null);
});

test("explicit signs permit a range across zero without inferring the other endpoint's sign", () => {
  const quote = "We expect EPS of -$0.10 to $0.15.";
  assert.deepEqual(verify(quote, -0.10, 0.15).issues, []);
  assert.equal(verify(quote, -0.15, -0.10).item, null);
});

test("loss wording does not negate another metric's guidance", () => {
  for (const quote of [
    "We expect a net loss of $20 million; free cash flow will be $100 to $150 million.",
    "Despite a net loss, we expect free cash flow of $100 to $150 million.",
  ]) {
    assert.deepEqual(verify(quote, 100e6, 150e6, true).issues, []);
    assert.equal(verify(quote, -150e6, -100e6, true).item, null);
  }
});

test("loss magnitude order does not override numeric low/high order", () => {
  const result = verify("We expect net loss per share of $0.10 to $0.15.", -0.10, -0.15);
  assert.equal(result.item, null);
  assert.ok(result.issues.includes("low is greater than high"));
});

test("existing unsigned percent and scale scanning is preserved", () => {
  assert.deepEqual(quoteNumbers("Revenue will decline 2% to 4%."), [2, 4]);
  assert.deepEqual(quoteNumbers("Margin will improve 50 to 100 basis points."), [50, 0.5, 100, 1]);
  assert.deepEqual(quoteNumbers("Revenue will be $15.0 to $15.2 billion."), [15, 15e9, 15.2, 15.2e9]);
});
