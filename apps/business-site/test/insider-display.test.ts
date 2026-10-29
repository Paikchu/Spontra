import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../../packages/web/src/i18n/core.ts";
import { readEventsPublication } from "../../../shared/analysis-runtime/events.ts";
import { railEntries } from "../../../shared/analysis-runtime/rail.ts";
import { eventTitle } from "../src/events-model.ts";
import { EventsList } from "../src/EventsList.tsx";

const publication = readEventsPublication(JSON.parse(readFileSync(new URL("./fixtures/nvda-events.json", import.meta.url), "utf8")), "NVDA")!;
const sales = publication.events.filter(e => e.insider?.ownerName === "STEVENS MARK A" && e.filedAt.startsWith("2026-09"));
const render = (espp = false) => {
  const events = sales.map(e => espp ? { ...e, description: "ESPP", insider: { ...e.insider!, sold: null, bought: { shares: e.insider!.sold!.shares, cost: e.insider!.sold!.proceeds, averagePrice: e.insider!.sold!.averagePrice } } } : e);
  return renderToStaticMarkup(createElement(EventsList, {
    rail: { recent: railEntries(null, { ...publication, events }), earlier: [], quiet: 0, since: "2026-01-01" },
    ticker: publication.ticker, updates: 0, focus: events[0].id, pendingInsider: 0, expanded: true,
    onFocus: () => {}, onExpand: () => {}, filter: "insiders", onFilter: () => {},
  }));
};

test("focused folded sales render bilingual detail and SEC links", () => {
  setLocale("zh-CN");
  const zh = render();
  assert.ok(zh.includes('<span lang="en">STEVENS MARK A</span>'));
  assert.ok(zh.includes("90 天内卖出 3 笔 · 合计 9.5亿美元"));
  assert.ok(zh.includes('aria-expanded="true"'));
  assert.ok(zh.includes("公开市场卖出"));
  assert.ok(zh.includes("均价"));
  assert.ok(zh.includes('target="_blank" rel="noopener noreferrer"'));
  assert.ok(zh.includes("SEC 文件 ↗"));
  setLocale("en");
  const en = render();
  assert.ok(en.includes("Sold 3 times in 90 days · $950M total"));
  assert.ok(en.includes("Open-market sale"));
});

test("employee purchases show a localized badge", () => {
  setLocale("zh-CN");
  const html = render(true);
  assert.ok(html.includes("员工持股计划代买"));
});

test("single insider titles include localized transaction amounts without an ESPP badge on sales", () => {
  const sale = publication.events.find(e => e.id === "0001588670-26-000014")!;
  const buy = { ...sale, insider: { ...sale.insider!, ownerName: "Roks Edwin", sold: null, bought: { shares: 10_000, cost: 1_120_000, averagePrice: 112 } } };
  for (const locale of ["zh-CN", "en"] as const) {
    setLocale(locale);
    assert.equal(eventTitle(buy), locale === "zh-CN" ? "Roks Edwin · 买入 1.00万股 · 112万美元" : "Roks Edwin · Purchase 10.0K shares · $1.12M");
    assert.equal(eventTitle(sale), locale === "zh-CN" ? "Kress Colette · 卖出 3.49万股 · 765万美元" : "Kress Colette · Sale 34.9K shares · $7.65M");
    const html = renderToStaticMarkup(createElement(EventsList, {
      rail: { recent: railEntries(null, { ...publication, events: [sale] }), earlier: [], quiet: 0, since: "2026-01-01" },
      ticker: "NVDA", updates: 0, focus: sale.id, pendingInsider: 0, expanded: true,
      onFocus: () => {}, onExpand: () => {}, filter: "key", onFilter: () => {},
    }));
    assert.ok(html.includes(eventTitle(sale)));
    assert.ok(!html.includes("ESPP") && !html.includes("员工持股计划代买"));
    const unknown = { ...buy, insider: { ...buy.insider, bought: { ...buy.insider.bought, cost: 0 } } };
    assert.ok(!eventTitle(unknown).includes("$"));
    assert.ok(!eventTitle(unknown).includes("美元"));
  }
});
