import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../../packages/web/src/i18n/core.ts";
import { readEventsPublication } from "../../../shared/analysis-runtime/events.ts";
import { insiderPersonKey, personsFromEvents } from "../../../shared/analysis-runtime/insiders.ts";
import { railEntries } from "../../../shared/analysis-runtime/rail.ts";
import { eventTitle } from "../src/events-model.ts";
import { personRowId } from "../src/event-noise.ts";
import { RailStream } from "../src/RailStream.tsx";

const publication = readEventsPublication(JSON.parse(readFileSync(new URL("./fixtures/nvda-events.json", import.meta.url), "utf8")), "NVDA")!;
const sales = publication.events.filter(e => e.insider?.ownerName === "STEVENS MARK A" && e.filedAt.startsWith("2026-09"));
const stevens = insiderPersonKey(sales[0]!.insider!);
const render = (focus: string | null = sales[0]!.id, filter: "insiders" | "key" = "insiders") => renderToStaticMarkup(createElement(RailStream, {
  rail: { recent: railEntries(null, publication), earlier: [], quiet: 0, since: "2026-01-01" },
  findings: [], findingsPeriodEnd: null, ticker: publication.ticker, updates: 0, focus,
  onFocusItem: () => {}, onFocusFinding: () => {}, filter,
}));

test("a focused sale opens its person's row, with the history's bilingual labels and SEC links", () => {
  setLocale("zh-CN");
  const zh = render();
  assert.ok(!zh.includes("内部人交易"));
  assert.ok(zh.includes('<span class="insider-name" lang="en">STEVENS MARK A</span>'));
  // The person's row is open (the focused trade is theirs) and lists their lines from the rail: sale label, price, SEC link.
  assert.ok(zh.includes(`aria-expanded="true" aria-controls="insider-${stevens}-panel"`));
  assert.ok(zh.includes("卖出"));
  assert.ok(zh.includes("美元"));
  assert.ok(zh.includes("交易后持股"));
  assert.ok(zh.includes('target="_blank" rel="noopener noreferrer"'));
  assert.ok(zh.includes("SEC 文件 ↗"));
  assert.ok(zh.includes(`aria-pressed="true"`));
  assert.ok(zh.includes("净卖出"));
  setLocale("en");
  const en = render();
  assert.ok(!en.includes("Insider trades"));
  assert.ok(en.includes("Net sold"));
  assert.ok(en.includes("Owned after"));
  assert.ok(en.includes("SEC filing ↗"));
  // Nothing focused: every person is closed and no history is rendered.
  const closed = render(null);
  assert.ok(!closed.includes('aria-expanded="true"'));
  assert.ok(!closed.includes("insider-history"));
});

test("in the Key reading every person is a row of the rail, with no group row and no Show all", () => {
  setLocale("en");
  const html = render(null, "key");
  // The rail leaves out Form 4s with nothing traded, so the people are those of the rail's filings.
  const persons = personsFromEvents(railEntries(null, publication).flatMap(item => item.kind === "event" && item.event.insider ? [item.event] : []), new Date());
  assert.ok(persons.length > 5);
  assert.ok(!html.includes("Show all") && !html.includes("people"));
  assert.ok(!html.includes("insider-card"));
  // One collapsed row per person, each its own row of the rail, latest trade first; older people join as the rail pages.
  const shown = html.split('class="insider-person" data-class="insider"').length - 1;
  assert.ok(shown >= 5 && shown <= persons.length);
  const at = persons.slice(0, shown).map(person => html.indexOf(`lang="en">${person.name}</span>`));
  assert.ok(at.every((i, n) => i >= 0 && (n === 0 || at[n - 1]! < i)));
  // No Form 4 lists as its own event row.
  assert.ok(!html.includes('class="stream-row" data-class="insider"'));
  assert.equal(personRowId("123"), "insider:123");
});

test("single insider titles include localized transaction amounts, and the person row tags no ESPP purchase as a sale", () => {
  const sale = publication.events.find(e => e.id === "0001588670-26-000014")!;
  const buy = { ...sale, insider: { ...sale.insider!, ownerName: "Roks Edwin", sold: null, bought: { shares: 10_000, cost: 1_120_000, averagePrice: 112 } } };
  for (const locale of ["zh-CN", "en"] as const) {
    setLocale(locale);
    assert.equal(eventTitle(buy), locale === "zh-CN" ? "Roks Edwin · 买入 1.00万股 · 112万美元" : "Roks Edwin · Purchase 10.0K shares · $1.12M");
    assert.equal(eventTitle(sale), locale === "zh-CN" ? "Kress Colette · 卖出 3.49万股 · 765万美元" : "Kress Colette · Sale 34.9K shares · $7.65M");
    const html = renderToStaticMarkup(createElement(RailStream, {
      rail: { recent: railEntries(null, { ...publication, events: [sale] }), earlier: [], quiet: 0, since: "2026-01-01" },
      findings: [], findingsPeriodEnd: null, ticker: "NVDA", updates: 0, focus: null,
      onFocusItem: () => {}, onFocusFinding: () => {}, filter: "key",
    }));
    assert.ok(html.includes('class="insider-person" data-class="insider"'));
    assert.ok(html.includes('<span class="insider-name" lang="en">Kress Colette</span>'));
    assert.ok(html.includes('class="insider-amount"'));
    assert.ok(html.includes(locale === "zh-CN" ? "765万美元" : "$7.65M"));
    assert.ok(!html.includes("ESPP") && !html.includes("员工持股计划代买"));
    const unknown = { ...buy, insider: { ...buy.insider, bought: { ...buy.insider.bought, cost: 0 } } };
    assert.ok(!eventTitle(unknown).includes("$"));
    assert.ok(!eventTitle(unknown).includes("美元"));
  }
});

test("automatic fallback notice uses the active locale", () => {
  for (const locale of ["zh-CN", "en"] as const) {
    setLocale(locale);
    const html = renderToStaticMarkup(createElement(RailStream, {
      rail: null, findings: [], findingsPeriodEnd: null, ticker: publication.ticker, updates: 0, focus: null,
      onFocusItem: () => {}, onFocusFinding: () => {}, filter: "all", fallback: true,
    }));
    assert.ok(html.includes('role="status"'));
    assert.ok(html.includes(locale === "zh-CN" ? "近 90 天没有重要事件，已显示全部" : "No key events in the last 90 days — showing all"));
  }
});
