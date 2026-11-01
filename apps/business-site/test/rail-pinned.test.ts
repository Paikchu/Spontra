import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CompanyEvent, EventsPublication } from "../../../shared/analysis-contract/events.ts";
import type { VerifiedFinding } from "../../../shared/analysis-runtime/findings.ts";
import { setLocale } from "../../../packages/web/src/i18n/core.ts";
import { readEventsPublication } from "../../../shared/analysis-runtime/events.ts";
import { railEntries } from "../../../shared/analysis-runtime/rail.ts";
import { railLayout, rowLeaves, streamRows, type EventFilter } from "../src/event-noise.ts";
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
const OLD = form4("intrator-old", ago(140), INTRATOR, 90_000_000);
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
const ALL = rail([...WINDOW, OLD, EARNINGS]);
const IN_WINDOW = WINDOW.map(e => e.id);

/** The ids the default list shows, the card counted as one row and its folded rows left out. */
const listed = (filter: EventFilter, findings: VerifiedFinding[] = [], periodEnd: string | null = null) =>
  streamRows(railLayout(ALL, filter, NOW), findings, periodEnd, filter).flatMap(r => r.kind === "noise" ? rowLeaves(r.row).map(item => item.id) : [r.id]);

const render = (filter: EventFilter, focus: string | null = null, findings: VerifiedFinding[] = [], periodEnd: string | null = null) => renderToStaticMarkup(createElement(RailStream, {
  rail: { recent: ALL, earlier: [], quiet: 0, since: ago(90) }, findings, findingsPeriodEnd: periodEnd, ticker: "CRWV", updates: 0, focus,
  onFocusItem: () => {}, onFocusFinding: () => {}, filter,
}));

test("with the insider card shown, no Form 4 of its 90 days lists outside it; older ones keep their place", () => {
  for (const filter of ["key", "all"] as const) {
    const ids = listed(filter);
    assert.deepEqual(ids.slice(0, 2), ["earnings-8k", "insider-summary"], filter);
    assert.ok(!ids.some(id => IN_WINDOW.includes(id)), filter);
    const summary = railLayout(ALL, filter, NOW).summary!;
    // The card holds every one of them, the exercise included, but sums only the open-market trades.
    assert.deepEqual(summary.items.map(item => item.id).sort(), [...IN_WINDOW].sort(), filter);
    assert.equal(summary.sold, 920_000_000);
    assert.equal(summary.people.length, 3);
  }
  assert.ok(listed("all").includes("intrator-old"));
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
    assert.ok(!html.includes(locale === "en" ? "Sold 3 times in 90 days" : "90 天内卖出 3 笔"), locale);
    assert.ok(!html.includes("Open-market sale") && !html.includes("公开市场卖出"));
  }
  setLocale("en");
  const summary = railLayout(ALL, "all", NOW).summary!;
  const card = (open: boolean) => renderToStaticMarkup(createElement(InsiderSummaryCard, {
    summary, ticker: "CRWV", open, openRows: new Set<string>(), focus: null,
    motion: { layout: false, layoutDependency: "", exit: {} as never }, onToggle: () => {}, onFocus: () => {}, tip: () => ({}),
  }));
  const open = card(true), closed = card(false);
  assert.ok(open.includes('aria-expanded="true"') && open.includes("Show less"));
  assert.ok(open.includes("Sold 3 times in 90 days"));
  assert.ok(open.includes("McVeety Chen"));
  assert.ok(closed.includes('aria-expanded="false"') && closed.includes("Show all 3"));
  assert.ok(!closed.includes("Sold 3 times in 90 days"));
  assert.ok(!closed.includes("McVeety Chen"));
  // A trade in focus (picked on the time axis) opens the card on its own.
  assert.ok(render("key", "intrator-2").includes("Sold 3 times in 90 days"));
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

test("a pinned filing with no findings of its own shows nothing extra beneath it", () => {
  // Findings of an earlier period, whose filing is not on the rail, stay below the pinned filing and the card.
  const earlier = ago(80 + 42 + 182);
  assert.deepEqual(listed("key", FINDINGS, earlier).slice(0, 4), ["earnings-8k", "insider-summary", "f-backlog", "f-capex"]);
  assert.deepEqual(listed("key").slice(0, 2), ["earnings-8k", "insider-summary"]);
  const html = render("key");
  assert.ok(!html.includes("severity-icon"));
});
