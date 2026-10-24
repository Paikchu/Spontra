import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CompanyEvent, EventsPublication } from "../../../shared/analysis-contract/events.ts";
import type { PublicFilingDigestPage } from "../../../shared/analysis-contract/filings.ts";
import { eventImportance, filingDocumentTitle, indexPrimaryDescription, readEventsPublication } from "../../../shared/analysis-runtime/events.ts";
import { railEntries } from "../../../shared/analysis-runtime/rail.ts";
import { setLocale } from "../../../packages/web/src/i18n/core.ts";
import { eventTitle } from "../src/events-model.ts";
import { exactShares, filterCounts, noiseRows, readEventFilter, rowLeaves, timelineIds, withEventFilter } from "../src/event-noise.ts";
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
  assert.equal(eventImportance(sale(false)), "key");
  assert.equal(eventImportance(sale(true)), "routine");
  assert.equal(eventImportance(sale(false, 1000)), "key");
  const exercise = event({ id: "m", form: "4", class: "insider", filedAt: "2026-10-01", insider: { ...sale(false).insider!, sold: null, exercised: 1000 } });
  assert.equal(eventImportance(exercise), "normal");
  assert.equal(eventImportance(event({ id: "k", form: "6-K", class: "other", filedAt: "2026-05-01", description: "6-K" })), "routine");
  assert.equal(eventImportance(event({ id: "t", form: "6-K", class: "other", filedAt: "2026-05-01", description: "Monthly operating statistics" })), "normal");
});

test("planned sales by one person in one month fold, and the leaves are the filings", () => {
  const sale = (id: string, day: string, shares: number): CompanyEvent => event({
    id, form: "4", class: "insider", filedAt: day,
    insider: { ownerCik: "9", ownerName: "Olivan Javier", title: "COO", isDirector: false, isOfficer: true, isTenPercentOwner: false, rule10b51: true, planAdoptedOn: null, securityTitle: "Class A", lines: [], sold: { shares, proceeds: 0, averagePrice: 0 }, bought: null, exercised: 0, heldAfter: 1, footnotes: [] },
  });
  const publication: EventsPublication = { schemaVersion: "events.v1", ticker: "TEST", checkedAt: "2026-10-24T00:00:00Z", pendingInsider: 0, events: [sale("a", "2026-10-21", 1575), sale("b", "2026-10-14", 1575), sale("c", "2026-10-07", 1575), sale("d", "2026-09-30", 1575)] };
  const rows = noiseRows(railEntries(null, readEventsPublication(publication, "TEST")), "insiders");
  const folded = rows.find(row => row.kind === "plan");
  assert.ok(folded && folded.kind === "plan");
  assert.equal(folded.items.length, 3);
  assert.equal(folded.shares, 4725);
  assert.equal(rows.filter(row => row.kind === "item").length, 1);
  assert.equal(rows.flatMap(rowLeaves).length, 4);
  setLocale("en");
  assert.equal(exactShares(folded.shares), "4,725");
  setLocale("zh-CN");
  assert.equal(exactShares(folded.shares), "4,725");
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

test("META's Key list stays within 30 rows, keeps every earnings release and leadership change, and the axis stays within 40", () => {
  setLocale("zh-CN");
  const entries = railEntries(metaFilings, metaEvents);
  const counts = filterCounts(entries);
  const key = noiseRows(entries, "key");
  const all = noiseRows(entries, "all");
  const keyIds = new Set(key.flatMap(rowLeaves).map(item => item.id));
  const visible = (event: CompanyEvent) => keyIds.has(event.id) || entries.some(item => item.kind === "report" && keyIds.has(item.id) && item.report.sources.some(source => source.accessionNumber === event.id));
  assert.ok(counts.key <= 30, `key rows ${counts.key}`);
  assert.equal(metaEvents.events.filter(event => event.class === "earnings" && visible(event)).length, 9);
  assert.equal(metaEvents.events.filter(event => event.class === "executive" && keyIds.has(event.id)).length, 6);
  assert.equal(all.flatMap(rowLeaves).length, entries.length);
  const points = timelineFromFilings(metaFilings, metaEvents, 24, NOW);
  const ids = timelineIds(entries, "key");
  const keyPoints = points.filter(point => point.id.startsWith("report:") || ids.has(point.id));
  assert.ok(keyPoints.length <= 40, `key points ${keyPoints.length}`);
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
