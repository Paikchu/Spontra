import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CompanyEvent, EventsPublication } from "../../../shared/analysis-contract/events.ts";
import type { PublicFilingDigestPage } from "../../../shared/analysis-contract/filings.ts";
import { isTaxWithholdingSale, eventImportance, insiderWindowValueUsd, isKeyInsiderRole, isEsppTransaction, isPlannedSale, isPlannedInsiderTrade, isOpenMarketInsiderTrade, filingDocumentTitle, indexPrimaryDescription, readEventsPublication } from "../../../shared/analysis-runtime/events.ts";
import { railEntries } from "../../../shared/analysis-runtime/rail.ts";
import { setLocale } from "../../../packages/web/src/i18n/core.ts";
import { eventTitle } from "../src/events-model.ts";
import { insiderCompactMoney, insiderNetSummary, exactShares, filterCounts, noiseRows, readEventFilter, rowLeaves, timelineIds, withEventFilter } from "../src/event-noise.ts";
import { timelineFromFilings } from "../src/reports-model.ts";
import { clusterByGap } from "../src/timeline-model.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const metaEvents = readEventsPublication(fixture("meta-events.json"), "META")!;
const tsmEvents = readEventsPublication(fixture("tsm-events.json"), "TSM")!;
const metaFilings = fixture("meta-filings.json") as PublicFilingDigestPage;
const NOW = new Date("2026-10-24T00:00:00Z");

const event = (extra: Partial<CompanyEvent> & Pick<CompanyEvent, "id" | "form" | "class" | "filedAt">): CompanyEvent => ({
  ticker: "TEST", eventDate: extra.filedAt, items: [], description: "", title: null, importance: "normal",
  edgarUrl: "https://www.sec.gov/i", documentUrl: "https://www.sec.gov/d.htm", exhibits: [], summary: null, insider: null, ...extra,
});

test("a document title is the filing index description, never the form name or EDGAR's generic label", () => {
  assert.equal(filingDocumentTitle({ description: "6-K" }), null);
  assert.equal(filingDocumentTitle({ description: "8-K/A" }), null);
  assert.equal(filingDocumentTitle({ description: "PRIMARY DOCUMENT" }), null);
  assert.equal(filingDocumentTitle({ description: "Results of Operations" }), "Results of Operations");
  assert.equal(indexPrimaryDescription(`<table><tr><td>Seq</td><td>Description</td><td>Document</td><td>Type</td></tr><tr><td>1</td><td>6-K</td><td>a.htm</td><td>6-K</td></tr></table>`), null);
  assert.equal(indexPrimaryDescription(`<table><tr><td>1</td><td>Monthly operating statistics</td><td>a.htm</td><td>6-K</td></tr></table>`), "Monthly operating statistics");
});

test("importance follows the rail rules and does not call a model", () => {
  const sale = (plan: boolean | null, exercised = 0): CompanyEvent => event({
    id: "1", form: "4", class: "insider", filedAt: "2026-10-14",
    insider: { ownerCik: "1", ownerName: "Olivan Javier", title: "COO", isDirector: false, isOfficer: true, isTenPercentOwner: false, rule10b51: plan, planAdoptedOn: null, securityTitle: "Class A", lines: [], sold: { shares: 1575, proceeds: 0, averagePrice: 0 }, bought: null, exercised, heldAfter: 10, footnotes: [] },
  });
  assert.equal(eventImportance(event({ id: "e", form: "8-K", class: "earnings", filedAt: "2026-10-01", items: ["2.02"] })), "key");
  assert.equal(eventImportance(event({ id: "x", form: "8-K", class: "executive", filedAt: "2026-10-01", items: ["5.02"] })), "key");
  assert.equal(eventImportance(event({ id: "v", form: "8-K", class: "vote", filedAt: "2026-10-01", items: ["5.07"] })), "key");
  assert.equal(eventImportance(event({ id: "s", form: "8-K", class: "other", filedAt: "2026-10-01", summary: { headline: "Notes priced", bullets: [], analystView: "", eventCategory: "other", generatedAt: "2026-10-01T00:00:00Z" } })), "key");
  assert.equal(eventImportance(sale(false)), "routine");
  assert.equal(eventImportance(sale(true)), "routine");
  assert.equal(eventImportance(sale(false, 1000)), "routine");
  const exercise = event({ id: "m", form: "4", class: "insider", filedAt: "2026-10-01", insider: { ...sale(false).insider!, sold: null, exercised: 1000 } });
  assert.equal(eventImportance(exercise), "routine");
  assert.equal(eventImportance(event({ id: "k", form: "6-K", class: "other", filedAt: "2026-05-01", description: "6-K" })), "routine");
  assert.equal(eventImportance(event({ id: "t", form: "6-K", class: "other", filedAt: "2026-05-01", description: "Monthly operating statistics" })), "normal");
});

test("sales by one person across months fold, and the leaves are the filings", () => {
  const sale = (id: string, day: string, shares: number): CompanyEvent => event({
    id, form: "4", class: "insider", filedAt: day,
    insider: { ownerCik: "9", ownerName: "Olivan Javier", title: "COO", isDirector: false, isOfficer: true, isTenPercentOwner: false, rule10b51: true, planAdoptedOn: null, securityTitle: "Class A", lines: [], sold: { shares, proceeds: 0, averagePrice: 0 }, bought: null, exercised: 0, heldAfter: 1, footnotes: [] },
  });
  const publication: EventsPublication = { schemaVersion: "events.v1", ticker: "TEST", checkedAt: "2026-10-24T00:00:00Z", pendingInsider: 0, events: [sale("a", "2026-10-21", 1575), sale("b", "2026-10-14", 1575), sale("c", "2026-10-07", 1575), sale("d", "2026-09-30", 1575)] };
  const rows = noiseRows(railEntries(null, readEventsPublication(publication, "TEST")), "insiders");
  const folded = rows.find(row => row.kind === "plan");
  assert.ok(folded && folded.kind === "plan");
  assert.equal(folded.items.length, 4);
  assert.equal(folded.shares, 6300);
  assert.equal(rows.filter(row => row.kind === "item").length, 0);
  assert.equal(rows.flatMap(rowLeaves).length, 4);
  setLocale("en");
  assert.equal(exactShares(folded.shares), "6,300");
  setLocale("zh-CN");
  assert.equal(exactShares(folded.shares), "6,300");
});

test("routine 6-Ks group by month, including a month with one filing, and a real title stays its own row", () => {
  setLocale("zh-CN");
  const six = (id: string, day: string, description: string): CompanyEvent => event({ id, form: "6-K", class: "other", filedAt: day, description });
  const publication: EventsPublication = { schemaVersion: "events.v1", ticker: "TEST", checkedAt: "2026-10-24T00:00:00Z", pendingInsider: 0, events: [six("a", "2026-05-20", "6-K"), six("b", "2026-05-02", "6-K"), six("c", "2026-04-01", "6-K"), six("d", "2026-03-01", "Monthly operating statistics")] };
  const rows = noiseRows(railEntries(null, readEventsPublication(publication, "TEST")), "all");
  assert.deepEqual(rows.map(row => row.kind === "routine" ? row.items.length : eventTitle(row.kind === "item" && row.item.kind === "event" ? row.item.event : six("x", "2026-01-01", "6-K"))), [2, 1, "Monthly operating statistics"]);
  assert.equal(rows.flatMap(rowLeaves).length, 4);
  for (const row of rows) {
    if (row.kind !== "item" || row.item.kind !== "event") continue;
    const title = eventTitle(row.item.event);
    assert.notEqual(title, "其他");
    assert.notEqual(title, "其他 · 6-K");
  }
});

test("the filter is in the query, and Key is the value a shared link names", () => {
  assert.equal(readEventFilter(""), "key");
  assert.equal(readEventFilter("?events=insiders"), "insiders");
  assert.equal(readEventFilter("?events=nope"), "key");
  assert.equal(withEventFilter("?lang=zh-CN", "key"), "?lang=zh-CN&events=key");
  assert.equal(readEventFilter(withEventFilter("?view=cash", "all")), "all");
});

test("clusters measure from the first point, so a dense run cannot swallow the axis", () => {
  const points = [0, 10, 20, 40].map(x => ({ id: String(x), x }));
  const clusters = clusterByGap(points, point => point.x, 16);
  assert.deepEqual(clusters.map(cluster => cluster.items.map(item => item.x)), [[0, 10], [20], [40]]);
});

test("META's Key list keeps earnings, leadership and material trades with matching timeline leaves", () => {
  setLocale("zh-CN");
  const entries = railEntries(metaFilings, metaEvents);
  const counts = filterCounts(entries);
  const key = noiseRows(entries, "key");
  const all = noiseRows(entries, "all");
  const keyIds = new Set(key.flatMap(rowLeaves).map(item => item.id));
  const visible = (event: CompanyEvent) => keyIds.has(event.id) || entries.some(item => item.kind === "report" && keyIds.has(item.id) && item.report.sources.some(source => source.accessionNumber === event.id));
  assert.equal(counts.key, key.length);
  assert.ok(counts.key < counts.all);
  assert.equal(metaEvents.events.filter(event => event.class === "earnings" && visible(event)).length, 9);
  assert.equal(metaEvents.events.filter(event => event.class === "executive" && keyIds.has(event.id)).length, 6);
  assert.equal(all.flatMap(rowLeaves).length, entries.length);
  const points = timelineFromFilings(metaFilings, metaEvents, 24, NOW);
  const ids = timelineIds(entries, "key");
  const keyPoints = points.filter(point => point.id.startsWith("report:") || ids.has(point.id));
  assert.ok(keyPoints.every(point => point.id.startsWith("report:") || keyIds.has(point.id)));
  assert.ok(keyPoints.length > 0);
});

test("TSM has no bare 其他 row, and All still reaches every listed filing inside the folds", () => {
  setLocale("zh-CN");
  const entries = railEntries(null, tsmEvents);
  const rows = noiseRows(entries, "all");
  const bare = ["其他", "其他 · 6-K", "Other", "Other · 6-K"];
  for (const row of rows) {
    if (row.kind === "routine") {
      assert.ok(row.items.length >= 1);
      assert.ok(row.items.every(item => item.kind === "event" && item.event.form.startsWith("6-K")));
      continue;
    }
    if (row.kind !== "item" || row.item.kind !== "event") continue;
    assert.equal(bare.includes(eventTitle(row.item.event)), false, eventTitle(row.item.event));
  }
  assert.equal(rows.flatMap(rowLeaves).length, entries.length);
  const routineFilings = tsmEvents.events.filter(event => event.form.startsWith("6-K") && eventImportance(event) === "routine");
  assert.equal(routineFilings.length, 80);
  assert.equal(rows.filter(row => row.kind === "routine").flatMap(row => row.kind === "routine" ? row.items : []).length, 80);
});


const trade = (id: string, date: string, amount = 600_000, title = "VP"): CompanyEvent => event({
  id, form: "4", class: "insider", filedAt: date,
  insider: { ownerCik: "9", ownerName: "Example Owner", title, isDirector: false, isOfficer: true, isTenPercentOwner: false, rule10b51: false, planAdoptedOn: null, securityTitle: "Common stock", lines: [], sold: { shares: 1000, proceeds: amount, averagePrice: amount / 1000 }, bought: null, exercised: 0, heldAfter: 5000, footnotes: [] },
});
const entriesOf = (events: CompanyEvent[]) => railEntries(null, { schemaVersion: "events.v1", ticker: "TEST", checkedAt: NOW.toISOString(), pendingInsider: 0, events });

test("materiality sums unique filings within 30 days, excluding employee purchases and other owners", () => {
  const a = trade("a", "2026-10-01"), b = trade("b", "2026-10-31");
  assert.equal(eventImportance(a), "routine");
  assert.equal(insiderWindowValueUsd(a, [a, a, b]), 1_200_000);
  assert.equal(eventImportance(a, [a, b]), "key");
  assert.equal(eventImportance(b, [a, b]), "key");
  assert.equal(eventImportance(a, [a, trade("c", "2026-11-01")]), "routine");
  b.insider!.ownerCik = "10";
  assert.equal(eventImportance(a, [a, b]), "routine");
  b.insider!.ownerCik = "9";
  b.insider!.sold = null;
  b.insider!.bought = { shares: 1000, cost: 600_000, averagePrice: 600 };
  b.insider!.footnotes = ["Employee stock purchase plan"];
  assert.equal(eventImportance(a, [a, b]), "routine");
  const publication = readEventsPublication({ schemaVersion: "events.v1", ticker: "TEST", checkedAt: NOW.toISOString(), pendingInsider: 0, events: [a, trade("d", "2026-10-30")] }, "TEST")!;
  assert.ok(publication.events.every(e => e.importance === "key"));
});

test("key roles override value only for non-ESPP open-market trades", () => {
  for (const title of ["CEO", "chief executive officer", "CFO", "Chief Financial Officer", "Chairman", "Chairwoman", "Chairperson", "President", "Co-President", "SVP and CFO", "Chairman and CEO"]) {
    assert.equal(isKeyInsiderRole(title), true, title);
    const e = trade("a", "2026-10-01", 10, title);
    assert.equal(eventImportance(e), "key");
    e.insider!.sold = null;
    e.insider!.bought = { shares: 10, cost: 10, averagePrice: 1 };
    e.title = "ESPP purchase";
    assert.equal(eventImportance(e), "routine");
  }
  for (const title of [null, undefined, "Vice President", "Executive Vice-President", "VP", "SVP", "EVP", "Director", "COO"]) assert.equal(isKeyInsiderRole(title), false, String(title));
  for (const code of ["A", "F", "G", "M"] as const) {
    const e = trade(code, "2026-10-01", 2_000_000, "CEO");
    e.insider!.sold = null;
    e.insider!.exercised = code === "M" ? 1000 : 0;
    e.insider!.lines = [{ date: e.eventDate, code, acquiredDisposed: "A", shares: 1000, price: 100, ownedAfter: 5000, ownership: "D", derivative: false }];
    assert.equal(isOpenMarketInsiderTrade(e), null);
    assert.equal(eventImportance(e), "routine");
  }
});

test("text detection and mixed filings preserve both value legs", () => {
  const e = trade("a", "2026-10-01");
  e.insider!.footnotes = ["Pursuant to Rule 10b5-1"];
  assert.equal(isPlannedInsiderTrade(e), true);
  assert.equal(isPlannedSale(e), true);
  e.insider!.bought = { shares: 2000, cost: 700_000, averagePrice: 350 };
  assert.equal(isOpenMarketInsiderTrade(e), "buy");
  assert.equal(insiderWindowValueUsd(e), 1_300_000);
  e.insider!.securityTitle = "ESPP common stock";
  assert.equal(isEsppTransaction(e), false);
  assert.equal(insiderWindowValueUsd(e), 1_300_000);
  e.insider!.sold = null;
  assert.equal(isEsppTransaction(e), true);
  assert.equal(insiderWindowValueUsd(e), 0);
});

test("TSM employee purchases and routine 6-Ks leave Key empty and remain folded in other filters", () => {
  const entries = railEntries(null, tsmEvents);
  assert.equal(filterCounts(entries).key, 0);
  assert.ok(tsmEvents.events.every(e => eventImportance(e, tsmEvents.events) === "routine"));
  for (const filter of ["all", "insiders"] as const) {
    const rows = noiseRows(entries, filter);
    assert.ok(rows.some(row => row.kind === "plan" && row.espp));
    assert.equal(rows.flatMap(rowLeaves).length, filter === "all" ? entries.length : entries.filter(i => i.kind === "event" && i.event.class === "insider").length);
  }
  assert.equal(insiderNetSummary(entries)!.hasMaterialTrades, false);
});

test("NVDA September sales fold into one material 90-day row while pure non-trades stay routine", () => {
  const publication = readEventsPublication(fixture("nvda-events.json"), "NVDA")!;
  const rows = noiseRows(railEntries(null, publication), "key");
  const row = rows.find(row => row.kind === "plan" && row.name === "STEVENS MARK A" && row.date === "2026-09-22");
  assert.ok(row?.kind === "plan");
  assert.deepEqual(row.items.map(i => i.date), ["2026-09-22", "2026-09-08", "2026-09-02"]);
  assert.equal(row.direction, "sell");
  assert.equal(insiderCompactMoney(row.amount, "zh-CN"), "9.5亿美元");
  assert.equal(insiderCompactMoney(-row.amount, "zh-CN"), "−9.5亿美元");
  assert.equal(insiderCompactMoney(row.amount, "en"), "$950M");
  assert.ok(row.items.every(i => i.kind === "event" && eventImportance(i.event, publication.events) === "key"));
  for (const e of publication.events.filter(e => e.class === "insider" && !isOpenMarketInsiderTrade(e))) assert.equal(eventImportance(e, publication.events), "routine");
});

test("folds are anchored, direction-specific, ordered and retain singleton filings", () => {
  const a = trade("a", "2026-10-01"), b = trade("b", "2026-07-03"), c = trade("c", "2026-07-02");
  const buy = trade("buy", "2026-09-30");
  buy.insider!.sold = null;
  buy.insider!.bought = { shares: 100, cost: 100, averagePrice: 1 };
  const rows = noiseRows(entriesOf([c, buy, b, a]), "insiders");
  assert.equal(rows[0].kind, "plan");
  assert.equal(rowLeaves(rows[0]).length, 2);
  assert.deepEqual(rows.map(r => r.date), [a.filedAt, buy.filedAt, c.filedAt]);
  assert.equal(rows.flatMap(rowLeaves).length, 4);
});

test("net summary counts unique people and both legs, excludes ESPP and old trades", () => {
  const sell = trade("sell", "2026-10-01", 2_000_000);
  const buy = trade("buy", "2026-10-02", 0, "CEO");
  buy.insider!.ownerCik = "10";
  buy.insider!.sold = null;
  buy.insider!.bought = { shares: 1000, cost: 500_000, averagePrice: 500 };
  const espp = trade("espp", "2026-10-03", 9_000_000);
  espp.insider!.sold = null;
  espp.insider!.bought = { shares: 1000, cost: 9_000_000, averagePrice: 9000 };
  espp.description = "ESPP";
  const entries = entriesOf([sell, buy, espp, trade("old", "2025-01-01")]);
  assert.deepEqual(insiderNetSummary(entries), { buyAmount: 500_000, sellAmount: 2_000_000, netAmount: -1_500_000, buyers: 1, sellers: 1, hasMaterialTrades: true });
  assert.equal(insiderNetSummary(entries, new Date("2027-10-01"))!.hasMaterialTrades, false);
  assert.equal(insiderNetSummary([]), null);
  assert.equal(insiderNetSummary(entriesOf([trade("small", "2026-10-01", 10)]))!.hasMaterialTrades, false);
  assert.equal(insiderCompactMoney(946_627_633.26, "zh-CN"), "9.5亿美元");
  assert.equal(insiderCompactMoney(-946_627_633.26, "en"), "−$950M");
});

test("NVDA holdings ESPP and code F footnotes preserve cash sales and the 90-day summary", () => {
  const publication = readEventsPublication(fixture("nvda-events.json"), "NVDA")!;
  for (const id of ["0001588670-26-000014", "0001526111-26-000005"]) {
    const e = publication.events.find(e => e.id === id)!;
    assert.equal(isEsppTransaction(e), false);
    assert.equal(isTaxWithholdingSale(e), false);
  }
  const kress = publication.events.find(e => e.id === "0001588670-26-000014")!;
  assert.equal(eventImportance(kress, publication.events), "key");
  const summary = insiderNetSummary(railEntries(null, publication))!;
  assert.equal(summary.sellers, 3);
  // The checked-in SEC fixture totals $967,599,313.46 across these three sellers.
  assert.ok(Math.abs(summary.sellAmount - 967_599_313.4595) < 0.0001);
});

test("ESPP requires a pure purchase and ignores indexed holdings notes in every text source", () => {
  const e = trade("espp", "2026-10-01");
  e.insider!.sold = null;
  e.insider!.bought = { shares: 100, cost: 100, averagePrice: 1 };
  for (const prefix of ["", "(1) ", "2. ", "3) "]) {
    const text = `${prefix}Includes 127 shares purchased under the Employee Stock Purchase Plan`;
    e.insider!.footnotes = [text];
    e.description = text;
    e.title = text;
    e.summary = { headline: text, points: [text] } as CompanyEvent["summary"];
    assert.equal(isEsppTransaction(e), false);
  }
  e.summary = { headline: "Purchase", points: ["Purchased under the Employee Stock Purchase Plan"] } as CompanyEvent["summary"];
  assert.equal(isEsppTransaction(e), true);
  e.insider!.bought = null;
  assert.equal(isEsppTransaction(e), false);
});

test("only company presidents and executive or chair roles qualify by title", () => {
  for (const title of ["President C&C", "President, A&D C4Isr", "President, AMI&I Business Unit", "President of Operations", "President - Operations", "President A&D Radar Systems", "Division President", "Regional President", "Group President", "Sector President", "Unit President", "Market President", "BU President", "EVP, A&D Sector President", "President and SVP"]) {
    assert.equal(isKeyInsiderRole(title), false, title);
    assert.equal(eventImportance(trade(title, "2026-10-01", 100_000, title)), "routine");
  }
  for (const title of ["President", "President.", "Co-President", "President and CEO", "President & COO", "President & Chief Operating Officer", "President and Director", "董事长", "董事会主席", "首席执行官", "首席财务官"]) assert.equal(isKeyInsiderRole(title), true, title);
});

const taxNote = "Represents the sale of shares, pursuant to a 10b5-1 trading plan adopted previously, solely to pay the tax liability incident to the vesting of RSUs.";
test("vesting sell-to-cover is routine and excluded from windows and net activity", () => {
  const tax = trade("tax", "2026-10-01", 2_000_000, "CEO");
  tax.insider!.footnotes = [taxNote];
  assert.equal(isTaxWithholdingSale(tax), true);
  assert.equal(eventImportance(tax), "routine");
  assert.equal(insiderWindowValueUsd(tax), 0);
  const cash = trade("cash", "2026-10-02", 300_000);
  assert.equal(insiderWindowValueUsd(cash, [cash, tax]), 300_000);
  assert.equal(insiderNetSummary(entriesOf([tax, cash]))!.sellAmount, 300_000);
  tax.insider!.footnotes = [];
  tax.summary = { headline: taxNote, points: [] } as CompanyEvent["summary"];
  assert.equal(isTaxWithholdingSale(tax), true);
  for (const note of ["Second reporting line represents the sale of shares under a plan to sell shares for cash.", "Represents the sale of shares in open market."]) {
    tax.insider!.footnotes = [note];
    assert.equal(isTaxWithholdingSale(tax), false);
  }
  tax.summary = null;
  tax.insider!.footnotes = ["Represents shares withheld by the Issuer to satisfy taxes upon vesting."];
  assert.equal(isTaxWithholdingSale(tax), false);
  tax.insider!.sold = null;
  tax.insider!.bought = { shares: 1, cost: 10, averagePrice: 10 };
  tax.insider!.footnotes = [taxNote];
  assert.equal(isTaxWithholdingSale(tax), false);
});

test("materiality uses a contiguous inclusive 30-day window containing each trade", () => {
  const events = [trade("a", "2025-05-13", 295_000), trade("b", "2025-06-09", 300_000), trade("c", "2025-06-25", 415_000)];
  assert.deepEqual(events.map(e => insiderWindowValueUsd(e, events)), [595_000, 715_000, 715_000]);
  assert.ok(events.every(e => eventImportance(e, events) === "routine"));
  events.push(trade("d", "2025-06-12", 300_000));
  assert.equal(eventImportance(events[0], events), "routine");
  assert.ok(events.slice(1).every(e => eventImportance(e, events) === "key"));
  assert.equal(insiderWindowValueUsd(events[0], events, 27), 595_000);
});
