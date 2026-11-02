import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../../packages/web/src/i18n/core.ts";
import type { CompanyEvent } from "../../../shared/analysis-contract/events.ts";
import { readEventsPublication } from "../../../shared/analysis-runtime/events.ts";
import { personsFromEvents } from "../../../shared/analysis-runtime/insiders.ts";
import { railEntries } from "../../../shared/analysis-runtime/rail.ts";
import { dollars, eventTitle, insiderLens, insiderTotalDollars, partialDollars } from "../src/events-model.ts";
import { netValueUnknown } from "../src/insiders-model.ts";
import { RailStream } from "../src/RailStream.tsx";

const publication = readEventsPublication(JSON.parse(readFileSync(new URL("./fixtures/nvda-events.json", import.meta.url), "utf8")), "NVDA")!;
const byId = (id: string) => publication.events.find(e => e.id === id)!;
// Kress Colette: a priced sale (2026-09) and an earlier one (2026-03), both legacy aggregates without pricedShares.
const priced = byId("0001588670-26-000014");
const legacy = byId("0001588670-26-000010");

/** The filing as AD-4 reads it when its sale lines carry no price: shares stay, money is unknown. */
function unpriced(e: CompanyEvent): CompanyEvent {
  const t = e.insider!;
  return { ...e, insider: { ...t, lines: t.lines.map(l => l.code === "S" ? { ...l, price: null } : l), sold: { shares: t.sold!.shares, proceeds: null, averagePrice: null, pricedShares: 0 } } };
}

const renderRail = (events: CompanyEvent[]) => renderToStaticMarkup(createElement(RailStream, {
  rail: { recent: railEntries(null, { ...publication, events }), earlier: [], quiet: 0, since: "2025-01-01" },
  findings: [], findingsPeriodEnd: null, ticker: "NVDA", updates: 0, focus: null,
  onFocusItem: () => {}, onFocusFinding: () => {}, filter: "insiders",
}));

test("a sale with null proceeds shows no amount in its title and an unknown amount as —", () => {
  const sale = unpriced(priced);
  for (const locale of ["zh-CN", "en"] as const) {
    setLocale(locale);
    assert.equal(eventTitle(sale), locale === "zh-CN" ? "Kress Colette · 卖出 3.49万股" : "Kress Colette · Sale 34.9K shares");
    assert.equal(dollars(null), "—");
  }
  // The lens's own sale is in the cadence with unknown proceeds, so the 12-month total is no precise figure.
  setLocale("en");
  const model = insiderLens({ ...publication, events: publication.events.map(e => e.id === sale.id ? sale : e) }, sale)!;
  assert.equal(model.cadence.totalProceeds, null);
  assert.ok(model.cadence.sales.some(s => s.id === sale.id && s.proceeds == null));
  assert.match(partialDollars(model.cadence.sales.map(s => s.proceeds)), /^≥ \$/);
});

test("a person total with one priced and one unpriced filing is partial, never a precise sum", () => {
  const events = [priced, unpriced(legacy)];
  for (const locale of ["zh-CN", "en"] as const) {
    setLocale(locale);
    assert.equal(partialDollars([7_648_632, null]), locale === "zh-CN" ? "≥ 765万美元" : "≥ $7.6M");
    assert.equal(partialDollars([null, null]), "—");
    assert.equal(partialDollars([1_000_000, 2_000_000]), dollars(3_000_000));
  }
  // An unpriced sale makes the net unknown, so the row shows only the net shares and their side.
  const person = personsFromEvents(events, new Date("2026-10-01"))[0]!;
  assert.ok(person.latest && person.latest.value != null, "the latest line is priced: the unpriced one is found among the filings");
  assert.equal(netValueUnknown(person, events), true);
  assert.equal(person.sold.value, null);
  assert.equal(person.net.value, null);
  assert.equal(person.net.complete, false);
  assert.equal(netValueUnknown(person, [priced]), true);
  assert.equal(netValueUnknown(person, []), true, "totals include older unpriced lines absent from the rail");
  const complete = personsFromEvents([priced, legacy], new Date("2026-10-01"))[0]!;
  assert.equal(netValueUnknown(complete, []), false);
  assert.equal(netValueUnknown({ ...complete, sold: person.sold }, []), true, "side totals are consulted even with a numeric net");
  setLocale("zh-CN");
  const zh = renderRail(events);
  assert.match(zh, /净卖出 — · [\d,]+ 股/);
  assert.ok(zh.includes(`卖出 ${person.sold.count} 笔 ≥ `));
  setLocale("en");
  const en = renderRail(events);
  assert.match(en, /Net sold — · [\d,]+ shares/);
  assert.ok(en.includes(`${person.sold.count} sales ≥ $`));
  assert.ok(!/Net sold \$/.test(en));
  // Priced on both sides, the net reads as before.
  assert.match(renderRail([priced, legacy]), /Net sold \$[\d.]+M · [\d,]+ shares/);
});

test("person side totals show the known subtotal, unknown, exact zero, and exact purchases", () => {
  for (const code of ["S", "P"] as const) {
    const pricedEvent: CompanyEvent = { ...priced, insider: { ...priced.insider!, lines: [{ ...priced.insider!.lines[0]!, code, acquiredDisposed: code === "S" ? "D" : "A", shares: 10, price: 100 }] } };
    const unknownEvent: CompanyEvent = { ...pricedEvent, id: "unpriced", insider: { ...pricedEvent.insider!, lines: [{ ...pricedEvent.insider!.lines[0]!, price: null }] } };
    const person = personsFromEvents([pricedEvent, unknownEvent], new Date("2026-10-01"))[0]!;
    for (const locale of ["zh-CN", "en"] as const) {
      setLocale(locale);
      const totals = code === "S" ? person.sold : person.bought;
      assert.equal(insiderTotalDollars(totals), partialDollars([1_000, null]));
      assert.equal(insiderTotalDollars({ ...totals, pricedValue: 0, pricedCount: 0, unpricedCount: 2 }), "—");
      assert.equal(insiderTotalDollars({ ...totals, pricedValue: 0, pricedCount: 1 }), `≥ ${dollars(0)}`);
      assert.equal(insiderTotalDollars({ ...totals, value: 0, pricedValue: 0, pricedCount: 2, unpricedCount: 0 }), dollars(0));
      assert.equal(insiderTotalDollars({ ...totals, value: 1_000, pricedCount: 2, unpricedCount: 0 }), dollars(1_000));
      const html = renderRail([pricedEvent, unknownEvent]);
      assert.match(html, locale === "en" ? /Net (sold|bought) —/ : /净(卖出|买入) —/);
      assert.ok(html.includes(`${locale === "en" ? (code === "S" ? "2 sales" : "2 purchases") : (code === "S" ? "卖出 2 笔" : "买入 2 笔")} ${partialDollars([1_000, null])}`));
    }
  }
});

test("a legacy aggregate without pricedShares still reads and shows its reported amount", () => {
  assert.equal(legacy.insider!.sold!.pricedShares, undefined);
  assert.equal(typeof legacy.insider!.sold!.proceeds, "number");
  for (const locale of ["zh-CN", "en"] as const) {
    setLocale(locale);
    assert.equal(eventTitle(legacy), locale === "zh-CN" ? "Kress Colette · 卖出 6.26万股 · 1096万美元" : "Kress Colette · Sale 62.6K shares · $10.96M");
  }
  const model = insiderLens(publication, legacy)!;
  assert.ok(model.cadence.totalProceeds != null && model.cadence.totalProceeds > 0);
  assert.ok(!partialDollars(model.cadence.sales.map(s => s.proceeds)).startsWith("≥"));
});
