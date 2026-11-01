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
import { railLayout, releasedPeriod, rowLeaves, streamRows, type EventFilter } from "../src/event-noise.ts";
import { InsiderSummaryCard, RailStream } from "../src/RailStream.tsx";

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
    rule10b51: !!extra.plan, planAdoptedOn: null, securityTitle: "Class A", lines: [],
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
/** The rail's MM.DD date, as a row's meta line starts. */
const shortDay = (day: string) => `${day.slice(5, 7)}.${day.slice(8, 10)}`;

/** The ids the default list shows, the card counted as one row and its folded rows left out. */
const listed = (filter: EventFilter, findings: VerifiedFinding[] = [], periodEnd: string | null = null) =>
  streamRows(railLayout(ALL, filter, NOW), findings, periodEnd, filter).flatMap(r => r.kind === "noise" ? rowLeaves(r.row).map(item => item.id) : [r.id]);

const render = (filter: EventFilter, focus: string | null = null, findings: VerifiedFinding[] = [], periodEnd: string | null = null) => renderToStaticMarkup(createElement(RailStream, {
  rail: { recent: ALL, earlier: [], quiet: 0, since: ago(90) }, findings, findingsPeriodEnd: periodEnd, ticker: "CRWV", updates: 0, focus,
  onFocusItem: () => {}, onFocusFinding: () => {}, filter,
}));

test("with the insider card shown, no Form 4 of any age lists outside it; its figures stay the 90 days", () => {
  for (const filter of ["key", "all"] as const) {
    const ids = listed(filter);
    assert.deepEqual(ids.slice(0, 2), ["earnings-8k", "insider-summary"], filter);
    assert.ok(!ids.some(id => IN_WINDOW.includes(id) || OLDER_IDS.includes(id)), filter);
    const summary = railLayout(ALL, filter, NOW).summary!;
    // The card holds every one of them, the exercise and the older sales included, but sums only the window's trades.
    assert.deepEqual(summary.items.map(item => item.id).sort(), [...IN_WINDOW, ...OLDER_IDS].sort(), filter);
    assert.equal(summary.sold, 920_000_000);
    assert.equal(summary.people.length, 3);
  }
  // No card in the Insiders reading: its per-person rows list as before.
  const insiders = streamRows(railLayout(ALL, "insiders", NOW), [], null, "insiders");
  assert.ok(!insiders.some(r => r.kind === "insiders"));
  assert.ok(insiders.flatMap(r => r.kind === "noise" ? rowLeaves(r.row).map(item => item.id) : []).includes("intrator-1"));
});

test("the card's trade rows render only behind Show all, and collapse again", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    setLocale(locale);
    const html = render("key");
    assert.ok(html.includes(locale === "en" ? "Show all 3" : "展开全部 3 人"));
    assert.ok(html.includes('aria-expanded="false"'));
    assert.ok(!html.includes(locale === "en" ? "Sold 4 times in 90 days" : "90 天内卖出 4 笔"), locale);
    assert.ok(!html.includes("Open-market sale") && !html.includes("公开市场卖出"));
    assert.ok(!OLDER_IDS.some(id => html.includes(id)) && !html.includes(shortDay(ago(94))) && !html.includes(shortDay(ago(140))), locale);
  }
  setLocale("en");
  const summary = railLayout(ALL, "all", NOW).summary!;
  const card = (open: boolean) => renderToStaticMarkup(createElement(InsiderSummaryCard, {
    summary, ticker: "CRWV", open, openRows: new Set<string>(), focus: null,
    motion: { layout: false, layoutDependency: "", exit: {} as never }, onToggle: () => {}, onFocus: () => {}, tip: () => ({}),
  }));
  const open = card(true), closed = card(false);
  assert.ok(open.includes('aria-expanded="true"') && open.includes("Show less"));
  assert.ok(open.includes("McVeety Chen"));
  // Show all reveals the older sales as well, folded per person over 90 days as the Insiders reading folds them.
  const folds = summary.rows.filter(row => row.kind === "plan" && row.name === "Intrator Michael").map(row => rowLeaves(row).map(item => item.id));
  assert.deepEqual(folds, [["intrator-1", "intrator-2", "intrator-3", "intrator-0730"], ["intrator-0723", "intrator-old"]]);
  assert.ok(open.includes("Sold 4 times in 90 days") && open.includes("Sold 2 times in 90 days"));
  assert.ok(!closed.includes("Sold 4 times") && !closed.includes("Sold 2 times"));
  assert.ok(closed.includes('aria-expanded="false"') && closed.includes("Show all 3"));
  assert.ok(!closed.includes("Sold 3 times in 90 days"));
  assert.ok(!closed.includes("McVeety Chen"));
  // A trade in focus (picked on the time axis) opens the card on its own.
  assert.ok(render("key", "intrator-2").includes("Sold 4 times in 90 days"));
  assert.ok(render("key", "intrator-old").includes("Sold 2 times in 90 days"));
});

test("without trades in the window there is no card and the trades list as before", () => {
  const layout = railLayout(rail([OLD, EARNINGS]), "all", NOW);
  assert.equal(layout.summary, null);
  assert.ok(layout.rest.some(row => row.kind === "item" && row.item.id === "intrator-old"));
});

test("the pinned earnings 8-K carries its findings beneath it with severity icons", () => {
  for (const filter of ["key", "all"] as const) {
    assert.deepEqual(listed(filter, FINDINGS, PERIOD_END).slice(0, 4), ["earnings-8k", "f-backlog", "f-capex", "insider-summary"], filter);
  }
  setLocale("en");
  const html = render("key", null, FINDINGS, PERIOD_END);
  const at = (text: string) => html.indexOf(text);
  assert.ok(at("Q2 results") >= 0 && at("Q2 results") < at("Backlog concentration") && at("Capex outruns cash") < at("Insiders, 90 days"));
  assert.ok(html.includes('class="severity-icon" data-severity="3" viewBox="0 0 16 16" role="img" aria-label="Severity: Major (highest of 3)"'));
  assert.ok(html.includes('data-severity="2"'));
});

test("findings of another quarter are never placed under the pinned filing, with or without the card", () => {
  const earlier = ago(80 + 42 + 182);
  assert.ok(!listed("key", FINDINGS, earlier).some(id => id.startsWith("f-")));
  assert.deepEqual(listed("key").slice(0, 2), ["earnings-8k", "insider-summary"]);
  assert.ok(!render("key", null, FINDINGS, earlier).includes("severity-icon"));
  // No card: the next row after the pinned filing is still not a finding.
  const bare = rail([OLD, EARNINGS]);
  const ids = streamRows(railLayout(bare, "all", NOW), FINDINGS, earlier, "all").map(r => r.id);
  assert.deepEqual(ids, ["earnings-8k", "intrator-old"]);
  // A rail with no filings at all still lists the findings.
  assert.deepEqual(streamRows(railLayout([], "key", NOW), FINDINGS, earlier, "key").map(r => r.id), ["f-backlog", "f-capex"]);
});

// The quarter a release reports, on fixed dates: CRWV's 8-K of 2026-08-11 reports the quarter that ended 2026-06-30.
const FIXED = new Date("2026-11-01T00:00:00Z");
const release = (id: string, day: string) => event({ id, form: "8-K", class: "earnings", filedAt: day, items: ["2.02", "9.01"], title: "Results of Operations" });
const quarterRows = (events: CompanyEvent[], periodEnd: string, filter: EventFilter = "key") =>
  streamRows(railLayout(rail(events), filter, FIXED), FINDINGS, periodEnd, filter).map(r => r.id);

test("an earnings 8-K carries the findings of the quarter it reports, matched by quarter not by filing date", () => {
  const q2 = release("crwv-0811", "2026-08-11");
  const trades = [form4("t1", "2026-10-20", INTRATOR, 1_000_000), form4("t2", "2026-07-30", INTRATOR, 1_000_000)];
  assert.equal(releasedPeriod(rail([q2])[0]!, rail([q2]), "2026-06-30"), "2026-06-30");
  // The anchor may be any quarter of the grid: a year back or ahead still dates the 08.11 release to 06.30.
  assert.equal(releasedPeriod(rail([q2])[0]!, rail([q2]), "2025-06-30"), "2026-06-30");
  assert.equal(releasedPeriod(rail([q2])[0]!, rail([q2]), "2026-12-31"), "2026-06-30");
  assert.deepEqual(quarterRows([q2, ...trades], "2026-06-30").slice(0, 4), ["crwv-0811", "f-backlog", "f-capex", "insider-summary"]);
  assert.deepEqual(quarterRows([q2], "2026-06-30"), ["crwv-0811", "f-backlog", "f-capex"]);
  // A 52/53-week quarter ending a couple of days off the month's end is the same quarter.
  assert.deepEqual(quarterRows([q2], "2026-06-28"), ["crwv-0811", "f-backlog", "f-capex"]);
  // Findings of the quarter before or after: nothing extra under the release, card or no card.
  for (const periodEnd of ["2026-03-31", "2026-09-30"]) {
    assert.deepEqual(quarterRows([q2, ...trades], periodEnd), ["crwv-0811", "insider-summary"], periodEnd);
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
