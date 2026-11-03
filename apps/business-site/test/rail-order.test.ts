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
import { RAIL_TABS, railLayout, readRailTabs, releasedPeriod, rowLeaves, streamBlocks, withRailTabs, type EventFilter, type RailTab } from "../src/event-noise.ts";
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
/** The window's Form 4s Key lists, newest first: every sale; the option exercise with nothing sold is routine. */
const KEY_TRADES = ["intrator-1", "magnetar-1", "agarwal-1", "intrator-2", "intrator-3"];

/** The ids the list shows, folded rows expanded to their filings. */
const listed = (filter: EventFilter) => railLayout(ALL, filter).rows.flatMap(r => rowLeaves(r).map(item => item.id));

const render = (filter: EventFilter, focus: string | null = null, findings: VerifiedFinding[] = []) => renderToStaticMarkup(createElement(RailStream, {
  rail: { recent: ALL, earlier: [], quiet: 0, since: ago(90) }, findings, findingsPeriodEnd: PERIOD_END, ticker: "CRWV", updates: 0, focus,
  onFocusItem: () => {}, onFocusFinding: () => {}, filter,
}));

test("every Form 4 of any age lists as its own row at its date, the older ones below the earnings filing", () => {
  assert.deepEqual(listed("key"), [...KEY_TRADES, "earnings-8k", ...OLDER_IDS]);
  assert.deepEqual(listed("all"), ["intrator-1", "magnetar-1", "agarwal-1", "intrator-2", "mcveety-exercise", "intrator-3", "earnings-8k", ...OLDER_IDS]);
  assert.deepEqual(listed("insiders"), ["intrator-1", "magnetar-1", "agarwal-1", "intrator-2", "mcveety-exercise", "intrator-3", ...OLDER_IDS]);
  for (const filter of ["key", "all", "insiders"] as const) assert.ok(railLayout(ALL, filter).rows.every(r => r.kind === "item"), filter);
});

test("a Form 4 row is one summary that opens the stage; the rail holds no person's history", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    setLocale(locale);
    const html = render("key");
    // Each filing is a row of its own, in date order, and none of them folds or expands.
    assert.equal(html.split('aria-checked="false" data-class="insider"').length - 1, KEY_TRADES.length + OLDER_IDS.length, locale);
    const at = (text: string) => html.indexOf(text);
    assert.ok(at("Magnetar Financial LLC") < at("Agarwal Nitin") && at("Agarwal Nitin") < at("Q2 results"), locale);
    assert.ok(!html.includes("aria-expanded") && !html.includes("insider-history") && !html.includes(locale === "en" ? "Net sold" : "净卖出"), locale);
  }
  setLocale("en");
  // A trade in focus is the checked row; its history is the stage's.
  const open = render("key", "intrator-2");
  assert.equal(open.split('aria-checked="true"').length - 1, 1);
  assert.ok(!open.includes("insider-history") && !open.includes("SEC filing ↗"));
});

test("one old filing lists at its own date, below the newer rows", () => {
  const items = rail([OLD, EARNINGS, event({ id: "deal", form: "8-K", class: "deal", filedAt: ago(5), items: ["1.01"] })]);
  assert.deepEqual(railLayout(items, "all").rows.map(r => r.id), ["deal", "earnings-8k", "intrator-old"]);
});

test("the findings stand in their own section above the tabs, undated, the first three shown and the rest behind a button", () => {
  setLocale("en");
  const many = [...FINDINGS, finding("f-3", 1, "Third finding"), finding("f-4", 1, "Fourth finding")];
  const html = render("key", null, many);
  const at = (text: string) => html.indexOf(text);
  assert.ok(at('class="guidance"') < at("Backlog concentration") && at("Capex outruns cash") < at('class="stream-tabs"') && at('class="stream-tabs"') < at("Q2 results"));
  assert.ok(html.includes("Third finding") && !html.includes("Fourth finding") && html.includes("1 more"));
  assert.ok(html.includes('class="severity-icon" data-severity="3" viewBox="0 0 16 16" role="img" aria-label="Severity: Major (highest of 3)"'));
  // No date: the meta line is the kind and the view only.
  const meta = html.slice(at("Backlog concentration")).match(/class="stream-meta">([^<]*)</)?.[1] ?? "";
  assert.ok(meta && !/\d{2}\.\d{2}/.test(meta), meta);
  // A finding in focus past the first three opens the rest.
  assert.ok(render("key", "f-4", many).includes("Fourth finding"));
  // Findings of any quarter show, the earnings filing listed or not.
  assert.ok(renderToStaticMarkup(createElement(RailStream, { rail: { recent: [], earlier: [], quiet: 0, since: ago(90) }, findings: FINDINGS, findingsPeriodEnd: ago(400), ticker: "CRWV", updates: 0, focus: null, onFocusItem: () => {}, onFocusFinding: () => {}, filter: "key" })).includes("Backlog concentration"));
  assert.ok(!render("key").includes('class="guidance"'));
});

// The quarter a release reports, on fixed dates: CRWV's 8-K of 2026-08-11 reports the quarter that ended 2026-06-30.
const FIXED = new Date("2026-11-01T00:00:00Z");
const release = (id: string, day: string) => event({ id, form: "8-K", class: "earnings", filedAt: day, items: ["2.02", "9.01"], title: "Results of Operations" });

test("an earnings 8-K reports the quarter that ended before it, matched by quarter not by filing date", () => {
  const q2 = release("crwv-0811", "2026-08-11");
  assert.equal(releasedPeriod(rail([q2])[0]!, rail([q2]), "2026-06-30"), "2026-06-30");
  // The anchor may be any quarter of the grid: a year back or ahead still dates the 08.11 release to 06.30.
  assert.equal(releasedPeriod(rail([q2])[0]!, rail([q2]), "2025-06-30"), "2026-06-30");
  assert.equal(releasedPeriod(rail([q2])[0]!, rail([q2]), "2026-12-31"), "2026-06-30");
});

test("a release filed within 100 days of a quarter's end but after the next one ended reports the later quarter", () => {
  const q3 = release("q3-release", "2026-10-08");
  assert.equal(releasedPeriod(rail([q3])[0]!, rail([q3]), "2026-06-30"), "2026-09-30");
});

test("a second results release for a quarter is not its release, and a listed report's period counts as a quarter end", () => {
  const q2 = release("q2-release", "2026-08-11");
  const update = release("q2-update", "2026-09-02");
  assert.equal(releasedPeriod(rail([update, q2])[0]!, rail([update, q2]), "2026-06-30"), null);
  const report = { accessionNumber: "q2-10q", form: "10-Q", date: "2026-08-12", periodEnd: "2026-06-30", headline: "Q2", sources: [] } as unknown as PublicFilingDigest;
  const items = railEntries({ filings: [report], nextCursor: null } as unknown as PublicFilingDigestPage, readEventsPublication({ schemaVersion: "events.v1", ticker: "CRWV", checkedAt: FIXED.toISOString(), pendingInsider: 0, events: [q2] }, "CRWV"));
  assert.equal(releasedPeriod(items.find(item => item.id === "q2-release")!, items, null), "2026-06-30");
  // The release and the 10-Q of that quarter share one frame.
  assert.deepEqual(streamBlocks(railLayout(items, "all").rows, new Set(RAIL_TABS), items).map(b => b.kind === "quarter" ? b.rows.map(r => r.id) : b.row.id), [["q2-10q", "q2-release"]]);
});

/** The ids each block shows under a set of tabs: a frame as its member ids in a list, a row as its id. */
const blocks = (tabs: RailTab[], items = ALL) =>
  streamBlocks(railLayout(items, "key").rows, new Set(tabs), items, PERIOD_END).map(b => b.kind === "quarter" ? b.rows.map(r => r.id) : b.row.id);

test("the tabs pick reports and management, either or both, and a quarter's filings share one frame", () => {
  assert.deepEqual(blocks([...RAIL_TABS]), [...KEY_TRADES, ["earnings-8k"], ...OLDER_IDS]);
  assert.deepEqual(blocks(["reports"]), [["earnings-8k"]]);
  assert.deepEqual(blocks(["management"]), [...KEY_TRADES, ...OLDER_IDS]);
  // An officer change is management, not a report.
  const change = event({ id: "exec-502", form: "8-K", class: "executive", filedAt: ago(40), items: ["5.02"] });
  const items = rail([...WINDOW, EARNINGS, change]);
  assert.ok(blocks(["management"], items).includes("exec-502"));
  assert.ok(!blocks(["reports"], items).flat().includes("exec-502"));
});

test("the tabs read from and write to ?tabs=, both on being the default left out of the address", () => {
  assert.deepEqual([...readRailTabs("")], [...RAIL_TABS]);
  assert.deepEqual([...readRailTabs("?tabs=nope")], [...RAIL_TABS]);
  // A link from when findings were a tab still reads.
  assert.deepEqual([...readRailTabs("?tabs=management,findings")], ["management"]);
  assert.equal(withRailTabs("?view=cash", new Set(RAIL_TABS)), "?view=cash");
  assert.equal(withRailTabs("?view=cash&tabs=reports", new Set<RailTab>(["management"])), "?view=cash&tabs=management");
});
