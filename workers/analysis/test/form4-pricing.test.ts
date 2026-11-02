import { test } from "node:test";
import assert from "node:assert/strict";
import { parseForm4 } from "../src/events/form4.ts";
import type { CompanyEvent, EventsPublication } from "../../../shared/analysis-contract/events.ts";
import { eventImportance, holdingPath, insiderCadence, insiderCluster, insiderTradeValueUsd, insiderWindowValueUsd, isOpenMarketInsiderTrade, readEventsPublication } from "../../../shared/analysis-runtime/events.ts";
import { resolveRef, type FindingData } from "../../../shared/analysis-runtime/findings.ts";

const line = (code: string, shares: number, price: string, derivative = false, ad = code === "S" ? "D" : "A") => {
  const tag = derivative ? "derivativeTransaction" : "nonDerivativeTransaction";
  return `<${tag}><transactionDate><value>2026-10-01</value></transactionDate>
    <transactionCoding><transactionCode>${code}</transactionCode></transactionCoding>
    <transactionAmounts><transactionShares><value>${shares}</value></transactionShares>
      <transactionPricePerShare>${price}</transactionPricePerShare>
      <transactionAcquiredDisposedCode><value>${ad}</value></transactionAcquiredDisposedCode></transactionAmounts>
    <postTransactionAmounts><sharesOwnedFollowingTransaction><value>5000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
  </${tag}>`;
};
const priced = (value: number) => `<value>${value}</value>`;
const parse = (...lines: string[]) => parseForm4(`<ownershipDocument>
  <reportingOwner><reportingOwnerId><rptOwnerCik>123</rptOwnerCik><rptOwnerName>Example Owner</rptOwnerName></reportingOwnerId></reportingOwner>
  ${lines.join("")}</ownershipDocument>`)!;
const event = (insider: CompanyEvent["insider"], id = "one"): CompanyEvent => ({
  id, ticker: "TEST", form: "4", filedAt: "2026-10-01", eventDate: "2026-10-01", items: [], class: "insider",
  description: "FORM 4", title: null, importance: "routine", edgarUrl: "https://www.sec.gov/index.html",
  documentUrl: "https://www.sec.gov/form4.xml", exhibits: [], summary: null, insider,
});
const publication = (e: CompanyEvent): EventsPublication => ({ schemaVersion: "events.v1", ticker: "TEST", checkedAt: "2026-10-01T00:00:00Z", events: [e], pendingInsider: 0 });

for (const code of ["S", "P"]) {
  const aggregate = (t: ReturnType<typeof parse>) => code === "S" ? t.sold : t.bought;
  const money = code === "S" ? "proceeds" : "cost";
  test(`${code}: a missing price preserves shares but makes total money and average unknown`, () => {
    const t = parse(line(code, 1000, priced(100)), line(code, 1000, '<footnoteId id="F1"/>'));
    assert.deepEqual(aggregate(t), { shares: 2000, [money]: null, averagePrice: null, pricedShares: 1000 });
  });
  test(`${code}: all unpriced lines have zero priced coverage, not a zero transaction value`, () => {
    assert.deepEqual(aggregate(parse(line(code, 1000, ""), line(code, 500, ""))),
      { shares: 1500, [money]: null, averagePrice: null, pricedShares: 0 });
  });
  test(`${code}: fully priced lines retain the weighted price, including explicitly reported zero`, () => {
    assert.deepEqual(aggregate(parse(line(code, 1000, priced(100)), line(code, 500, priced(200)), line(code, 500, priced(0)))),
      { shares: 2000, [money]: 200000, averagePrice: 100, pricedShares: 2000 });
    assert.deepEqual(aggregate(parse(line(code, 10, priced(0)))), { shares: 10, [money]: 0, averagePrice: 0, pricedShares: 10 });
  });
  test(`${code}: derivative, other-code and opposite-direction lines do not reduce coverage`, () => {
    assert.deepEqual(aggregate(parse(line(code, 1000, priced(100)), line(code, 1000, "", true), line("G", 1000, ""), line(code, 1000, "", false, code === "S" ? "A" : "D"))),
      { shares: 1000, [money]: 100000, averagePrice: 100, pricedShares: 1000 });
    assert.equal(aggregate(parse(line("G", 1000, ""))), null);
  });
}

test("the publication reader accepts nullable monetary aggregates and retains price coverage", () => {
  const e = event(parse(line("S", 1000, priced(100)), line("S", 1000, ""), line("P", 500, "")));
  // Explicitly construct the new wire shape so this also exercises the reader before the parser is fixed.
  Object.assign(e.insider!.sold!, { proceeds: null, averagePrice: null, pricedShares: 1000 });
  Object.assign(e.insider!.bought!, { cost: null, averagePrice: null, pricedShares: 0 });
  const read = readEventsPublication(publication(e), "TEST");
  assert.ok(read, "partial pricing must not make the entire publication disappear");
  assert.deepEqual(read.events[0].insider, e.insider);
});

test("legacy publications without coverage remain readable without a rebuild", () => {
  const e = event(parse(line("S", 1000, priced(100)), line("P", 500, priced(200))));
  e.insider!.sold = { shares: 1000, proceeds: 100000, averagePrice: 100 };
  e.insider!.bought = { shares: 500, cost: 100000, averagePrice: 200 };
  assert.deepEqual(readEventsPublication(publication(e), "TEST")!.events[0].insider, e.insider);
});

test("unknown money propagates through value, cadence and holding analytics instead of becoming zero", () => {
  const partial = event(parse(line("S", 1000, priced(100)), line("S", 1000, "")));
  Object.assign(partial.insider!.sold!, { proceeds: null, averagePrice: null });
  const known = event(parse(line("S", 1000, priced(200))), "two");
  assert.equal(insiderTradeValueUsd(partial), null);
  assert.equal(insiderWindowValueUsd(partial, [partial, known]), null);
  const cadence = insiderCadence([partial, known], "123", "2026-10-01");
  assert.equal(cadence.totalShares, 3000);
  assert.equal(cadence.totalProceeds, null);
  assert.equal(holdingPath([partial], "123", 24, "2026-10-01")[0].proceeds, null);
  const other = event({ ...partial.insider!, ownerCik: "456" }, "other");
  assert.equal(insiderCluster([known, other], known.id)[0].proceeds, null);
  assert.equal(eventImportance(partial), "routine");
  assert.equal(insiderTradeValueUsd(known), 200000);
  assert.equal(insiderCadence([known], "123", "2026-10-01").totalProceeds, 200000);
  assert.equal(insiderWindowValueUsd(known, [known, known]), 200000);
  assert.equal(insiderTradeValueUsd(event(parse(line("G", 10, "")))), 0);
});

test("mixed buy/sell direction compares shares when either monetary total is unknown", () => {
  const e = event(parse(line("S", 2000, ""), line("P", 1000, priced(100))));
  Object.assign(e.insider!.sold!, { proceeds: null, averagePrice: null });
  assert.equal(isOpenMarketInsiderTrade(e), "sell");
  assert.equal(insiderTradeValueUsd(e), null);
});

test("finding evidence cannot replace an unknown sale price with the purchase price", () => {
  const e = event(parse(line("S", 2000, ""), line("P", 1000, priced(100))));
  const data: FindingData = { quarters: [], history: null, capital: null, fundamentals: null, guidance: null, events: publication(e) };
  const resolve = (field: "averagePrice" | "proceeds" | "cost" | "sharesSold") => resolveRef(data, { event: { id: e.id, field } }, e.eventDate, "quarter");
  assert.equal(resolve("averagePrice"), null);
  assert.equal(resolve("proceeds"), null);
  assert.equal(resolve("cost")!.value, 100000);
  assert.equal(resolve("sharesSold")!.value, 2000);
});
