import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompanyEvent, EventsPublication } from "../../../shared/analysis-contract/events.ts";
import type { PublicFilingDigest, PublicFilingDigestPage } from "../../../shared/analysis-contract/filings.ts";
import { readEventsPublication } from "../../../shared/analysis-runtime/events.ts";
import { railEntries } from "../../../shared/analysis-runtime/rail.ts";
import { insiderFilings, personRowId, railLayout, rowLeaves, streamRows } from "../src/event-noise.ts";
import { personsFromEvents } from "../../../shared/analysis-runtime/insiders.ts";

const NOW = new Date("2026-11-01T00:00:00Z");

const event = (extra: Partial<CompanyEvent> & Pick<CompanyEvent, "id" | "form" | "class" | "filedAt">): CompanyEvent => ({
  ticker: "TEST", eventDate: extra.filedAt, items: [], description: "", title: null, importance: "normal",
  edgarUrl: "https://www.sec.gov/i", documentUrl: "https://www.sec.gov/d.htm", exhibits: [], summary: null, insider: null, ...extra,
});
const trade = (id: string, day: string, owner: [string, string], side: "sell" | "buy", amount: number, plan = false): CompanyEvent => event({
  id, form: "4", class: "insider", filedAt: day,
  insider: {
    ownerCik: owner[0], ownerName: owner[1], title: "Chief Executive Officer", isDirector: false, isOfficer: true, isTenPercentOwner: false,
    rule10b51: plan, planAdoptedOn: null, securityTitle: "Class A",
    lines: [{ date: day, code: side === "sell" ? "S" : "P", acquiredDisposed: side === "sell" ? "D" : "A", shares: amount / 100, price: 100, ownedAfter: 1, ownership: "D", derivative: false }],
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

test("every insider filing of any age is held for its person, and the people group them, latest trade first", () => {
  const filings = insiderFilings(items(trades));
  assert.deepEqual(filings.map(item => item.id), ["i1", "m1", "a1", "i2", "c1", "b1", "old"]);
  const persons = personsFromEvents(filings.map(item => item.event), NOW);
  assert.deepEqual(persons.map(p => [p.name, p.filings, p.lastTradeAt]), [
    ["Intrator Michael", 2, "2026-10-20"], ["Magnetar Financial LLC", 1, "2026-10-18"], ["Agarwal Nitin", 1, "2026-10-15"], ["McBee Brannin", 2, "2026-09-30"], ["Buyer Director", 1, "2026-09-01"],
  ]);
  // Figures are the filings' lines, netted over the person's whole history: McBee's July sale counts, the buyer's purchase is a positive net.
  const mcbee = persons.find(p => p.name === "McBee Brannin")!;
  assert.deepEqual([mcbee.sold.count, mcbee.sold.value, mcbee.net.value], [2, 13_000_000, -13_000_000]);
  assert.deepEqual([persons[4]!.bought.count, persons[4]!.net.value, persons[4]!.net.shares], [1, 2_000_000, 20_000]);
  assert.equal(persons.filter(p => p.planned).length, 2);
});

test("no insider filings, no people", () => {
  const earnings = items([event({ id: "e", form: "8-K", class: "earnings", filedAt: "2026-10-01", items: ["2.02"] })]);
  assert.deepEqual(insiderFilings(earnings), []);
  assert.deepEqual(railLayout([], "key").insiders, []);
  // People handed to a reading without insider filings never list.
  const persons = personsFromEvents(items(trades).flatMap(item => item.kind === "event" ? [item.event] : []), NOW);
  assert.deepEqual(streamRows(railLayout(earnings, "key"), [], null, "key", persons).map(r => r.id), ["e"]);
});

test("each person lists as a row of their own at the date of their latest trade, among the other rows", () => {
  const earnings = event({ id: "earn", form: "8-K", class: "earnings", filedAt: "2026-08-11", items: ["2.02"] });
  const deal = event({ id: "deal", form: "8-K", class: "deal", filedAt: "2026-10-16", items: ["1.01"] });
  const vote = event({ id: "vote", form: "8-K", class: "vote", filedAt: "2026-09-15", items: ["5.07"] });
  const all = items([...trades, earnings, deal, vote]);
  const persons = personsFromEvents(insiderFilings(all).map(item => item.event), NOW);
  const id = (owner: [string, string]) => personRowId(owner[0]);
  for (const filter of ["key", "all"] as const) {
    const rows = streamRows(railLayout(all, filter), [], null, filter, persons);
    // The pinned filing leads; the people follow by date, the deal between Magnetar (10.18) and Agarwal (10.15).
    const order = ["earn", id(INTRATOR), id(MAGNETAR), "deal", id(AGARWAL), id(MCBEE), "vote", id(BUYER)];
    assert.deepEqual(rows.map(r => r.id), filter === "all" ? order : order.filter(id => rows.some(r => r.id === id)), filter);
    assert.equal(rows.filter(r => r.kind === "person").length, 5, filter);
    // A person's row holds their filings of any age, so a trade in focus finds the row to open.
    const mcbee = rows.find(r => r.id === id(MCBEE))!;
    assert.ok(mcbee.kind === "person");
    assert.deepEqual(mcbee.kind === "person" && mcbee.items.map(item => item.id), ["c1", "old"]);
    assert.equal(mcbee.date, "2026-09-30");
  }
  // The Insiders reading is the people alone, latest trade first.
  assert.deepEqual(streamRows(railLayout(all, "insiders"), [], null, "insiders", persons).map(r => r.id), persons.map(p => personRowId(p.key)));
});

test("the latest earnings filing leads the rail, the people hold the trades, and nothing shows twice", () => {
  const earnings = event({ id: "earn", form: "8-K", class: "earnings", filedAt: "2026-08-11", items: ["2.02"] });
  const deal = event({ id: "deal", form: "8-K", class: "deal", filedAt: "2026-10-25", items: ["1.01"] });
  const all = items([...trades, earnings, deal]);
  for (const filter of ["key", "all"] as const) {
    const layout = railLayout(all, filter);
    assert.ok(layout.pinned && layout.pinned.kind === "item" && layout.pinned.item.id === "earn", filter);
    assert.equal(layout.insiders.length, 7, filter);
    const restIds = layout.rest.flatMap(rowLeaves).map(item => item.id);
    assert.ok(!restIds.includes("earn"));
    assert.ok(!restIds.some(id => layout.insiders.some(item => item.id === id)), filter);
  }
  // A trade older than the window lists through its person too, never as its own row.
  assert.ok(!railLayout(all, "all").rest.flatMap(rowLeaves).some(item => item.id === "old"));
  assert.ok(railLayout(all, "all").insiders.some(item => item.id === "old"));
  // The Insiders reading is the people alone; the other event readings get no people and no pin.
  const insiders = railLayout(all, "insiders");
  assert.equal(insiders.pinned, null);
  assert.equal(insiders.insiders.length, 7);
  assert.deepEqual(insiders.rest, []);
  for (const filter of ["earnings", "material"] as const) {
    const layout = railLayout(all, filter);
    assert.equal(layout.pinned, null);
    assert.deepEqual(layout.insiders, []);
  }
});

test("a 10-Q report outranks an older 8-K earnings release as the pinned filing", () => {
  const report = { accessionNumber: "q3", form: "10-Q", date: "2026-10-30", periodEnd: "2026-09-30", headline: "Quarter headline", sources: [] } as unknown as PublicFilingDigest;
  const release = event({ id: "earn", form: "8-K", class: "earnings", filedAt: "2026-08-11", items: ["2.02"] });
  const layout = railLayout(items([...trades, release], [report]), "key");
  assert.ok(layout.pinned && layout.pinned.kind === "item" && layout.pinned.item.id === "q3");
});
