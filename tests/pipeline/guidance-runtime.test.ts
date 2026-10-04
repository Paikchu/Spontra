import assert from "node:assert/strict";
import test from "node:test";

import {
  attachRevenueContext, classifyAction, consolidateGuidance, normalizeForMatch, quoteNumbers, readExtractedGuidance,
  readGuidancePublication, resolvePeriodEnd, verifyGuidance, type GuidanceEntry,
} from "../../shared/analysis-runtime/guidance.ts";
import { locateGuidance } from "../../workers/pipeline/src/guidance/locate.ts";
import { classifyExhibit, namesFiscalQuarter } from "../../workers/pipeline/src/guidance/sources.ts";

const source = normalizeForMatch(`Outlook
For the second quarter of fiscal 2027, we expect total revenues to grow between 12% and 14% in USD, and non-GAAP EPS of $1.46 to $1.50.
We now expect fiscal 2027 total revenues of $67.0 to $67.5 billion, and operating margin to expand by 50 basis points.
Revenue may decline 2% to 4% in hardware.`);

const raw = (overrides: Record<string, unknown>) => readExtractedGuidance({ items: [{
  metric: "revenue", measure: "growth", segment: null, label: "Total revenues", basis: "unspecified", horizon: "quarter", form: "range",
  fiscalYear: 2027, fiscalQuarter: 2, unit: "percent", currency: "USD", low: 12, high: 14, direction: null,
  text: "2027财年第二季度总收入预计同比增长12%至14%。",
  quote: "For the second quarter of fiscal 2027, we expect total revenues to grow between 12% and 14% in USD",
  ...overrides,
}] })[0]!;

test("quote numbers carry a range's scale word back to the bare first number, and basis points read as percent", () => {
  const values = quoteNumbers("fiscal 2027 total revenues of $67.0 to $67.5 billion, and margin up 50 basis points");
  assert.ok(values.includes(67e9) && values.includes(67.5e9));
  assert.ok(values.includes(0.5));
  assert.ok(quoteNumbers("between 12% and 14%").includes(14));
});

test("verification accepts verbatim, numerically supported items and explains each rejection", () => {
  assert.ok(verifyGuidance(raw({}), source).item);
  assert.ok(verifyGuidance(raw({ quote: "FOR THE SECOND QUARTER of fiscal 2027, we expect total   revenues to grow between 12% and 14%" }), source).item, "case and whitespace do not matter");
  assert.match(verifyGuidance(raw({ quote: "We expect revenue growth of 12% to 14% next quarter" }), source).issues.join(), /verbatim/);
  assert.match(verifyGuidance(raw({ high: 15 }), source).issues.join(), /15 does not appear/);
  assert.match(verifyGuidance(raw({ unit: "USD" }), source).issues.join(), /unit must be percent/);
  assert.match(verifyGuidance(raw({ fiscalQuarter: null }), source).issues.join(), /fiscalQuarter/);

  const annual = verifyGuidance(raw({ measure: "amount", unit: "USD", horizon: "annual", fiscalQuarter: 2, low: 67e9, high: 67.5e9,
    quote: "We now expect fiscal 2027 total revenues of $67.0 to $67.5 billion" }), source).item!;
  assert.equal(annual.fiscalQuarter, null, "annual guidance has no quarter");
  assert.equal(annual.high, 67.5e9);

  const decline = verifyGuidance(raw({ metric: "segment_revenue", segment: "Hardware", low: -4, high: -2, quote: "Revenue may decline 2% to 4% in hardware." }), source);
  assert.ok(decline.item, "a decline is negative growth written without a sign");

  const qualitative = raw({ form: "qualitative", low: null, high: null, direction: null });
  assert.match(verifyGuidance(qualitative, source).issues.join(), /direction/);
  assert.equal(verifyGuidance(raw({ form: "qualitative", direction: "up" }), source).item?.low, null, "qualitative items carry no numbers");
});

test("unrecognised enum values from the model are rejected rather than coerced", () => {
  assert.match(verifyGuidance(raw({ metric: "sales", basis: "whatever" }), source).issues.join(), /metric/);
  assert.equal(readExtractedGuidance({ items: "nope" }).length, 0);
});

test("fiscal periods resolve from any reported anchor, across fiscal year-ends", () => {
  const orcl = [{ fiscalYear: 2027, fiscalPeriod: "Q1", periodEnd: "2026-08-31" }];
  assert.equal(resolvePeriodEnd(2027, 2, "quarter", orcl), "2026-11-30");
  assert.equal(resolvePeriodEnd(2027, null, "annual", orcl), "2027-05-31");
  assert.equal(resolvePeriodEnd(2026, 4, "quarter", orcl), "2026-05-31");
  const adsk = [{ fiscalYear: 2026, fiscalPeriod: "FY", periodEnd: "2026-01-31" }];
  assert.equal(resolvePeriodEnd(2027, 1, "quarter", adsk), "2026-04-30");
  // A 52/53-week year ending in the first days of a month belongs to the previous month.
  const weekly = [{ fiscalYear: 2026, fiscalPeriod: "Q1", periodEnd: "2025-10-04" }];
  assert.equal(resolvePeriodEnd(2026, 2, "quarter", weekly), "2025-12-31");
  assert.equal(resolvePeriodEnd(2027, 1, "quarter", []), null);
});

test("revisions compare midpoints, then widths", () => {
  assert.equal(classifyAction(null, { low: 1, high: 2 }), "initiated");
  assert.equal(classifyAction({ low: 15, high: 16 }, { low: 16, high: 17 }), "raised");
  assert.equal(classifyAction({ low: 15, high: 16 }, { low: 14, high: 16 }), "lowered");
  assert.equal(classifyAction({ low: 14, high: 18 }, { low: 15, high: 17 }), "narrowed");
  assert.equal(classifyAction({ low: 15, high: 17 }, { low: 14, high: 18 }), "widened");
  assert.equal(classifyAction({ low: 15, high: 17 }, { low: 15, high: 17 }), "reaffirmed");
  assert.equal(classifyAction({ low: null, high: null, direction: "up" }, { low: null, high: null, direction: "up" }), "reaffirmed");
});

const entry = (overrides: Partial<GuidanceEntry>): GuidanceEntry => ({
  metric: "revenue", measure: "growth", segment: null, label: "Total revenues", basis: "unspecified", horizon: "annual", form: "range",
  fiscalYear: 2027, fiscalQuarter: null, unit: "percent", low: 15, high: 16, direction: null, text: "全年收入增长", quote: "we expect fiscal 2027 revenue growth of 15% to 16%",
  eventAccession: "A0", eventDate: "2026-06-11", materialKind: "press_release", sourceId: "m-a0", periodEnd: "2027-05-31", ...overrides,
});

test("consolidation merges repeats within an event and links revisions across events", () => {
  const items = consolidateGuidance([
    entry({ basis: "gaap" }),
    entry({ eventAccession: "A1", eventDate: "2026-09-09", materialKind: "transcript", sourceId: "m-t1", low: 16, high: 17 }),
    entry({ eventAccession: "A1", eventDate: "2026-09-09", sourceId: "m-a1", basis: "gaap", low: 16, high: 17 }),
    // The call disagrees with the release; the release wins and the call's number is not published.
    entry({ eventAccession: "A1", eventDate: "2026-09-09", materialKind: "transcript", sourceId: "m-t1", metric: "eps", measure: "per_share", unit: "USD_per_share", low: 1.4, high: 1.5 }),
    entry({ eventAccession: "A1", eventDate: "2026-09-09", sourceId: "m-a1", metric: "eps", measure: "per_share", unit: "USD_per_share", low: 1.46, high: 1.5 }),
  ]);
  assert.equal(items.length, 3);
  const raised = items.find(i => i.issuedAt === "2026-09-09" && i.metric === "revenue")!;
  assert.deepEqual(raised.sourceIds, ["m-a1", "m-t1"], "release first, repeated by the call");
  assert.equal(raised.action, "raised");
  assert.deepEqual(raised.previous, { low: 15, high: 16, issuedAt: "2026-06-11" });
  const eps = items.find(i => i.metric === "eps")!;
  assert.equal(eps.low, 1.46);
  assert.deepEqual(eps.sourceIds, ["m-a1"]);
  assert.equal(items.find(i => i.issuedAt === "2026-06-11")!.action, "initiated");
});

test("growth guidance becomes an amount from the prior-year actual, and the guided quarter gets its actual", () => {
  const [quarter, annual] = consolidateGuidance([
    entry({ horizon: "quarter", fiscalQuarter: 2, periodEnd: "2026-11-30", low: 10, high: 20 }),
    entry({ sourceId: "m-a0", metric: "revenue", horizon: "annual", periodEnd: "2027-05-31", low: 10, high: 10, form: "point", fiscalYear: 2027 }),
  ]);
  const quarters = [
    { periodStart: "2025-09-01", periodEnd: "2025-11-30", value: 100 },
    { periodStart: "2025-12-01", periodEnd: "2026-02-28", value: 110 },
    { periodStart: "2026-03-01", periodEnd: "2026-05-31", value: 120 },
    { periodStart: "2025-06-01", periodEnd: "2025-08-31", value: 90 },
    { periodStart: "2026-09-01", periodEnd: "2026-11-30", value: 117 },
  ];
  const [q, a] = attachRevenueContext([quarter!, annual!], quarters);
  assert.deepEqual(q!.derived, { low: 110, high: 120, basePeriodEnd: "2025-11-30", base: 100 });
  assert.deepEqual(q!.actual, { value: 117, periodEnd: "2026-11-30" });
  assert.equal(Math.round(a!.derived!.low), 462, "four prior-year quarters, +10%");
});

test("publication validation keeps only items whose sources are listed", () => {
  const items = consolidateGuidance([entry({}), entry({ sourceId: "m-missing", metric: "eps", measure: "per_share", unit: "USD_per_share", low: 1, high: 2 })]);
  const publication = { schemaVersion: "guidance.v1", ticker: "ORCL", updatedAt: "2026-10-04", items, coverage: [],
    sources: [{ id: "m-a0", kind: "press_release", sourceKind: "sec", title: "Release", url: "https://www.sec.gov/x.htm", publishedAt: "2026-06-11" }] };
  assert.deepEqual(readGuidancePublication(publication, "ORCL")!.items.map(i => i.metric), ["revenue"]);
  assert.equal(readGuidancePublication(publication, "NET"), null);
  assert.equal(readGuidancePublication({ ...publication, sources: [{ ...publication.sources[0], url: "http://insecure" }] }, "ORCL"), null);
});

test("the pre-filter keeps forward-looking passages with numbers, skips boilerplate, and adds call context", () => {
  const filler = Array.from({ length: 60 }, (_, i) => `Customer story ${i} about deployments and partnerships across regions.`).join("\n");
  const call = [filler,
    "Safra Catz: Turning to guidance.",
    "For Q2, we expect total revenue to grow 12% to 14% in constant currency.",
    "Operator: Next question.",
    "This call contains forward-looking statements; we expect results to differ, see risk factors described in our 10-K for 2026.",
    filler].join("\n");
  const { excerpt, selected } = locateGuidance(call, "transcript");
  assert.ok(excerpt.includes("grow 12% to 14%"));
  assert.ok(excerpt.includes("Turning to guidance"), "the preceding turn names the period");
  assert.ok(!excerpt.includes("forward-looking statements"));
  assert.ok(selected <= 4 && excerpt.length < call.length / 5);

  const release = [filler, "Business Outlook", "Q2 FY27", "Revenue", "$16.2 billion - $16.4 billion", filler].join("\n");
  assert.ok(locateGuidance(release, "press_release").excerpt.includes("$16.2 billion - $16.4 billion"), "an Outlook table is kept under its heading");
});

test("exhibits are classified by content and decks must name the same fiscal quarter", () => {
  assert.equal(classifyExhibit("Q2 FY27 Earnings Presentation\nSafe harbor"), "deck");
  assert.equal(classifyExhibit("Dear Shareholders, this quarter..."), "shareholder_letter");
  assert.equal(classifyExhibit("Oracle Announces Fiscal 2027 First Quarter Financial Results"), "press_release");
  assert.ok(namesFiscalQuarter("Autodesk Q3 FY26 Earnings Presentation", { fiscalYear: 2026, quarter: 3 }));
  assert.ok(namesFiscalQuarter("Results for the first quarter of fiscal 2027", { fiscalYear: 2027, quarter: 1 }));
  assert.ok(!namesFiscalQuarter("Investor Day 2026 long-term model", { fiscalYear: 2027, quarter: 1 }));
});
