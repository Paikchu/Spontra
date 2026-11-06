import assert from "node:assert/strict";
import test from "node:test";
import { interactionLatency, largestShiftWindow, routeOf, vitalsProps } from "../src/vitals.ts";
import { parseTelemetryEvent, summarize, summarizeVitals, type StoredEvent } from "../src/telemetry.ts";

const SID = "11111111-1111-4111-8111-111111111111";

test("vitals travel as at most six non-negative integers, CLS in thousandths", () => {
  assert.deepEqual(vitalsProps({ ttfb: 219.4, fcp: 284.6, lcp: 860, cls: 0.0012, inp: undefined, content: 812.2 }), { ttfb: 219, fcp: 285, lcp: 860, cls: 1, content: 812 });
  assert.deepEqual(vitalsProps({ lcp: Number.NaN, fcp: -1 }), {});
});

test("CLS keeps the largest session window", () => {
  const shifts = [{ startTime: 100, value: 0.05 }, { startTime: 600, value: 0.05 }, { startTime: 3000, value: 0.08 }];
  assert.equal(largestShiftWindow(shifts), 0.1);
  // A window closes after 5 s even when shifts keep arriving.
  const steady = Array.from({ length: 12 }, (_, i) => ({ startTime: i * 900, value: 0.01 }));
  assert.ok(Math.abs(largestShiftWindow(steady) - 0.06) < 1e-9);
  assert.equal(largestShiftWindow([]), 0);
});

test("INP is the slowest interaction, skipping one per 50", () => {
  assert.equal(interactionLatency(new Map()), undefined);
  assert.equal(interactionLatency(new Map([[1, 40], [2, 300], [3, 120]])), 300);
  const many = new Map(Array.from({ length: 60 }, (_, i) => [i + 1, i === 0 ? 900 : 100] as [number, number]));
  assert.equal(interactionLatency(many), 100);
});

test("only home and company loads are measured", () => {
  assert.equal(routeOf("/"), "home");
  assert.equal(routeOf("/companies/NVDA"), "company");
  assert.equal(routeOf("/companies/NVDA/extra"), null);
  assert.equal(routeOf("/privacy"), null);
});

test("the store accepts a web_vitals event and summarizes p75 per landing route", () => {
  const parsed = parseTelemetryEvent({ name: "web_vitals", path: "/companies/NVDA", lang: "en", theme: "dark", sid: SID, props: { lcp: 900, cls: 2 } });
  assert.deepEqual(parsed?.props, { lcp: 900, cls: 2 });
  const rows = [400, 800, 1200, 1600].map(lcp => ({ path: "/companies/NVDA", props: { lcp, content: lcp + 100 } }));
  const [company, ...rest] = summarizeVitals([...rows, { path: "/", props: { lcp: 500 } }, { path: "/privacy", props: { lcp: 1 } }]);
  assert.equal(company?.route, "company");
  assert.equal(company?.samples, 4);
  assert.equal(company?.p75.lcp, 1200);
  assert.equal(company?.p75.content, 1300);
  assert.equal(company?.p75.inp, null);
  assert.deepEqual(rest.map(item => [item.route, item.p75.lcp]), [["home", 500]]);
  const now = Date.UTC(2026, 10, 6);
  const event: StoredEvent = { received: now - 1000, name: "web_vitals", path: "/", lang: "en", theme: "dark", sid: SID, props: { lcp: 700 } };
  assert.equal(summarize([event], "24h", now).vitals?.[0]?.p75.lcp, 700);
});
