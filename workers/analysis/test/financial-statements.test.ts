import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFilingDisclosures } from "../../../shared/analysis-runtime/financial-data/disclosure-extraction.ts";
import { extractFinancialStatements } from "../../../shared/analysis-runtime/financial-data/financial-statements.ts";

const read = (html: string, form: string) => extractFinancialStatements(html, extractFilingDisclosures(html, { ticker: "INTC", accessionNumber: "0000050863-26-000191",
  documentUrl: "https://www.sec.gov/Archives/edgar/data/50863/000005086326000191/intc-20260926.htm", form, reportDate: "2026-09-26", filedAt: "2026-10-30" }));
const statement = (id: string, title: string) => `<div id="${id}"><table><tr><td>${title}</td></tr></table><table><tr><td>Total</td><td>1</td></tr></table></div>`;

// Intel's 10-Q: the contents link each statement by its page number, but the chapter heading above them links nowhere.
const intel = (links: boolean) => `<html><body><table>
  <tr><td>Consolidated Condensed Financial Statements and Supplemental Details</td><td></td></tr>
  ${[["ops", "Consolidated Condensed Statements of Operations", 3], ["bs", "Consolidated Condensed Balance Sheets", 5], ["cf", "Consolidated Condensed Statements of Cash Flows", 6], ["notes", "Notes to Consolidated Condensed Financial Statements", 9]]
    .map(([id, title, page]) => `<tr><td>${title}</td><td>${links ? `<a href="#${id}">${page}</a>` : page}</td></tr>`).join("")}
</table>
${statement("ops", "Consolidated Condensed Statements of Operations")}${statement("bs", "Consolidated Condensed Balance Sheets")}${statement("cf", "Consolidated Condensed Statements of Cash Flows")}
<div id="notes"><p>Notes to Consolidated Condensed Financial Statements</p><table><tr><td>Note</td><td>2</td></tr></table></div></body></html>`;

test("a periodic report that links its statements but not their chapter is read from the first statement", () => {
  const statements = read(intel(true), "10-Q");
  assert.equal(statements.status, "extracted");
  assert.deepEqual([...new Set(statements.tables.map(t => t.section))], ["Consolidated Condensed Statements of Operations", "Consolidated Condensed Balance Sheets",
    "Consolidated Condensed Statements of Cash Flows", "Notes to Consolidated Condensed Financial Statements"]);
});

test("without links to the statements or their chapter, the statements are not located", () => {
  assert.equal(read(intel(false), "10-Q").status, "not_located");
});
