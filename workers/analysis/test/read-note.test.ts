import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { BusinessFlowQuarter, PublicBusinessFlow } from "../../../shared/analysis-contract/business-flow.ts";
import { collectNewFilings } from "../src/financial-data/collect.ts";
import type { CompleteStore, Job } from "../src/financial-data/store.ts";
import { applyNote, applyNoteKeeping, documentText, filingTables, noteLabels, readWithNote, relevantTables, type NoteContext, type ReadNote } from "../src/financial-data/read-note.ts";

// TTM Technologies' earnings release of October 22, 2026 (8-K, Exhibit 99.1): its columns are headed only "Third Quarter"
// and "2026", and its 52/53-week quarter ended September 28. Published before it: the quarters ended June 29 and March
// 30, 2026, and the revenue history.
const url = "https://www.sec.gov/Archives/edgar/data/1116942/000119312526428263/d282109dex991.htm";
const documents = [{ url, html: readFileSync(new URL("./fixtures/releases/ttmi-q3-2026.htm", import.meta.url), "utf8") }];
const known = JSON.parse(readFileSync(new URL("./fixtures/releases/ttmi-published-2026-06-29.json", import.meta.url), "utf8")) as { published: BusinessFlowQuarter[]; history: NoteContext["history"] };
const context: NoteContext = { tables: filingTables(documents), text: documentText(documents), published: known.published, history: known.history,
  source: { accession: "0001193125-26-428263", url: "https://www.sec.gov/Archives/edgar/data/1116942/000119312526428263/d282109d8k.htm", filedAt: "2026-10-22", form: "8-K" } };
const statement = 16, segments = 17;
const at = (table: number, rows: Array<[string, number, (1 | -1)?]>) => rows.map(([slot, row, sign]) => ({ slot, table, row, sign: sign ?? 1 }));
// What a correct note says: the statement and the segment table, current column 0; code finds the year-ago column 1.
const note: ReadNote = {
  period: { end: "2026-09-28", quote: "today reported results for the third quarter of 2026, which ended on September 28, 2026" },
  tables: [statement, segments].map(table => ({ table, unit: "thousands" as const, current: 0 })),
  items: [
    ...at(statement, [["figure:revenue", 3], ["figure:cost", 4], ["figure:gross", 5], ["figure:operatingExpenses", 12], ["figure:operating", 13], ["figure:pretax", 18], ["figure:tax", 19, -1], ["figure:net", 20],
      ["figure:sales", 7], ["figure:administration", 8], ["figure:research", 9], ["expense:SellingAndMarketingExpense", 7], ["expense:GeneralAndAdministrativeExpense", 8],
      ["expense:ResearchAndDevelopmentExpense", 9], ["expense:AmortizationOfIntangibleAssetsOperating", 10], ["expense:RestructuringCharges", 11], ["other:InterestExpenseNonoperating", 14],
      ["other:GainsLossesOnExtinguishmentOfDebt", 15], ["other:UnrealizedGainLossOnDerivatives", 16], ["other:OtherNonoperatingIncomeExpense", 17]]),
    ...at(segments, [["segment:ttmi:AerospaceAndDefenseMember", 16], ["segment:ttmi:CommercialMember", 17], ["adjustment:intersegment-eliminations", 18]]),
  ],
};
const value = (q: BusinessFlowQuarter | null, key: keyof BusinessFlowQuarter["figures"]) => Number(q?.figures[key]?.value);

test("only the tables that print an already published amount are sent, as compact text", () => {
  assert.deepEqual(relevantTables(context.tables, context).map(t => t.id), [16, 17, 18]);
  assert.deepEqual(context.tables[statement]!.rows[3], ["Net sales", "1,203,855", "752,736", "3,053,885", "2,132,025"]);
  assert.deepEqual(context.tables[statement]!.rows[14], ["Interest expense", "(12,809)", "(10,399)", "(33,905)", "(32,958)"]);
});

test("a correct note reads the quarter the release reports, reconciled against its totals and the published year-ago quarter", () => {
  const { quarter, issues } = applyNote(note, context);
  assert.deepEqual(issues, []);
  assert.equal(quarter?.periodStart, "2026-06-30");
  assert.equal(quarter?.periodEnd, "2026-09-28");
  assert.deepEqual([value(quarter, "revenue"), value(quarter, "operating"), value(quarter, "pretax"), value(quarter, "tax"), value(quarter, "net")], [1203855000, 162253000, 141701000, 56898000, 84803000]);
  assert.equal(quarter?.figures.other?.basis, "derived");
  assert.deepEqual(quarter?.segments.map(s => [s.id, Number(s.revenue?.value)]), [["ttmi:AerospaceAndDefenseMember", 416540000], ["ttmi:CommercialMember", 787882000]]);
  assert.deepEqual(quarter?.revenueAdjustments?.map(a => Number(a.amount.value)), [-567000]);
  assert.equal(quarter?.figures.revenue?.lineage?.[0].contextId, "table-16:row-3:column-0");
  assert.equal(quarter?.sources[0].id, "0001193125-26-428263");
});

test("a note with the wrong unit, a cumulative column or a period the filing does not state is refused", () => {
  const unit = applyNote({ ...note, tables: note.tables.map(t => ({ ...t, unit: "millions" as const })) }, context);
  assert.equal(unit.quarter, null);
  assert.match(unit.issues[0]!, /repeats an already published quarter's revenue/);
  // The nine-month column balances every total too; only the cumulative check tells it is not a quarter.
  const cumulative = applyNote({ ...note, tables: note.tables.map(t => ({ ...t, current: 2 })) }, context);
  assert.equal(cumulative.quarter, null);
  assert.match(cumulative.issues.join(" "), /not a three-month amount/);
  const invented = applyNote({ ...note, period: { end: "2026-09-28", quote: "The third quarter ended on September 28, 2026" } }, context);
  assert.match(invented.issues.join(" "), /not a verbatim passage/);
  const swapped = applyNote({ ...note, items: note.items.map(i => (i.slot === "figure:cost" ? { ...i, row: 5 } : i)) }, context);
  assert.match(swapped.issues.join(" "), /do not reconcile/);
});

test("a revenue row that also prints currency or percentage columns is read; a cumulative column is refused even when the year's earlier quarters are not all known", () => {
  // GOOGL's constant-currency table: next to the quarter it prints an FX-adjusted amount and percentages, none cumulative.
  const rows = context.tables[statement]!.rows.map((r, i) => (i === 3 ? ["Net sales", "1,203,855", "752,736", "1,210,000", "60"] : r));
  const fx = { ...context, tables: context.tables.map(t => (t.id === statement ? { ...t, rows } : t)) };
  assert.deepEqual(applyNote(note, fx).issues, []);
  // The revenue history stops before the newest quarter's year (TTMI's did): the year-ago nine-month column, the anchor
  // plus its year's earlier quarters, still tells which column pairs with the anchor.
  // Production's history also holds the quarter ended March 31, 2025, which the year-ago nine months need.
  const march = { ...context.history.find(q => q.periodEnd === "2025-06-30")!, periodStart: "2024-12-31", periodEnd: "2025-03-31", revenue: "648668000", segments: [] };
  const gap = { ...context, published: context.published.slice(0, 1), history: [march, ...context.history.filter(q => q.periodEnd < "2025-12-01")] };
  assert.deepEqual(applyNote(note, gap).issues, []);
  const nine = applyNote({ ...note, tables: note.tables.map(t => ({ ...t, current: 2 })) }, gap);
  assert.match(nine.issues.join(" "), /column 2 is not a three-month amount/);
});

test("proposed new lines the statement does not need are left out, and net income must add up in the year-to-date column", () => {
  // An operating-income row offered as a new segment (Alphabet's "Alphabet-level activities") breaks the segment total.
  const offered = { ...note, new: [{ group: "segment" as const, name: "Aerospace & Defense", table: segments, row: 21 }] };
  assert.notDeepEqual(applyNote(offered, context).issues, []);
  const kept = applyNoteKeeping(offered, context);
  assert.deepEqual([kept.issues, kept.note.new], [[], []]);
  assert.equal(value(kept.quarter, "revenue"), 1203855000);
  // A net income row whose nine months are not the quarter plus the two published quarters is the wrong row.
  const rows = context.tables[statement]!.rows.map((r, i) => (i === 20 ? ["Net income", "84,803", "53,055", "217,000", "126,763"] : r));
  const other = applyNote(note, { ...context, tables: context.tables.map(t => (t.id === statement ? { ...t, rows } : t)) });
  assert.match(other.issues.join(" "), /figure:net: T16 R20 column 2 reads 217000 thousands/);
});

test("the model's problems go back to it, and a corrected note is read on the next turn", async () => {
  const answers: unknown[] = [{ ...note, tables: note.tables.map(t => ({ ...t, unit: "millions" })) }, note];
  const payloads: Array<Record<string, unknown>> = [];
  const outcome = await readWithNote(context, async (_stage, _system, payload) => { payloads.push(payload as Record<string, unknown>); return answers.shift() as Record<string, unknown>; }, { ticker: "TTMI" });
  assert.equal(outcome.route, "full");
  assert.equal(outcome.attempts, 2);
  assert.equal(value(outcome.quarter, "revenue"), 1203855000);
  assert.match(JSON.stringify(payloads[1]!.previousAnswers), /repeats an already published quarter's revenue/);
  // The turned-down note is returned with its problems, for the stored record.
  assert.deepEqual(outcome.rejected.map(r => r.route), ["full"]);
  assert.match(outcome.rejected[0]!.problems[0]!, /repeats an already published quarter's revenue/);
  assert.equal((outcome.rejected[0]!.note as ReadNote).tables[0]!.unit, "millions");
  assert.ok(String(payloads[0]!.tables).length < 9000);
});

test("the next filing of the same kind reuses the note by its row labels; a release asks the model for its period alone", async () => {
  const previous = { note, labels: noteLabels(note, context.tables) };
  let calls = 0;
  const reused = await readWithNote(context, async () => { calls++; return {}; }, { ticker: "TTMI", previous, reportDate: "2026-09-28" });
  assert.equal(reused.route, "reuse");
  assert.equal(calls, 0);
  assert.equal(value(reused.quarter, "net"), 84803000);
  // Without a report date the release names several dates after June 29 (September 28 and 30, October 9): one question settles it.
  const asked = await readWithNote(context, async (_stage, system) => { calls++; assert.match(system, /end date of the newest three-month period/);
    return { end: "2026-09-28", quote: "today reported results for the third quarter of 2026, which ended on September 28, 2026" }; }, { ticker: "TTMI", previous });
  assert.equal(asked.route, "period");
  assert.equal(calls, 1);
  assert.equal(asked.quarter?.periodEnd, "2026-09-28");
});

test("collection publishes the new quarter on top of the newest published one, and ends without publishing when nothing is new", async () => {
  const job: Job = { id: "j", cik: "0001116942", ticker: "TTMI", generation: 1, lease: "l", cursor: "{}", attempt: 0 };
  const current: PublicBusinessFlow = { schemaVersion: "business-flow.v1", ticker: "TTMI", fetchedAt: null, quarters: known.published };
  const published: PublicBusinessFlow[] = [], finished: string[][] = [];
  const store: CompleteStore = { stage: async () => {}, staged: async () => [], publish: async (_job, flow) => { published.push(flow); return true; }, defer: async () => {}, finish: async (_job, reasons) => { finished.push(reasons); } };
  const read = async () => ({ ...applyNote(note, context) });
  const result = await collectNewFilings(job, current, store, [{ accession: "0001193125-26-428263" }], read);
  assert.equal(result.published, true);
  assert.deepEqual(published[0]!.quarters.map(q => q.periodEnd), ["2026-09-28", "2026-06-29"]);
  const none = await collectNewFilings(job, current, store, [], read);
  assert.equal(none.published, false);
  assert.deepEqual(finished, [["UP_TO_DATE"]]);
});

test("a filing that prints no published amount in any table reports no quarter, without a model call", async () => {
  // A 6-K notice: text and a table of share counts, nothing that repeats a published amount.
  const notice = [{ url, html: "<p>Results of the annual general meeting.</p><table><tr><td>Shares voted</td><td>1,234,567</td></tr></table>" }];
  let calls = 0;
  const outcome = await readWithNote({ ...context, tables: filingTables(notice), text: documentText(notice) }, async () => { calls++; return {}; }, { ticker: "TTMI" });
  assert.equal(calls, 0);
  assert.equal(outcome.nothing, true);
  assert.deepEqual(outcome.issues, []);
});
