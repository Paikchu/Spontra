import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompanyEvent, EventsPublication } from "../../../shared/analysis-contract/events.ts";
import type { PublicFilingDigest, PublicFilingDigestPage } from "../../../shared/analysis-contract/filings.ts";
import { readEventsPublication } from "../../../shared/analysis-runtime/events.ts";
import { railEntries } from "../../../shared/analysis-runtime/rail.ts";
import { insiderSummary, railLayout, rowLeaves } from "../src/event-noise.ts";

const NOW = new Date("2026-11-01T00:00:00Z");

const event = (extra: Partial<CompanyEvent> & Pick<CompanyEvent, "id" | "form" | "class" | "filedAt">): CompanyEvent => ({
  ticker: "TEST", eventDate: extra.filedAt, items: [], description: "", title: null, importance: "normal",
  edgarUrl: "https://www.sec.gov/i", documentUrl: "https://www.sec.gov/d.htm", exhibits: [], summary: null, insider: null, ...extra,
});
const trade = (id: string, day: string, owner: [string, string], side: "sell" | "buy", amount: number, plan = false): CompanyEvent => event({
  id, form: "4", class: "insider", filedAt: day,
  insider: {
    ownerCik: owner[0], ownerName: owner[1], title: "Chief Executive Officer", isDirector: false, isOfficer: true, isTenPercentOwner: false,
    rule10b51: plan, planAdoptedOn: null, securityTitle: "Class A", lines: [],
    sold: side === "sell" ? { shares: amount / 100, proceeds: amount, averagePrice: 100 } : null,
    bought: side === "buy" ? { shares: amount / 100, cost: amount, averagePrice: 100 } : null,
    exercised: 0, heldAfter: 1, footnotes: [],
  },
});
const INTRATOR: [string, string] = ["1", "Intrator Michael"], MAGNETAR: [string, string] = ["2", "Magnetar Financial LLC"];
const AGARWAL: [string, string] = ["3", "Agarwal Nitin"], MCBEE: [string, string] = ["4", "McBee Brannin"], BUYER: [string, string] = ["5", "Buyer Director"];

const items = (events: CompanyEvent[], filings: PublicFilingDigest[] = []) => {
  const publication: EventsPublication = { schemaVersion: "events.v1", ticker: "TEST", checkedAt: NOW.toISOString(), pendingInsider: 0, events };
  const page = { filings, nextCursor: null } as unknown as PublicFilingDigestPage;
  return railEntries(page, readEventsPublication(publication, "TEST"));
};

const trades = [
  trade("i1", "2026-10-20", INTRATOR, "sell", 200_000_000, true),
  trade("i2", "2026-10-10", INTRATOR, "sell", 150_000_000, true),
  trade("m1", "2026-10-18", MAGNETAR, "sell", 530_000_000),
  trade("a1", "2026-10-15", AGARWAL, "sell", 12_000_000, true),
  trade("c1", "2026-09-30", MCBEE, "sell", 4_000_000),
  trade("b1", "2026-09-01", BUYER, "buy", 2_000_000),
  trade("old", "2026-07-01", MCBEE, "sell", 9_000_000),
];

test("the last 90 days of insider trades sum to a net amount, people and 10b5-1 people", () => {
  const summary = insiderSummary(items(trades), NOW)!;
  assert.equal(summary.sold, 896_000_000);
  assert.equal(summary.bought, 2_000_000);
  assert.equal(summary.net, -894_000_000);
  assert.equal(summary.people.length, 5);
  assert.equal(summary.planned, 2);
  // Largest net amount first: Magnetar 530M, Intrator 350M over two trades, then Agarwal.
  assert.deepEqual(summary.people.slice(0, 3).map(p => [p.name, p.net, p.trades]), [
    ["Magnetar Financial LLC", -530_000_000, 1], ["Intrator Michael", -350_000_000, 2], ["Agarwal Nitin", -12_000_000, 1],
  ]);
  assert.equal(summary.people.find(p => p.name === "Buyer Director")!.net, 2_000_000);
  // The trade before the window stays out; the expanded rows are the per-person folds and hold exactly the window's trades.
  assert.ok(!summary.items.some(item => item.id === "old"));
  assert.deepEqual(summary.rows.flatMap(rowLeaves).map(item => item.id).sort(), ["a1", "b1", "c1", "i1", "i2", "m1"]);
  const intrator = summary.rows.find(row => row.kind === "plan" && row.name === "Intrator Michael");
  assert.ok(intrator && intrator.kind === "plan" && intrator.items.length === 2);
});

test("no insider trades in the window, no summary", () => {
  assert.equal(insiderSummary(items([trade("old", "2026-07-01", MCBEE, "sell", 9_000_000)]), NOW), null);
  assert.equal(insiderSummary(items([event({ id: "e", form: "8-K", class: "earnings", filedAt: "2026-10-01", items: ["2.02"] })]), NOW), null);
});

test("the latest earnings filing leads the rail, the summary holds the window's trades, and nothing shows twice", () => {
  const earnings = event({ id: "earn", form: "8-K", class: "earnings", filedAt: "2026-08-11", items: ["2.02"] });
  const deal = event({ id: "deal", form: "8-K", class: "deal", filedAt: "2026-10-25", items: ["1.01"] });
  const all = items([...trades, earnings, deal]);
  for (const filter of ["key", "all"] as const) {
    const layout = railLayout(all, filter, NOW);
    assert.ok(layout.pinned && layout.pinned.kind === "item" && layout.pinned.item.id === "earn", filter);
    assert.ok(layout.summary, filter);
    const restIds = layout.rest.flatMap(rowLeaves).map(item => item.id);
    assert.ok(!restIds.includes("earn"));
    assert.ok(!restIds.some(id => layout.summary!.items.some(item => item.id === id)), filter);
  }
  assert.ok(railLayout(all, "all", NOW).rest.flatMap(rowLeaves).some(item => item.id === "old"));
  // The Insiders reading keeps its per-person rows; the others get no card and no pin.
  for (const filter of ["insiders", "earnings", "material"] as const) {
    const layout = railLayout(all, filter, NOW);
    assert.equal(layout.pinned, null);
    assert.equal(layout.summary, null);
  }
});

test("a 10-Q report outranks an older 8-K earnings release as the pinned filing", () => {
  const report = { accessionNumber: "q3", form: "10-Q", date: "2026-10-30", periodEnd: "2026-09-30", headline: "Quarter headline", sources: [] } as unknown as PublicFilingDigest;
  const release = event({ id: "earn", form: "8-K", class: "earnings", filedAt: "2026-08-11", items: ["2.02"] });
  const layout = railLayout(items([...trades, release], [report]), "key", NOW);
  assert.ok(layout.pinned && layout.pinned.kind === "item" && layout.pinned.item.id === "q3");
});
