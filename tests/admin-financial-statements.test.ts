import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyStatementCategory, statementColumnLayout, statementRowText, statementUnitCaption, translateStatementLabel,
} from "../apps/admin/src/financial-statement-presentation.ts";
import type { StatementCell, StatementTable } from "../shared/analysis-runtime/financial-data/financial-statements.ts";

const locator = { start: 0, end: 1, elementId: null };
const cell = (column: number, text: string, options: Partial<StatementCell> = {}): StatementCell => ({
  column, text, colSpan: 1, rowSpan: 1, header: false, facts: [], locator, ...options,
});
const table = (rows: StatementCell[][], options: Partial<StatementTable> = {}): StatementTable => ({
  id: "source-table", title: "Source table", section: "Financial Statements", precedingText: "", locator,
  rows: rows.map(cells => ({ cells })), columns: Math.max(0, ...rows.flatMap(cells => cells.map(item => item.column + item.colSpan))), issues: [], ...options,
});

test("statement navigation follows explicit headings and never turns note or comprehensive income into an income statement", () => {
  assert.equal(classifyStatementCategory("Condensed Consolidated Statements of Operations and Comprehensive Loss"), "income");
  assert.equal(classifyStatementCategory("Condensed Consolidated Balance Sheets"), "balance");
  assert.equal(classifyStatementCategory("Consolidated Statements of Financial Position"), "balance");
  assert.equal(classifyStatementCategory("CONSOLIDATED STATEMENTS OF OPERATIONS"), "income");
  assert.equal(classifyStatementCategory("Consolidated Statements of Comprehensive Income"), "other");
  assert.equal(classifyStatementCategory("Consolidated Statements of Cash Flows"), "cashflow");
  assert.equal(classifyStatementCategory("Note 8. Income Taxes"), "notes");
  assert.equal(classifyStatementCategory("12. Cash Flows and Other Disclosures"), "notes");
  assert.equal(classifyStatementCategory("Selected Operating Statistics"), "other");
});

test("merged period headers can use compact decoration columns without dropping split signs, blanks, dashes or original values", () => {
  const source = table([
    [cell(0, "", { header: true }), cell(1, "Three months ended August 31, 2026", { colSpan: 5, header: true })],
    [cell(0, "Net income (loss)"), cell(1, "$"), cell(2, "("), cell(3, "1,234.50"), cell(4, ")"), cell(5, "")],
    [cell(0, "Other income"), cell(1, ""), cell(2, ""), cell(3, "—"), cell(4, ""), cell(5, "")],
    [cell(0, "Income tax expense"), cell(1, "$"), cell(2, ""), cell(3, "0"), cell(4, ""), cell(5, "")],
  ]);
  const original = structuredClone(source);
  assert.deepEqual(statementColumnLayout(source).map(column => column.kind), ["label", "decoration", "decoration", "data", "decoration", "empty"]);
  assert.deepEqual(source, original);
  assert.equal(statementRowText(source.rows[1]), "Net income (loss) $ ( 1,234.50 )");
  assert.equal(source.rows[0].cells[1].colSpan, 5);
  assert.equal(source.rows[2].cells[3].text, "—");
  assert.equal(source.rows[3].cells[3].text, "0");
});

test("row spans and merged numeric cells retain their actual occupied columns", () => {
  const source = table([
    [cell(0, "Assets", { rowSpan: 2 }), cell(1, "$"), cell(2, "12", { colSpan: 2 })],
    [cell(1, "$"), cell(2, "0"), cell(3, "—")],
    [cell(0, "Total assets", { colSpan: 2 }), cell(2, "12"), cell(3, "")],
  ]);
  const original = structuredClone(source);
  assert.deepEqual(statementColumnLayout(source).map(column => column.kind), ["label", "decoration", "data", "data"]);
  assert.deepEqual(source, original);
  assert.equal(source.rows[1].cells[0].column, 1);
});

test("known labels have display aliases while unfamiliar labels, periods, footnotes and numeric text survive", () => {
  assert.equal(translateStatementLabel("Condensed Consolidated Balance Sheets"), "资产负债表");
  assert.equal(translateStatementLabel("Cash and cash equivalents (1)"), "现金及现金等价物 (1)");
  assert.equal(translateStatementLabel("Current assets:"), "流动资产:");
  assert.equal(translateStatementLabel("TOTAL STOCKHOLDERS’ EQUITY"), "股东权益合计");
  for (const [original, translated] of [["Cloud", "云服务"], ["Software", "软件"], ["Hardware", "硬件"], ["Services", "服务"], ["Cloud and software", "云服务及软件"]]) {
    assert.equal(translateStatementLabel(original), translated);
  }
  for (const value of ["Three months ended August 31, 2026", "Year ended May 31, 2026", "Other bespoke non-GAAP charges", "1,000.00", "—", ""]) {
    assert.equal(translateStatementLabel(value), value);
  }
});

test("unit captions preserve explicit exceptions and never apply the XBRL scale again or guess absent units", () => {
  const source = table([[cell(0, "Revenues"), cell(1, "123", { facts: [{
    id: "revenue", concept: "us-gaap:Revenues", value: "123000000", scale: "6", status: "parsed",
    period: { kind: "duration", start: "2026-01-01", end: "2026-06-30" }, unit: "iso4217:USD", dimensions: [],
  }] })]], { precedingText: "CONSOLIDATED STATEMENTS OF OPERATIONS (In millions, except per share data) (Unaudited)" });
  const original = structuredClone(source);
  assert.equal(statementUnitCaption(source), "单位：百万，每股数据除外");
  assert.deepEqual(statementColumnLayout(source).map(column => column.kind), ["label", "data"]);
  assert.deepEqual(source, original);
  assert.equal(source.rows[0].cells[1].text, "123");
  assert.equal(source.rows[0].cells[1].facts[0].value, "123000000");
  assert.equal(statementUnitCaption(table([], { precedingText: "Statements of Operations ($ in millions, except per share data)" })), "单位：百万 $，每股数据除外");
  assert.equal(statementUnitCaption(table([], { precedingText: "In thousands of U.S. dollars" })), "单位：千美元");
  assert.equal(statementUnitCaption(table([], { precedingText: "USD in millions" })), "单位：百万美元");
  assert.equal(statementUnitCaption(table([], { precedingText: "U.S. dollars in millions" })), "单位：百万美元");
  assert.equal(statementUnitCaption(table([], { precedingText: "Dollars in millions" })), "Dollars in millions");
  assert.equal(statementUnitCaption(table([], { precedingText: "Canadian dollars in millions" })), "Canadian dollars in millions");
  assert.equal(statementUnitCaption(table([], { precedingText: "In thousands of Canadian dollars" })), "In thousands of Canadian dollars");
  assert.equal(statementUnitCaption(table([], { precedingText: "In millions, except share and per-share amounts" })), "单位：百万，股份数量及每股数据除外");
  assert.equal(statementUnitCaption(table([], { precedingText: "In millions, except a company-specific measure" })), "In millions, except a company-specific measure");
  assert.equal(statementUnitCaption(table([[cell(0, "Revenues"), cell(1, "123")]])), null);
});
