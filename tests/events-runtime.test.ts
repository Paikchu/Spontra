import test from "node:test";
import assert from "node:assert/strict";
import type { CompanyEvent, EventsPublication, InsiderTransaction } from "../shared/analysis-contract/events";
import { classifyEvent, holdingPath, insiderCadence, insiderCluster, insiderVerdict, parseItems, readEventsPublication, soldShareOfHolding } from "../shared/analysis-runtime/events";

const insider = (over: Partial<InsiderTransaction> = {}): InsiderTransaction => ({
  ownerCik: "1", ownerName: "Jane Doe", title: "Chief Financial Officer", isDirector: false, isOfficer: true, isTenPercentOwner: false, rule10b51: null, planAdoptedOn: null,
  securityTitle: "Common Stock", lines: [], sold: { shares: 10_000, proceeds: 1_500_000, averagePrice: 150 }, bought: null, exercised: 0, heldAfter: 190_000, footnotes: [], ...over,
});
const form4 = (id: string, date: string, t: Partial<InsiderTransaction> = {}): CompanyEvent => ({
  id, ticker: "ORCL", form: "4", filedAt: date, eventDate: date, items: [], class: "insider", description: "", edgarUrl: `https://www.sec.gov/a/${id}`, documentUrl: `https://www.sec.gov/a/${id}/f.xml`,
  exhibits: [], summary: null, insider: insider(t),
});

test("8-K item codes decide the class; 8.01 reads its description; Form 4 is always insider", () => {
  assert.deepEqual(parseItems("2.02,9.01"), ["2.02", "9.01"]);
  assert.equal(classifyEvent("8-K", ["2.02", "9.01"]), "earnings");
  assert.equal(classifyEvent("8-K", ["5.02", "9.01"]), "executive");
  assert.equal(classifyEvent("8-K", ["1.01", "2.03"]), "deal");
  assert.equal(classifyEvent("8-K", ["2.03"]), "financing");
  assert.equal(classifyEvent("8-K", ["8.01"], "Share repurchase program"), "capital_return");
  assert.equal(classifyEvent("8-K", ["8.01"], "Settlement of litigation"), "legal");
  assert.equal(classifyEvent("8-K", ["8.01"]), "other");
  assert.equal(classifyEvent("8-K", ["7.01"], "Fiscal 2027 outlook"), "guidance");
  assert.equal(classifyEvent("4", []), "insider");
});

test("a sale reads against the owner's own cadence and the other insiders, with the rule that decided it", () => {
  const regular = ["2025-01-15", "2025-04-15", "2025-07-15", "2025-10-15"].map((d, i) => form4(`r${i}`, d, { rule10b51: true, sold: { shares: 10_000, proceeds: 1_500_000, averagePrice: 150 }, heldAfter: 200_000 - i * 10_000 }));
  const events = [...regular, form4("other", "2025-10-20", { ownerCik: "2", ownerName: "John Roe", sold: { shares: 500, proceeds: 75_000, averagePrice: 150 }, heldAfter: 9_500 })];
  const last = regular[3];
  const cadence = insiderCadence(events, "1", last.eventDate);
  assert.equal(cadence.sales.length, 4);
  assert.ok(cadence.regular, "quarterly sales with equal gaps are regular");
  assert.equal(Math.round(cadence.intervalDays!), 91);
  assert.equal(insiderVerdict(last.insider!, cadence, insiderCluster(events, last.id)).label, "按计划");
  assert.equal(soldShareOfHolding(last.insider!)!.toFixed(1), "5.6");
  // One large first sale with no plan is flagged, and the rule names the threshold.
  const big = form4("big", "2025-11-01", { ownerCik: "3", ownerName: "Big Seller", sold: { shares: 50_000, proceeds: 7_500_000, averagePrice: 150 }, heldAfter: 100_000 });
  const verdict = insiderVerdict(big.insider!, insiderCadence([...events, big], "3", big.eventDate), insiderCluster([...events, big], big.id));
  assert.equal(verdict.label, "需要留意");
  assert.ok(verdict.rules.some(r => r.includes("33.3%")));
  assert.ok(verdict.rules.some(r => r.includes("首次卖出")));
  // A withholding-only filing is not a trade.
  assert.equal(insiderVerdict(insider({ sold: null, lines: [] }), insiderCadence([], "1", "2025-01-01"), []).label, "非交易变动");
  // The holding path steps through the owner's filings oldest first.
  assert.deepEqual(holdingPath(events, "1", 24, "2025-12-31").map(p => p.held), [200_000, 190_000, 180_000, 170_000]);
});

test("a publication is re-validated per ticker: wrong ticker or malformed events read as none", () => {
  const publication: EventsPublication = { schemaVersion: "events.v1", ticker: "ORCL", checkedAt: "2026-10-09T00:00:00.000Z", pendingInsider: 0, events: [form4("a", "2026-09-01")] };
  assert.equal(readEventsPublication(publication, "ORCL")?.events.length, 1);
  assert.equal(readEventsPublication(publication, "MSFT"), null);
  assert.equal(readEventsPublication({ ...publication, events: [{ id: "x" }] }, "ORCL"), null);
  // An 8-K cannot carry the insider class, and the unknown field is stripped.
  const odd = { ...publication, events: [{ ...form4("b", "2026-09-02"), form: "8-K", insider: null, secret: "PRIVATE" }] };
  const read = readEventsPublication(odd, "ORCL")!;
  assert.equal(read.events.length, 0);
  assert.ok(!JSON.stringify(read).includes("PRIVATE"));
});
