import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CompanyEvent, EventsPublication } from "../../../shared/analysis-contract/events.ts";
import type { PublicFilingDigest, PublicFilingDigestPage } from "../../../shared/analysis-contract/filings.ts";
import type { VerifiedFinding } from "../../../shared/analysis-runtime/findings.ts";
import { setLocale } from "../../../packages/web/src/i18n/core.ts";
import { readEventsPublication } from "../../../shared/analysis-runtime/events.ts";
import { railEntries } from "../../../shared/analysis-runtime/rail.ts";
import { personRowId, railLayout, releasedPeriod, rowLeaves, streamRows, type EventFilter } from "../src/event-noise.ts";
import { personsFromEvents } from "../../../shared/analysis-runtime/insiders.ts";
import { RailStream } from "../src/RailStream.tsx";

// The rail reads the clock, so the CRWV-like fixture is dated from today.
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10);

const event = (extra: Partial<CompanyEvent> & Pick<CompanyEvent, "id" | "form" | "class" | "filedAt">): CompanyEvent => ({
  ticker: "CRWV", eventDate: extra.filedAt, items: [], description: "", title: null, importance: "normal",
  edgarUrl: "https://www.sec.gov/i", documentUrl: "https://www.sec.gov/d.htm", exhibits: [], summary: null, insider: null, ...extra,
});
const form4 = (id: string, day: string, [cik, name]: [string, string], sold: number, extra: { plan?: boolean; exercised?: number } = {}): CompanyEvent => event({
  id, form: "4", class: "insider", filedAt: day,
  insider: {
    ownerCik: cik, ownerName: name, title: "Chief Executive Officer", isDirector: false, isOfficer: true, isTenPercentOwner: false,
    rule10b51: !!extra.plan, planAdoptedOn: null, securityTitle: "Class A",
    lines: sold ? [{ date: day, code: "S", acquiredDisposed: "D", shares: sold / 100, price: 100, ownedAfter: 1, ownership: "D", derivative: false }]
      : extra.exercised ? [{ date: day, code: "M", acquiredDisposed: "A", shares: extra.exercised, price: null, ownedAfter: 1, ownership: "D", derivative: false }] : [],
    sold: sold ? { shares: sold / 100, proceeds: sold, averagePrice: 100 } : null, bought: null,
    exercised: extra.exercised ?? 0, heldAfter: 1, footnotes: [],
  },
});

const INTRATOR: [string, string] = ["1", "Intrator Michael"], MAGNETAR: [string, string] = ["2", "Magnetar Financial LLC"];
const AGARWAL: [string, string] = ["3", "Agarwal Nitin"], MCVEETY: [string, string] = ["4", "McVeety Chen"];
const WINDOW = [
  form4("intrator-1", ago(10), INTRATOR, 120_000_000, { plan: true }),
  form4("intrator-2", ago(20), INTRATOR, 110_000_000, { plan: true }),
  form4("intrator-3", ago(30), INTRATOR, 120_000_000, { plan: true }),
  form4("magnetar-1", ago(12), MAGNETAR, 530_000_000),
  form4("agarwal-1", ago(15), AGARWAL, 40_000_000, { plan: true }),
  // An option exercise with nothing sold: a Form 4 of the window that is not an open-market trade.
  form4("mcveety-exercise", ago(25), MCVEETY, 0, { exercised: 5_000 }),
];
// Older than the 90 days, like CRWV's Intrator sales of 07.30 and 07.23 seen on 11.01, and one older still.
const OLDER = [
  form4("intrator-0730", ago(94), INTRATOR, 95_000_000, { plan: true }),
  form4("intrator-0723", ago(101), INTRATOR, 85_000_000, { plan: true }),
  form4("intrator-old", ago(140), INTRATOR, 90_000_000),
];
const OLD = OLDER[2]!;
const OLDER_IDS = OLDER.map(e => e.id);
const EARNINGS = event({ id: "earnings-8k", form: "8-K", class: "earnings", filedAt: ago(80), items: ["2.02"], title: "Q2 results" });
const PERIOD_END = ago(80 + 42);
const finding = (id: string, severity: 1 | 2 | 3, title: string) => ({
  id, kind: "risk", severity, title, periodEnd: PERIOD_END, watchOutcome: null, anchors: { view: "profit", nodeIds: [], metrics: [] },
}) as unknown as VerifiedFinding;
const FINDINGS = [finding("f-backlog", 3, "Backlog concentration"), finding("f-capex", 2, "Capex outruns cash")];

const rail = (events: CompanyEvent[]) => {
  const publication: EventsPublication = { schemaVersion: "events.v1", ticker: "CRWV", checkedAt: NOW.toISOString(), pendingInsider: 0, events };
  return railEntries(null, readEventsPublication(publication, "CRWV"));
};
const ALL = rail([...WINDOW, ...OLDER, EARNINGS]);
const IN_WINDOW = WINDOW.map(e => e.id);
/** The people of a rail's filings, as the rail groups them before the ledger answers. */
const personsOf = (items: typeof ALL) => personsFromEvents(items.flatMap(item => item.kind === "event" && item.event.insider ? [item.event] : []), NOW);
const PERSONS = personsOf(ALL);
const PEOPLE = ["1", "2", "3", "4"].map(personRowId);

/** The ids the default list shows, a person counted as one row and folded rows left out. */
const listed = (filter: EventFilter, findings: VerifiedFinding[] = [], periodEnd: string | null = null) =>
  streamRows(railLayout(ALL, filter), findings, periodEnd, filter, PERSONS).flatMap(r => r.kind === "noise" ? rowLeaves(r.row).map(item => item.id) : [r.id]);

const render = (filter: EventFilter, focus: string | null = null, findings: VerifiedFinding[] = [], periodEnd: string | null = null) => renderToStaticMarkup(createElement(RailStream, {
  rail: { recent: ALL, earlier: [], quiet: 0, since: ago(90) }, findings, findingsPeriodEnd: periodEnd, ticker: "CRWV", updates: 0, focus,
  onFocusItem: () => {}, onFocusFinding: () => {}, filter,
}));

test("no Form 4 of any age lists as its own row; each person lists once, latest trade first", () => {
  for (const filter of ["key", "all"] as const) {
    const ids = listed(filter);
    assert.deepEqual(ids, ["earnings-8k", ...PEOPLE], filter);
    const rows = streamRows(railLayout(ALL, filter), [], null, filter, PERSONS);
    // The people hold every one of them, the exercise and the older sales included.
    assert.deepEqual(rows.flatMap(r => r.kind === "person" ? r.items.map(item => item.id) : []).sort(), [...IN_WINDOW, ...OLDER_IDS].sort(), filter);
  }
  const persons = PERSONS;
  // Latest trade first; Intrator's six sales, of any age, are one person with one net figure.
  assert.deepEqual(persons.map(p => [p.name, p.filings, p.sold.count]), [["Intrator Michael", 6, 6], ["Magnetar Financial LLC", 1, 1], ["Agarwal Nitin", 1, 1], ["McVeety Chen", 1, 0]]);
  assert.equal(persons[0]!.sold.value, 620_000_000);
  assert.equal(persons[0]!.latest!.date, ago(10));
  // The Insiders reading is the same people, alone.
  const insiders = streamRows(railLayout(ALL, "insiders"), [], null, "insiders", PERSONS);
  assert.deepEqual(insiders.map(r => r.id), PEOPLE);
});

test("a person's history renders only once their row is open, and a trade in focus opens it", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    setLocale(locale);
    const html = render("key");
    // No group row: each person is a row of the rail, after the pinned filing, latest trade first.
    assert.ok(!html.includes(locale === "en" ? "Insider trades" : "内部人交易"), locale);
    assert.ok(!html.includes("insider-card"));
    const at = (text: string) => html.indexOf(text);
    assert.ok(at("Q2 results") < at("Intrator Michael") && at("Intrator Michael") < at("Magnetar Financial LLC") && at("Agarwal Nitin") < at("McVeety Chen"), locale);
    // Every row is closed and no line of history is on the page.
    assert.ok(!html.includes('aria-expanded="true"'));
    assert.ok(!html.includes("insider-history"));
    assert.ok(!html.includes(ago(94)) && !html.includes(ago(140)), locale);
    assert.ok(html.includes(locale === "en" ? "Net sold" : "净卖出"), locale);
  }
  setLocale("en");
  // A trade in focus (picked on the time axis) opens the person who filed it, with their whole history from the rail.
  const open = render("key", "intrator-2");
  assert.ok(open.includes('aria-expanded="true" aria-controls="insider-1-panel"'));
  assert.ok(open.includes(ago(94)) && open.includes(ago(140)));
  assert.ok(open.includes('aria-pressed="true"'));
  assert.ok(open.includes("SEC filing ↗"));
  assert.ok(!open.includes('aria-expanded="true" aria-controls="insider-2-panel"'));
  assert.ok(render("key", "intrator-old").includes('aria-expanded="true" aria-controls="insider-1-panel"'));
});

test("one old filing still lists its person, below the newer rows, and never as its own row", () => {
  const items = rail([OLD, EARNINGS, event({ id: "deal", form: "8-K", class: "deal", filedAt: ago(5), items: ["1.01"] })]);
  const layout = railLayout(items, "all");
  assert.deepEqual(layout.insiders.map(item => item.id), ["intrator-old"]);
  assert.ok(!layout.rest.some(row => row.kind === "item" && row.item.id === "intrator-old"));
  assert.deepEqual(streamRows(layout, [], null, "all", personsOf(items)).map(r => r.id), ["earnings-8k", "deal", personRowId("1")]);
});

test("the pinned earnings 8-K carries its findings beneath it with severity icons", () => {
  for (const filter of ["key", "all"] as const) {
    assert.deepEqual(listed(filter, FINDINGS, PERIOD_END), ["earnings-8k", "f-backlog", "f-capex", ...PEOPLE], filter);
  }
  setLocale("en");
  const html = render("key", null, FINDINGS, PERIOD_END);
  const at = (text: string) => html.indexOf(text);
  assert.ok(at("Q2 results") >= 0 && at("Q2 results") < at("Backlog concentration") && at("Capex outruns cash") < at("Intrator Michael"));
  assert.ok(html.includes('class="severity-icon" data-severity="3" viewBox="0 0 16 16" role="img" aria-label="Severity: Major (highest of 3)"'));
  assert.ok(html.includes('data-severity="2"'));
});

test("findings of another quarter are never placed under the pinned filing, with or without insider rows", () => {
  const earlier = ago(80 + 42 + 182);
  assert.ok(!listed("key", FINDINGS, earlier).some(id => id.startsWith("f-")));
  assert.deepEqual(listed("key").slice(0, 2), ["earnings-8k", personRowId("1")]);
  assert.ok(!render("key", null, FINDINGS, earlier).includes("severity-icon"));
  // No insider filings at all: the next row after the pinned filing is still not a finding.
  const bare = rail([EARNINGS, event({ id: "deal", form: "8-K", class: "deal", filedAt: ago(5), items: ["1.01"] })]);
  const ids = streamRows(railLayout(bare, "all"), FINDINGS, earlier, "all").map(r => r.id);
  assert.deepEqual(ids, ["earnings-8k", "deal"]);
  // A rail with no filings at all still lists the findings.
  assert.deepEqual(streamRows(railLayout([], "key"), FINDINGS, earlier, "key").map(r => r.id), ["f-backlog", "f-capex"]);
});

// The quarter a release reports, on fixed dates: CRWV's 8-K of 2026-08-11 reports the quarter that ended 2026-06-30.
const FIXED = new Date("2026-11-01T00:00:00Z");
const release = (id: string, day: string) => event({ id, form: "8-K", class: "earnings", filedAt: day, items: ["2.02", "9.01"], title: "Results of Operations" });
const quarterRows = (events: CompanyEvent[], periodEnd: string, filter: EventFilter = "key") =>
  streamRows(railLayout(rail(events), filter), FINDINGS, periodEnd, filter, personsOf(rail(events))).map(r => r.id);

test("an earnings 8-K carries the findings of the quarter it reports, matched by quarter not by filing date", () => {
  const q2 = release("crwv-0811", "2026-08-11");
  const trades = [form4("t1", "2026-10-20", INTRATOR, 1_000_000), form4("t2", "2026-07-30", INTRATOR, 1_000_000)];
  assert.equal(releasedPeriod(rail([q2])[0]!, rail([q2]), "2026-06-30"), "2026-06-30");
  // The anchor may be any quarter of the grid: a year back or ahead still dates the 08.11 release to 06.30.
  assert.equal(releasedPeriod(rail([q2])[0]!, rail([q2]), "2025-06-30"), "2026-06-30");
  assert.equal(releasedPeriod(rail([q2])[0]!, rail([q2]), "2026-12-31"), "2026-06-30");
  assert.deepEqual(quarterRows([q2, ...trades], "2026-06-30").slice(0, 4), ["crwv-0811", "f-backlog", "f-capex", personRowId("1")]);
  assert.deepEqual(quarterRows([q2], "2026-06-30"), ["crwv-0811", "f-backlog", "f-capex"]);
  // A 52/53-week quarter ending a couple of days off the month's end is the same quarter.
  assert.deepEqual(quarterRows([q2], "2026-06-28"), ["crwv-0811", "f-backlog", "f-capex"]);
  // Findings of the quarter before or after: nothing extra under the release, insider rows or none.
  for (const periodEnd of ["2026-03-31", "2026-09-30"]) {
    assert.deepEqual(quarterRows([q2, ...trades], periodEnd), ["crwv-0811", personRowId("1")], periodEnd);
    assert.deepEqual(quarterRows([q2], periodEnd), ["crwv-0811"], periodEnd);
  }
});

test("a release filed within 100 days of a quarter's end but after the next one ended reports the later quarter", () => {
  const q3 = release("q3-release", "2026-10-08");
  assert.equal(releasedPeriod(rail([q3])[0]!, rail([q3]), "2026-06-30"), "2026-09-30");
  assert.deepEqual(quarterRows([q3], "2026-06-30"), ["q3-release"]);
  assert.deepEqual(quarterRows([q3], "2026-09-30"), ["q3-release", "f-backlog", "f-capex"]);
});

test("findings follow their own quarter's release, not the later one pinned above it", () => {
  const q1 = release("q1-release", "2026-05-14"), q2 = release("q2-release", "2026-08-11");
  // With Q1's release listed, the 08.11 one reports Q2; Q1's findings sit under the 05.14 release in All.
  assert.deepEqual(quarterRows([q1, q2], "2026-03-31", "all"), ["q2-release", "q1-release", "f-backlog", "f-capex"]);
  assert.deepEqual(quarterRows([q1, q2], "2026-06-30", "all"), ["q2-release", "f-backlog", "f-capex", "q1-release"]);
  // A second results release for a quarter that already had one is not that quarter's release.
  const update = release("q2-update", "2026-09-02");
  assert.equal(releasedPeriod(rail([update, q2])[0]!, rail([update, q2]), "2026-06-30"), null);
  // A listed report's period counts as a quarter end too.
  const report = { accessionNumber: "q2-10q", form: "10-Q", date: "2026-08-12", periodEnd: "2026-06-30", headline: "Q2", sources: [] } as unknown as PublicFilingDigest;
  const items = railEntries({ filings: [report], nextCursor: null } as unknown as PublicFilingDigestPage, readEventsPublication({ schemaVersion: "events.v1", ticker: "CRWV", checkedAt: FIXED.toISOString(), pendingInsider: 0, events: [q2] }, "CRWV"));
  assert.equal(releasedPeriod(items.find(item => item.id === "q2-release")!, items, null), "2026-06-30");
});
