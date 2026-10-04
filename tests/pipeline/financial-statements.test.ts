import test from 'node:test';
import assert from 'node:assert/strict';
import {extractFilingDisclosures} from '../../shared/analysis-runtime/financial-data/disclosure-extraction.ts';
import {extractFinancialStatements} from '../../shared/analysis-runtime/financial-data/financial-statements.ts';
const source={ticker:'ORCL',accessionNumber:'0001193125-26-389274',documentUrl:'https://www.sec.gov/Archives/edgar/data/1341439/000119312526389274/orcl-20260831.htm',form:'10-Q',reportDate:'2026-08-31',filedAt:'2026-09-11'};
const extract=(html:string)=>extractFinancialStatements(html,extractFilingDisclosures(html,source));
const shell=(body:string)=>`<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:us-gaap="http://fasb.org/us-gaap/2026" xmlns:iso4217="http://www.xbrl.org/2003/iso4217"><ix:header><xbrli:context id="ytd"><xbrli:entity><xbrli:identifier scheme="https://www.sec.gov/CIK">1341439</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2026-01-01</xbrli:startDate><xbrli:endDate>2026-06-30</xbrli:endDate></xbrli:period></xbrli:context><xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit></ix:header>${body}</html>`;
test('whole statement item retains every row, merged header, original blank, comparative and note; no YTD conversion',()=>{
 const s=extract(shell(`<a href="#item_1">Financial Statements (Unaudited)</a><a href="#balance">Balance Sheets</a><a href="#item_2">Management Discussion</a><h2 id="item_1">Financial Statements</h2><h3 id="balance">Balance Sheets</h3><p>In millions, unaudited</p><table><tr><th rowspan="2">Item</th><th colspan="2">2026 and 2025</th></tr><tr><th>June</th><th>December</th></tr><tr><td>Cash (1)</td><td><ix:nonFraction id="cash" name="us-gaap:Cash" contextRef="ytd" unitRef="usd" scale="6">123</ix:nonFraction></td><td>—</td></tr><tr><td>Not disclosed</td><td></td><td>0</td></tr></table><h3>Notes</h3><p>(1) Restricted cash included.</p><table><tr><td>Untagged note</td><td>12.50</td></tr></table><h2 id="item_2">Management Discussion</h2><table><tr><td>Outside</td></tr></table>`));
 assert.equal(s.status,'extracted');assert.equal(s.tables.length,2);assert.equal(s.coverage.rows,5);assert.equal(s.coverage.cells,12);
 assert.equal(s.tables[0].rows[1].cells[0].column,1);assert.equal(s.tables[0].rows[0].cells[1].colSpan,2);
 const amount=s.tables[0].rows[2].cells[1];assert.equal(amount.text,'123');assert.equal(amount.facts[0].value,'123000000');assert.equal(amount.facts[0].period?.start,'2026-01-01');assert.equal(amount.facts[0].unit,'iso4217:USD');
 assert.equal(s.tables[0].rows[3].cells[1].text,'');assert.deepEqual(s.tables[0].rows[3].cells[2].facts,[]);assert.equal(s.tables[1].rows[0].cells[1].text,'12.50');assert.match(s.text,/Restricted cash included/);assert.doesNotMatch(s.text,/Outside/);assert.match(s.tables[0].precedingText,/In millions/);
});
test('annual Item 8 explicitly referring to Item 15 follows the actual statements, stops before exhibits',()=>{
 const s=extract(`<a href="#item_8">Financial Statements and Supplementary Data</a><a href="#item_9">Accountants</a><a href="#item_15">Exhibits and Financial Statement Schedules</a><a href="#balance">Balance Sheets</a><a href="#exhibits">Index of Exhibits</a><h2 id="item_8">Item 8. Financial Statements</h2><p>The response is submitted as a separate section. See Part IV, Item 15.</p><h2 id="item_9">Item 9.</h2><p>Outside financial section</p><h2 id="item_15">Item 15.</h2><h3 id="balance">Balance Sheets</h3><table><tr><td>Assets</td><td>100</td></tr></table><p>Final note.</p><h2 id="exhibits">Index of Exhibits</h2><table><tr><td>Agreement</td></tr></table>`);
 assert.equal(s.tables.length,1);assert.equal(s.locator?.elementId,'item_15');assert.match(s.text,/Final note/);assert.doesNotMatch(s.text,/Agreement|Outside financial section/);assert.deepEqual(s.coverage.issues,[]);
});
test('missing chapter and unresolvable annual reference are explicit gaps',()=>{
 assert.equal(extract('<table><tr><td>Assets</td></tr></table>').status,'not_located');
 const s=extract('<a href="#item_8">Financial Statements</a><a href="#item_9">Accountants</a><p id="item_8">Item 8. Separate section, see Item 15.</p><p id="item_9">Item 9</p>');
 assert.ok(s.coverage.issues.includes('REFERENCED_FINANCIAL_STATEMENTS_NOT_LOCATED'));assert.ok(s.coverage.issues.includes('NO_TABLES_IN_IDENTIFIED_FINANCIAL_STATEMENTS'));
});
test('all nested tables are retained without assigning inner rows to outer tables; scripts are not executed or shown',()=>{
 const s=extract('<a href="#item_1">Financial Statements</a><a href="#item_2">Discussion</a><h2 id="item_1">Statements</h2><table><tr><td>Outer<table><tr><td>Inner &amp; value</td></tr></table></td></tr></table><script>secret()</script><img src="chart.png"><h2 id="item_2">Discussion</h2>');
 assert.equal(s.tables.length,2);assert.equal(s.tables[0].rows.length,1);assert.equal(s.tables[1].rows[0].cells[0].text,'Inner & value');assert.doesNotMatch(s.text,/secret/);assert.ok(s.coverage.issues.includes('IMAGE_CONTENT_REQUIRES_REVIEW:1'));
});
