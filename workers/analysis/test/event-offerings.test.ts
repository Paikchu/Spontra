import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompanyEvent, EventsPublication } from "../../../shared/analysis-contract/events.ts";
import { annotateEvent, classifyEvent, eventImportance, filingDocumentTitle, readEventsPublication } from "../../../shared/analysis-runtime/events.ts";
import { parseEventSubmissions } from "../src/events/workflow.ts";

const NOW = new Date("2026-11-03T00:00:00Z");

test("the rail lists offerings and proxies, and leaves soliciting material out", () => {
  const payload = { filings: { recent: {
    accessionNumber: ["0001193125-26-442729", "0001193125-26-442722", "0001193125-26-442669", "0001193125-26-435853", "0001193125-26-402831", "0001193125-26-402816"],
    form: ["424B5", "424B2", "S-3ASR", "8-K", "DEFA14A", "DEF 14A"],
    filingDate: ["2026-11-02", "2026-11-02", "2026-11-02", "2026-10-28", "2026-09-25", "2026-09-25"],
  } } };
  assert.deepEqual(parseEventSubmissions(payload, 1341439, NOW).map(f => f.form), ["424B5", "424B2", "S-3ASR", "8-K", "DEF 14A"]);
});

test("offerings have their own cap, so a structured-note stream never crowds out current reports", () => {
  const n = 120;
  const payload = { filings: { recent: {
    accessionNumber: [...Array.from({ length: n }, (_, i) => `0000019617-26-${String(1000 + i)}`), "0000019617-26-000001"],
    form: [...Array.from({ length: n }, () => "424B2"), "8-K"],
    filingDate: [...Array.from({ length: n }, () => "2026-10-30"), "2026-10-01"],
  } } };
  const forms = parseEventSubmissions(payload, 19617, NOW).map(f => f.form);
  assert.equal(forms.filter(f => f === "424B2").length, 20);
  assert.ok(forms.includes("8-K"));
});

test("offering forms are financing and proxies are votes, whatever the description says", () => {
  assert.equal(classifyEvent("424B5", [], "Prospectus supplement"), "financing");
  assert.equal(classifyEvent("S-3ASR", [], ""), "financing");
  assert.equal(classifyEvent("FWP", [], "dividend"), "financing");
  assert.equal(classifyEvent("DEF 14A", [], ""), "vote");
  assert.equal(filingDocumentTitle({ description: "424B5" }), null);
  assert.equal(filingDocumentTitle({ description: "DEF 14A" }), null);
});

const event = (id: string, form: CompanyEvent["form"], filedAt: string): CompanyEvent => annotateEvent({
  id, ticker: "ORCL", form, filedAt, eventDate: filedAt, items: [], class: classifyEvent(form, []), description: "",
  edgarUrl: "https://www.sec.gov/i", documentUrl: "https://www.sec.gov/d.htm", exhibits: [], summary: null, insider: null,
});

test("a prospectus supplement is key, a shelf is normal, and a program issuer's supplements are routine", () => {
  const few = [event("0001193125-26-442729", "424B5", "2026-11-02"), event("0001193125-26-442669", "S-3ASR", "2026-11-02")];
  assert.deepEqual(few.map(e => eventImportance(e, few)), ["key", "normal"]);
  const program = Array.from({ length: 13 }, (_, i) => event(`0000019617-26-${1000 + i}`, "424B2", "2026-10-30"));
  assert.equal(eventImportance(program[0]!, program), "routine");
  // ORCL's pace: twenty offering filings over twenty-two months (an ATM program, a bond deal every few months).
  const frequent = Array.from({ length: 20 }, (_, i) => event(`0001193125-26-${1000 + i}`, i % 2 ? "FWP" : "424B5", new Date(Date.parse("2026-11-02") - i * 33 * 86_400_000).toISOString().slice(0, 10)));
  assert.equal(eventImportance(frequent[0]!, frequent), "key");
});
