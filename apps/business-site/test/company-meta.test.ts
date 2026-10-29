import { test } from "node:test";
import assert from "node:assert/strict";
import { setLocale } from "../../../packages/web/src/i18n/core.ts";
import { companyIdentity, coreSlots, filerContext, issuerHeader } from "../src/company-meta.ts";
import type { BusinessFlowQuarter } from "../../../shared/analysis-contract/business-flow.ts";
import { sideScroll } from "../src/side-scroll.ts";
import type { FlowMetric } from "../../../shared/analysis-contract/business-flow.ts";

/** The identity part of the header: who the issuer is and its fiscal year end. */
const who = (input: Parameters<typeof companyIdentity>[0]) => { const { name, fullName, fiscalYearEndMonth } = companyIdentity(input); return { name, fullName, fiscalYearEndMonth }; };
const catalog = { name: "Example Holdings Inc", nameZh: "示例控股", latestPeriod: { fiscalYearEndMonth: 9 } };

test("U22: the header's name comes from data, the Chinese name first on the Chinese page", () => {
  assert.deepEqual(who({ locale: "zh-CN", catalog, issuer: { name: "Example Holdings, Inc.", fiscalYearEndMonth: 1 } }),
    { name: "示例控股", fullName: "Example Holdings, Inc.", fiscalYearEndMonth: 1 });
  assert.deepEqual(who({ locale: "en", catalog, issuer: { name: "Example Holdings, Inc.", fiscalYearEndMonth: 1 } }),
    { name: "Example Holdings, Inc.", fullName: "Example Holdings, Inc.", fiscalYearEndMonth: 1 });
  // Without the issuer the generated publications and then the catalog name it; the catalog's period has the fiscal year end.
  assert.deepEqual(who({ locale: "en", catalog, issuer: null, explainerName: "Example (explainer)" }),
    { name: "Example (explainer)", fullName: "Example Holdings Inc", fiscalYearEndMonth: 9 });
  assert.deepEqual(who({ locale: "zh-CN", catalog: { name: "Plain Co", nameZh: null }, issuer: { name: "  ", fiscalYearEndMonth: 13 } }),
    { name: "Plain Co", fullName: "Plain Co", fiscalYearEndMonth: null });
  assert.deepEqual(who({ locale: "en" }), { name: null, fullName: null, fiscalYearEndMonth: null });
});

test("U22: the filer context names a foreign issuer's form and a reporting currency other than dollars", () => {
  setLocale("en");
  assert.deepEqual(filerContext({ currency: "USD", forms: ["10-Q", "8-K"] }), []);
  assert.deepEqual(filerContext({ currency: "TWD", forms: ["6-K", "20-F"] }), ["20-F", "Reports in TWD"]);
  setLocale("zh-CN");
  assert.deepEqual(filerContext({ currency: "EUR", forms: ["20-F/A"] }), ["20-F", "报告货币：欧元"]);
});

const q = (periodEnd: string, over: Partial<BusinessFlowQuarter> = {}) => ({ id: periodEnd, label: periodEnd, periodStart: null, periodEnd, periodType: "3M", currency: "USD", ...over }) as BusinessFlowQuarter;

test("U22: the identity carries the latest quarter's issuer line from the flow and the filings", () => {
  setLocale("zh-CN");
  const flow = { quarters: [q("2026-03-31", { currency: "TWD" }), q("2026-06-30", { currency: "TWD", fiscalYearEndMonth: 12 })] };
  const identity = companyIdentity({ locale: "zh-CN", issuer: { name: "Example Holdings" }, flow, filings: { filings: [{ form: "6-K" }, { form: "20-F" }] } });
  assert.deepEqual(identity, { name: "Example Holdings", fullName: "Example Holdings", fiscalYearEndMonth: 12, annualForm: null, filingLabel: "20-F · 报告货币：新台币" });
});

test("U22: with no filing collected yet, the issuer's annual form still names a foreign issuer", () => {
  setLocale("zh-CN");
  // As production serves a 20-F filer whose filings are not collected: the flow in its currency, an empty filings feed.
  const flow = { quarters: [q("2026-06-30", { currency: "TWD" })] };
  const identity = companyIdentity({ locale: "zh-CN", issuer: { name: "Example Semiconductor", fiscalYearEndMonth: 12, annualForm: "20-F" }, flow, filings: null });
  assert.equal(identity.filingLabel, "20-F · 报告货币：新台币");
  assert.equal(issuerHeader({ base: identity, quarter: flow.quarters[0] }).filingLabel, "20-F · 报告货币：新台币");
  // A domestic filer's 10-K adds nothing.
  assert.equal(companyIdentity({ locale: "zh-CN", issuer: { annualForm: "10-K" }, flow: { quarters: [q("2026-06-30")] } }).filingLabel, null);
});

test("U22: with neither filings nor an annual form, the filed events' 6-K names a foreign issuer", () => {
  setLocale("zh-CN");
  // As production serves a foreign issuer today: the flow in its currency, no filings, no annual form, but its events feed.
  const flow = { quarters: [q("2026-06-30", { currency: "TWD", fiscalYearEndMonth: 12 })] };
  const events = { events: [{ form: "4" }, { form: "6-K" }, { form: "6-K/A" }] };
  const identity = companyIdentity({ locale: "zh-CN", issuer: { name: "Example Semiconductor" }, flow, filings: null, events });
  assert.equal(identity.filingLabel, "20-F · 报告货币：新台币");
  assert.equal(issuerHeader({ base: identity, quarter: flow.quarters[0], events }).filingLabel, "20-F · 报告货币：新台币");
  // A domestic filer's 8-K and Form 4 events add nothing.
  assert.equal(companyIdentity({ locale: "zh-CN", flow: { quarters: [q("2026-06-30")] }, events: { events: [{ form: "8-K" }, { form: "4" }] } }).filingLabel, null);
});

test("U25: the issuer line follows the quarter shown and carries no fiscal year end", () => {
  setLocale("zh-CN");
  const base = { fiscalYearEndMonth: 1, filingLabel: "20-F" };
  // The quarter's own currency and calendar win; without a quarter the base's line stands.
  assert.deepEqual(issuerHeader({ base, quarter: q("2026-06-30", { fiscalYearEndMonth: 12, currency: "EUR" }) }), { fiscalYearEndMonth: 12, filingLabel: "报告货币：欧元" });
  assert.deepEqual(issuerHeader({ base, quarter: q("2026-07-26") }), { fiscalYearEndMonth: 1, filingLabel: null });
  assert.deepEqual(issuerHeader({ base }), { fiscalYearEndMonth: 1, filingLabel: "20-F" });
});

const figures = (values: Partial<Record<FlowMetric, number>>) => (key: FlowMetric) => values[key] ?? null;

test("U21: the headline figures are always four cells, a missing one with its reason", () => {
  // An operating company: revenue, gross profit, operating income, net income.
  assert.deepEqual(coreSlots(figures({ revenue: 100, gross: 60, operating: 30, pretax: 28, net: 22 })).map(s => [s.key, s.value, s.missing]),
    [["revenue", 100, null], ["gross", 60, null], ["operating", 30, null], ["net", 22, null]]);
  // A bank: no gross profit or operating income, but income before taxes; the operating cell is not part of its model.
  assert.deepEqual(coreSlots(figures({ revenue: 100, pretax: 40, net: 31 })).map(s => [s.key, s.value, s.missing]),
    [["revenue", 100, null], ["pretax", 40, null], ["operating", null, "model"], ["net", 31, null]]);
  // A company whose filing leaves out gross profit and pretax income: the cells stay, as not disclosed.
  assert.deepEqual(coreSlots(figures({ revenue: 100, operating: 10, net: 8 })).map(s => [s.key, s.missing]),
    [["revenue", null], ["gross", "undisclosed"], ["operating", null], ["net", null]]);
  // No operating line but a pretax one beside gross profit: pretax takes the operating cell, as the wide header always showed.
  assert.deepEqual(coreSlots(figures({ revenue: 100, gross: 50, pretax: 20, net: 15 })).map(s => s.key), ["revenue", "gross", "pretax", "net"]);
  // A direct-operating statement keeps its gross profit out of the header.
  assert.deepEqual(coreSlots(figures({ revenue: 100, gross: 50, operating: 20, pretax: 18, net: 15 }), { hideGross: true }).map(s => [s.key, s.missing]),
    [["revenue", null], ["pretax", null], ["operating", null], ["net", null]]);
  for (const slots of [coreSlots(figures({})), coreSlots(figures({ revenue: 1 }))]) assert.equal(slots.length, 4);
});

test("U21: the chart scroller knows when more lies to the right and when the reader reached the edge", () => {
  assert.deepEqual(sideScroll({ scrollLeft: 0, scrollWidth: 358, clientWidth: 358 }), { overflow: false, atEnd: true });
  assert.deepEqual(sideScroll({ scrollLeft: 0, scrollWidth: 780, clientWidth: 358 }), { overflow: true, atEnd: false });
  assert.deepEqual(sideScroll({ scrollLeft: 200, scrollWidth: 780, clientWidth: 358 }), { overflow: true, atEnd: false });
  assert.deepEqual(sideScroll({ scrollLeft: 421.5, scrollWidth: 780, clientWidth: 358 }), { overflow: true, atEnd: true });
});
