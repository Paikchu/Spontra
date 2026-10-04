import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DISCLOSURE_EXTRACTION_VERSION,
  extractFilingDisclosures,
  type DisclosureSource,
} from "../../shared/analysis-runtime/financial-data/disclosure-extraction.ts";

const source: DisclosureSource = { ticker: "ORCL", accessionNumber: "0001341439-26-000001", documentUrl: "https://www.sec.gov/Archives/edgar/data/1341439/example.htm", form: "10-Q", reportDate: "2026-02-28", filedAt: "2026-03-10" };
const namespaces = `xmlns="http://www.w3.org/1999/xhtml" xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:us-gaap="http://fasb.org/us-gaap/2026" xmlns:orcl="http://www.oracle.com/20260228" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:ixt="http://www.xbrl.org/inlineXBRL/transformation/2022-02-16"`;
const context = (id = "quarter", period = "<xbrli:startDate>2025-12-01</xbrli:startDate><xbrli:endDate>2026-02-28</xbrli:endDate>", dimensions = "") => `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">1341439</xbrli:identifier>${dimensions ? `<xbrli:segment>${dimensions}</xbrli:segment>` : ""}</xbrli:entity><xbrli:period>${period}</xbrli:period></xbrli:context>`;
const resources = `${context()}<xbrli:unit id="USD"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>`;
const document = (body: string, extraResources = "") => `<html ${namespaces}><body><ix:header><ix:resources>${resources}${extraResources}</ix:resources></ix:header>${body}</body></html>`;
const numeric = (value: string, attrs = "") => `<ix:nonFraction name="us-gaap:Revenue" contextRef="quarter" unitRef="USD" ${attrs}>${value}</ix:nonFraction>`;

test("retains every tagged fact with exact decimal values, period, source, and immutable input", () => {
  const html = document(`${numeric("9,007,199,254,740,993.25", 'format="ixt:num-dot-decimal" scale="6" sign="-" decimals="-6" id="amount"')}<ix:nonNumeric name="orcl:CloudDisclosure" contextRef="quarter">Cloud &amp; software</ix:nonNumeric>`);
  const result = extractFilingDisclosures(html, source);
  assert.equal(result.version, DISCLOSURE_EXTRACTION_VERSION);
  assert.equal(result.coverage.encountered, 2);
  assert.equal(result.coverage.retained, 2);
  assert.equal(result.coverage.parsed, 2);
  assert.equal(result.facts[0].numericValue, "-9007199254740993250000");
  assert.equal(result.facts[0].decimals, "-6");
  assert.equal(result.facts[0].context?.period.start, "2025-12-01");
  assert.equal(result.facts[0].context?.period.end, "2026-02-28");
  assert.equal(result.facts[0].unit?.numerator[0].name, "iso4217:USD");
  assert.equal(result.facts[0].classification, "unclassified");
  assert.equal(result.facts[0].source.accessionNumber, source.accessionNumber);
  const location = result.facts[0].source.locator;
  assert.equal(html.slice(location.start, location.end), result.facts[0].rawHtml);
  assert.equal(location.elementId, "amount");
  assert.equal(result.facts[1].rawValue, "Cloud & software");
  assert.equal(result.coverage.custom, 1);
  assert.equal(result.coverage.standard, 1);
  assert.deepEqual(extractFilingDisclosures(html, source), result, "stable ids and counts across retries");
});

test("preserves zero, nil, and invalid/unreported values as distinct states", () => {
  const result = extractFilingDisclosures(document([
    numeric("—", 'format="ixt:fixed-zero"'), numeric("", 'xsi:nil="true"'), numeric(""), numeric("—"), numeric("0"), numeric("", 'xsi:nil="1"'), numeric("2", 'xsi:nil="false"'),
  ].join("")), source);
  assert.deepEqual(result.facts.map((fact) => fact.numericValue), ["0", null, null, null, "0", null, "2"]);
  assert.deepEqual(result.facts.map((fact) => fact.status), ["parsed", "nil", "unsupported", "unsupported", "parsed", "nil", "parsed"]);
  assert.equal(result.coverage.nil, 2);
  assert.equal(result.coverage.unsupported, 2);
});

test("retains annual/YTD/instant/forever periods without deriving quarters", () => {
  const periods = [
    context("year", "<xbrli:startDate>2025-06-01</xbrli:startDate><xbrli:endDate>2026-05-31</xbrli:endDate>"),
    context("ytd", "<xbrli:startDate>2025-06-01</xbrli:startDate><xbrli:endDate>2026-02-28</xbrli:endDate>"),
    context("instant", "<xbrli:instant>2026-02-28</xbrli:instant>"), context("forever", "<xbrli:forever/>"),
  ].join("");
  const body = ["year", "ytd", "instant", "forever"].map((id) => numeric("12").replace('contextRef="quarter"', `contextRef="${id}"`)).join("");
  const result = extractFilingDisclosures(document(body, periods), source);
  assert.deepEqual(result.facts.map((fact) => fact.context?.period), [
    { kind: "duration", start: "2025-06-01", end: "2026-05-31" }, { kind: "duration", start: "2025-06-01", end: "2026-02-28" },
    { kind: "instant", start: null, end: "2026-02-28" }, { kind: "forever", start: null, end: null },
  ]);
  assert.equal(result.coverage.parsed, 4);
  assert.ok(result.coverage.checklist.some((item) => item.area === "cash_flow" && item.status === "not_classified"));
});

test("retains explicit and typed dimensions without treating them as consolidated", () => {
  const dimensions = `<xbrldi:explicitMember dimension="us-gaap:ProductOrServiceAxis">orcl:CloudInfrastructureMember</xbrldi:explicitMember><xbrldi:typedMember dimension="orcl:ContractAxis"><orcl:ContractIdentifier>A&amp;B-2026</orcl:ContractIdentifier></xbrldi:typedMember>`;
  const result = extractFilingDisclosures(document(numeric("15").replace('contextRef="quarter"', 'contextRef="segment"'), context("segment", undefined, dimensions)), source);
  const fact = result.facts[0];
  assert.equal(fact.status, "parsed");
  assert.equal(fact.context?.dimensions.length, 2);
  assert.equal(fact.context?.dimensions[0].member?.name, "orcl:CloudInfrastructureMember");
  assert.equal(fact.context?.dimensions[1].value, "A&B-2026");
  assert.match(fact.context?.dimensions[1].rawHtml ?? "", /ContractIdentifier/);
  assert.equal(result.coverage.dimensional, 1);
  assert.equal(result.coverage.typedDimensional, 1);
});

test("resolves namespace aliases and scoped custom namespaces, not hardcoded prefixes", () => {
  const html = document(numeric("1") + `<ix:nonFraction xmlns:us-gaap="https://custom.example/taxonomy/2026" name="us-gaap:Revenue" contextRef="quarter" unitRef="USD">2</ix:nonFraction>`).replaceAll("ix:", "inline:").replace("xmlns:ix=", "xmlns:inline=").replaceAll("xbrli:", "instance:").replace("xmlns:xbrli=", "xmlns:instance=");
  const result = extractFilingDisclosures(html, source);
  assert.equal(result.facts.length, 2);
  assert.deepEqual(result.facts.map((fact) => fact.taxonomy), ["standard", "custom"]);
  assert.equal(result.facts[1].concept.namespaceUri, "https://custom.example/taxonomy/2026");
  assert.equal(result.coverage.parsed, 2);
});

test("retains divided units and fraction numerator/denominator without rounded division", () => {
  const perShare = `<xbrli:unit id="perShare"><xbrli:divide><xbrli:unitNumerator><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unitNumerator><xbrli:unitDenominator><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unitDenominator></xbrli:divide></xbrli:unit>`;
  const result = extractFilingDisclosures(document(numeric("1.23").replace('unitRef="USD"', 'unitRef="perShare"') + `<ix:fraction name="orcl:Ratio" contextRef="quarter" unitRef="perShare"><ix:numerator>1</ix:numerator><ix:denominator>3</ix:denominator></ix:fraction>`, perShare), source);
  assert.deepEqual(result.facts[0].unit?.denominator, [{ name: "xbrli:shares", namespaceUri: "http://www.xbrl.org/2003/instance" }]);
  assert.deepEqual(result.facts[1].fraction, { numerator: "1", denominator: "3" });
  assert.equal(result.facts[1].normalizedValue, "1/3");
  assert.equal(result.facts[1].numericValue, null);
  assert.equal(result.coverage.parsed, 2);
});

test("retains negative scale and locale transformations without inferring signs from parentheses", () => {
  const result = extractFilingDisclosures(document(numeric("1.234,50", 'format="ixt:num-comma-decimal" scale="-2"') + numeric("0.5", 'scale="-3"') + numeric("(40)", 'format="ixt:num-dot-decimal"')), source);
  assert.deepEqual(result.facts.map((fact) => fact.numericValue), ["12.345", "0.0005", null]);
  assert.equal(result.facts[2].status, "unsupported");
});

test("joins continuation chains, excludes ix:exclude, and retains all source spans", () => {
  const body = `<ix:nonNumeric id="note" name="orcl:Disclosure" contextRef="quarter" continuedAt="part2"><p>First <b>part</b><ix:exclude> OMIT THIS </ix:exclude>.</p></ix:nonNumeric><ix:continuation id="part2" continuedAt="part3"><p>Second.</p></ix:continuation><ix:continuation id="part3"><p>Third.</p></ix:continuation>`;
  const result = extractFilingDisclosures(document(body), source);
  assert.equal(result.facts[0].normalizedValue?.replace(/\s+/g, " ").trim(), "First part. Second. Third.");
  assert.doesNotMatch(result.facts[0].rawValue, /OMIT/);
  assert.match(result.facts[0].rawHtml, /OMIT THIS/);
  assert.equal(result.facts[0].source.continuations.length, 2);
  assert.equal(result.coverage.continuations, 2);
  assert.equal(result.coverage.resolvedContinuations, 2);
  assert.equal(result.coverage.unsupported, 0);
});

test("reports missing, cyclic, duplicated and orphan continuations without losing facts", () => {
  const body = `<ix:nonNumeric name="orcl:Disclosure" contextRef="quarter" continuedAt="loop">a</ix:nonNumeric><ix:continuation id="loop" continuedAt="loop">b</ix:continuation><ix:nonNumeric name="orcl:Other" contextRef="quarter" continuedAt="missing">c</ix:nonNumeric><ix:nonNumeric name="orcl:More" contextRef="quarter" continuedAt="dup">d</ix:nonNumeric><ix:continuation id="dup">e</ix:continuation><ix:continuation id="dup">f</ix:continuation><ix:continuation id="unused">orphan content</ix:continuation>`;
  const result = extractFilingDisclosures(document(body), source);
  assert.equal(result.coverage.retained, 3);
  assert.equal(result.coverage.unsupported, 3);
  assert.equal(result.coverage.issueCounts.continuation_cycle, 1);
  assert.equal(result.coverage.issueCounts.missing_continuation, 1);
  assert.equal(result.coverage.issueCounts.ambiguous_continuation, 1);
  assert.equal(result.coverage.issueCounts.unreferenced_continuation, 3);
  assert.match(result.documentText, /orphan content/);
});

test("unknown transformations preserve text and attributes with explicit issues", () => {
  const result = extractFilingDisclosures(document(numeric("twenty", 'format="ixt:num-words" data-custom="keep"') + `<ix:nonNumeric name="orcl:Date" contextRef="quarter" format="ixt:date-monthname-day-year-en">February 28, 2026</ix:nonNumeric>`), source);
  assert.equal(result.coverage.unsupported, 2);
  assert.equal(result.coverage.issueCounts.unsupported_transform, 2);
  assert.equal(result.facts[0].attributes["data-custom"], "keep");
  assert.equal(result.facts[1].rawValue, "February 28, 2026");
  assert.equal(result.facts[1].normalizedValue, null);
});

test("unknown namespace cannot impersonate a supported numeric transformation", () => {
  const result = extractFilingDisclosures(document(numeric("1,234", 'xmlns:evil="https://example.org/transform" format="evil:num-dot-decimal"')), source);
  assert.equal(result.facts[0].numericValue, null);
  assert.equal(result.coverage.issueCounts.unsupported_transform, 1);
});

test("missing and duplicate references remain explicit rather than selecting arbitrary data", () => {
  const body = numeric("5").replace('contextRef="quarter"', 'contextRef="missing"') + numeric("6").replace('unitRef="USD"', 'unitRef="missing"') + numeric("7");
  const result = extractFilingDisclosures(document(body, context()), source);
  assert.equal(result.coverage.retained, 3);
  assert.equal(result.coverage.issueCounts.missing_context, 1);
  assert.equal(result.coverage.issueCounts.ambiguous_context, 2);
  assert.equal(result.coverage.issueCounts.missing_unit, 1);
  assert.equal(result.facts[2].context, null);
});

test("retains nil self-closing facts, hidden values, footnotes, and relationships", () => {
  const body = `<ix:hidden><ix:nonNumeric id="hidden" name="orcl:Flag" contextRef="quarter" format="ixt:fixed-true" xml:lang="en">checked</ix:nonNumeric></ix:hidden><ix:nonFraction name="us-gaap:Revenue" contextRef="quarter" unitRef="USD" xsi:nil="true"/><ix:footnote id="fn1">See note 1 &amp; 2.</ix:footnote><ix:relationship fromRefs="hidden" toRefs="fn1" arcrole="http://www.xbrl.org/2003/arcrole/fact-footnote"/>`;
  const result = extractFilingDisclosures(document(body), source);
  assert.equal(result.coverage.encountered, 2);
  assert.equal(result.facts[0].hidden, true);
  assert.equal(result.facts[0].language, "en");
  assert.equal(result.facts[0].normalizedValue, "true");
  assert.equal(result.facts[1].nil, true);
  assert.equal(result.facts[1].status, "nil");
  assert.equal(result.footnotes[0].text, "See note 1 & 2.");
  assert.equal(result.relationships[0].attributes.toRefs, "fn1");
});

test("untagged HTML explicitly reports unstructured coverage and retains text", () => {
  const result = extractFilingDisclosures(`<html><body><h1>Earnings release</h1><p>Remaining performance obligations were $138 billion.</p><table><tr><td>Revenue</td><td>12,500</td></tr></table></body></html>`, source);
  assert.equal(result.coverage.encountered, 0);
  assert.equal(result.coverage.tables, 1);
  assert.equal(result.coverage.paragraphs, 1);
  assert.equal(result.coverage.issueCounts.no_inline_facts, 1);
  assert.match(result.documentText, /Revenue 12,500/);
  assert.match(result.documentText, /\$138 billion/);
  assert.ok(result.coverage.checklist.some((item) => item.area === "non_xbrl_tables_and_narrative" && item.status === "not_structured"));
});

test("does not treat markup in scripts, style, or comments as disclosed facts", () => {
  const result = extractFilingDisclosures(document(`<script>const s = '${numeric("999")}';</script><style>/* ${numeric("888")} */</style><!-- ${numeric("777")} -->${numeric("1", 'data-value="a > b"')}`), source);
  assert.equal(result.coverage.retained, 1);
  assert.equal(result.facts[0].numericValue, "1");
  assert.doesNotMatch(result.documentText, /999|888|777|const s/);
});

test("malformed and native-XBRL facts are retained with explicit unsupported issues", () => {
  const result = extractFilingDisclosures(document(`<us-gaap:Revenue contextRef="quarter" unitRef="USD">3</us-gaap:Revenue><ix:nonFraction name="us-gaap:Revenue" contextRef="quarter" unitRef="USD">4`), source);
  assert.equal(result.coverage.retained, 2);
  assert.equal(result.coverage.issueCounts.unsupported_fact_element, 1);
  assert.equal(result.coverage.issueCounts.malformed_fact, 1);
  assert.equal(result.coverage.unsupported, 2);
});

test("invalid scale, signs, decimals and entities never silently become trusted values", () => {
  const result = extractFilingDisclosures(document(numeric("3", 'scale="1.5"') + numeric("4", 'scale="1001"') + numeric("5", 'sign="+"') + numeric("6", 'decimals="unknown"') + numeric("&notknown;")), source);
  assert.equal(result.coverage.encountered, 5);
  assert.equal(result.coverage.unsupported, 5);
  assert.equal(result.coverage.issueCounts.unsupported_scale, 2);
  assert.equal(result.coverage.issueCounts.invalid_sign, 1);
  assert.equal(result.coverage.issueCounts.invalid_decimals, 1);
  assert.equal(result.coverage.issueCounts.unresolved_entity, 1);
});

test("existing ORCL excerpt preserves every fact even without namespace declarations", async () => {
  const html = await readFile(new URL("./fixtures/orcl-2026-q1-sec-xbrl.html", import.meta.url), "utf8");
  const result = extractFilingDisclosures(html, source);
  const expected = [...html.matchAll(/<ix:(?:nonFraction|nonNumeric|fraction)\b/gi)].length;
  assert.ok(expected > 0);
  assert.equal(result.coverage.encountered, expected);
  assert.equal(result.coverage.retained, expected);
  assert.equal(result.coverage.parsed + result.coverage.nil + result.coverage.unsupported, expected);
  assert.ok(result.facts.every((fact) => fact.rawHtml && fact.source.documentUrl));
});

test("rejects impossible calendar dates instead of normalizing them into another month", () => {
  const invalid = context("invalid", "<xbrli:startDate>2025-02-30</xbrli:startDate><xbrli:endDate>2025-05-31</xbrli:endDate>");
  const leap = context("leap", "<xbrli:instant>2024-02-29</xbrli:instant>");
  const invalidLeap = context("invalidLeap", "<xbrli:instant>2025-02-29</xbrli:instant>");
  const timestamp = context("timestamp", "<xbrli:instant>2026-02-28T00:00:00Z</xbrli:instant>");
  const result = extractFilingDisclosures(document(["invalid", "leap", "invalidLeap", "timestamp"].map((id) => numeric("1").replace('contextRef="quarter"', `contextRef="${id}"`)).join(""), invalid + leap + invalidLeap + timestamp), source);
  assert.deepEqual(result.facts.map((fact) => fact.status), ["unsupported", "parsed", "unsupported", "parsed"]);
  assert.equal(result.coverage.issueCounts.invalid_period, 2);
  assert.equal(result.facts[0].context?.period.start, "2025-02-30", "retain invalid source verbatim");
});

test("fact identity includes document URL as well as accession and offset", () => {
  const html = document(numeric("10"));
  const first = extractFilingDisclosures(html, source);
  const exhibit = extractFilingDisclosures(html, { ...source, documentUrl: source.documentUrl.replace("example.htm", "ex99-1.htm") });
  assert.notEqual(first.facts[0].id, exhibit.facts[0].id);
  assert.equal(first.facts[0].source.locator.start, exhibit.facts[0].source.locator.start);
});

test("invalid numeric grouping does not silently change the number", () => {
  const result = extractFilingDisclosures(document(["1,,2", "1,23", "1 234", "1,234.5"].map((value) => numeric(value, 'format="ixt:num-dot-decimal"')).join("")), source);
  assert.deepEqual(result.facts.map((fact) => fact.numericValue), [null, null, "1234", "1234.5"]);
  assert.equal(result.coverage.issueCounts.invalid_numeric, 2);
});

test("escaped ampersands are literal text, not recursively decoded entities", () => {
  const result = extractFilingDisclosures(document(`<ix:nonNumeric name="orcl:Text" contextRef="quarter">Literal &amp;example; symbol<ix:exclude>visible commentary</ix:exclude></ix:nonNumeric>`), source);
  assert.equal(result.facts[0].rawValue, "Literal &example; symbol");
  assert.equal(result.facts[0].status, "parsed");
  assert.match(result.documentText, /visible commentary/);
});

test("unsupported tuples are retained together with nested atomic facts", () => {
  const result = extractFilingDisclosures(document(`<ix:tuple name="orcl:MetricTuple" tupleID="metrics">${numeric("10")}</ix:tuple>`), source);
  assert.equal(result.coverage.encountered, 2);
  assert.equal(result.coverage.retained, 2);
  assert.equal(result.facts[0].kind, "unsupported");
  assert.equal(result.facts[1].numericValue, "10");
  assert.equal(result.coverage.issueCounts.unsupported_fact_element, 1);
});
