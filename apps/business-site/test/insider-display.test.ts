import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../../packages/web/src/i18n/core.ts";
import { readEventsPublication } from "../../../shared/analysis-runtime/events.ts";
import { railEntries } from "../../../shared/analysis-runtime/rail.ts";
import { eventTitle } from "../src/events-model.ts";
import { PersonHistory } from "../src/InsiderHistory.tsx";
import { RailStream } from "../src/RailStream.tsx";

const publication = readEventsPublication(JSON.parse(readFileSync(new URL("./fixtures/nvda-events.json", import.meta.url), "utf8")), "NVDA")!;
const sales = publication.events.filter(e => e.insider?.ownerName === "STEVENS MARK A" && e.filedAt.startsWith("2026-09"));
const render = (focus: string | null = sales[0]!.id, filter: "insiders" | "key" = "insiders") => renderToStaticMarkup(createElement(RailStream, {
  rail: { recent: railEntries(null, publication), earlier: [], quiet: 0, since: "2026-01-01" },
  findings: [], findingsPeriodEnd: null, ticker: publication.ticker, updates: 0, focus,
  onFocusItem: () => {}, onFocusFinding: () => {}, filter,
}));

const history = (event = sales[0]!) => renderToStaticMarkup(createElement(PersonHistory, { event, publication, ticker: publication.ticker, updates: 0, onFocusEvent: () => {} }));

test("a Form 4 on the stage lists its filer's every transaction, with bilingual labels and SEC links", () => {
  setLocale("zh-CN");
  const zh = history();
  assert.ok(zh.includes('<span lang="en">STEVENS MARK A</span>'));
  assert.ok(zh.includes('aria-label="STEVENS MARK A：全部 Form 4 交易"'));
  assert.ok(zh.includes("净卖出") && zh.includes("卖出") && zh.includes("美元") && zh.includes("交易后持股"));
  assert.ok(zh.includes('target="_blank" rel="noopener noreferrer"') && zh.includes("SEC 文件 ↗"));
  // The lines of the filing on stage are lit; a line of another listed filing opens it.
  assert.ok(zh.includes("data-lit"));
  assert.ok(zh.includes('class="insider-history-open" type="button" aria-label="打开 '));
  // Every September filing of the person is in the history, not only the one on stage.
  for (const sale of sales) assert.ok(zh.includes(`href="${sale.documentUrl}"`) || zh.includes(sale.insider!.lines[0]!.date), sale.id);
  setLocale("en");
  const en = history();
  assert.ok(en.includes("Net sold") && en.includes("Owned after") && en.includes("SEC filing ↗"));
  assert.ok(en.includes('aria-label="STEVENS MARK A: every Form 4 transaction"'));
});

test("in the Key reading each Form 4 is its own row of the rail, with no person rows and nothing to expand", () => {
  setLocale("en");
  const html = render(null, "key");
  assert.ok(!html.includes("insider-person") && !html.includes("insider-history") && !html.includes("aria-expanded"));
  assert.ok(html.includes('aria-checked="false" data-class="insider"'));
  assert.ok(html.includes(">STEVENS MARK A sold</span>"));
  assert.ok(!html.includes("Net sold"));
  // A focused sale is the checked row, not an opened person.
  const focused = render(sales[0]!.id, "insiders");
  assert.ok(focused.includes('aria-checked="true" data-class="insider"'));
  assert.ok(!focused.includes("insider-history"));
});

test("the stage title carries the localized amount, the rail row only the name and direction, and no ESPP purchase reads as a sale", () => {
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
    assert.ok(html.includes('aria-checked="false" data-class="insider"'));
    assert.ok(html.includes(locale === "zh-CN" ? ">Kress Colette 卖出</span>" : ">Kress Colette sold</span>"));
    assert.ok(!html.includes(locale === "zh-CN" ? ">Kress Colette · 卖出" : ">Kress Colette · Sale"), "the figures are on the stage, not in the row");
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
