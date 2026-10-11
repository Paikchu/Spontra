import { test } from "node:test";
import assert from "node:assert/strict";
import { libraryHash, parseFilingDocument } from "../../../shared/analysis-runtime/filing-library/parse.ts";

const p = (text: string, style = "") => `<p style="font-size:10pt;${style}"><span style="font-size:10pt">${text}</span></p>`;
const bold = (text: string) => `<p style="font-size:10pt"><span style="font-weight:bold;font-size:10pt">${text}</span></p>`;
const italic = (text: string) => `<p style="font-size:10pt"><span style="font-style:italic;font-weight:bold;font-size:10pt">${text}</span></p>`;
const top = (text: string) => `<p style="font-size:10pt;text-align:center"><span style="text-decoration:underline;font-size:10pt">${text}</span></p>`;
const pageBreak = (n: number) => `<p style="text-align:center">${n}</p><hr style="page-break-after:always"/><p><a href="#toc">Table of Contents</a></p>`;
const filler = (words: number, seed: string) => Array.from({ length: words }, (_, i) => `${seed}${i % 7}`).join(" ") + ".";
const risk = (title: string) => `<p style="font-size:10pt"><span style="font-weight:bold;font-style:italic">${title}.</span><span> ${filler(160, "risk")}</span></p>`;

const html = `<html><body>
<div style="display:none"><ix:header><ix:hidden><ix:nonNumeric name="dei:DocumentType">10-K</ix:nonNumeric></ix:hidden></ix:header></div>
${p("UNITED STATES SECURITIES AND EXCHANGE COMMISSION")}${p("FORM 10-K")}
<table id="toc"><tr><td><a href="#i1">Item 1.</a></td><td><a href="#i1">Business</a></td><td>3</td></tr><tr><td><a href="#i1a">Item 1A.</a></td><td><a href="#i1a">Risk Factors</a></td><td>5</td></tr>
<tr><td><a href="#i7">Item 7.</a></td><td><a href="#i7">MD&amp;A</a></td><td>9</td></tr><tr><td><a href="#i8">Item 8.</a></td><td><a href="#i8">Financial Statements</a></td><td>12</td></tr></table>
${top("NOTE ABOUT FORWARD-LOOKING STATEMENTS")}${p(filler(40, "caution"))}
${pageBreak(2)}
<p id="i1" style="text-align:center"><span style="font-weight:bold">ITEM 1. B</span><span style="font-weight:bold">USINESS</span></p>
${top("GENERAL")}${p(filler(60, "general"))}
${top("OPERATING SEGMENTS")}${p(filler(30, "segments"))}
${bold("Intelligent Cloud")}${p(filler(20, "cloud"))}
${italic("Server Products and Cloud Services")}${p("Server products and cloud services include Azure and other cloud services, SQL Server and Windows Server.")}
${italic("XBOX")}${p(filler(50, "gaming"))}
${italic("Competition")}${p(filler(60, "rivals"))}
${pageBreak(3)}
${top("HUMAN CAPITAL RESOURCES")}${p(filler(50, "people"))}
<p id="i1a"><span style="font-weight:bold">ITEM 1A. RISK FACTORS</span></p>
${top("STRATEGIC AND COMPETITIVE RISKS")}${risk("We face intense competition")}${risk("Our strategy requires substantial investments")}${risk("Acquisitions may not succeed")}${risk("We may not retain talent")}${risk("Demand may change")}${risk("Cloud margins may fall")}${risk("Prices may decline")}${risk("Partners may leave")}${risk("Regulators may intervene")}${risk("Supply may tighten")}
<table><tr><td><p id="i7"><span style="font-weight:bold">ITEM 7.</span></p></td><td><span style="font-weight:bold">MANAGEMENT&#8217;S DISCUSSION AND ANALYSIS</span></td></tr></table>
${top("OVERVIEW")}${p(filler(80, "overview"))}
<p id="i8"><span style="font-weight:bold">ITEM 8. FINANCIAL STATEMENTS AND SUPPLEMENTARY DATA</span></p>
${bold("INCOME STATEMENTS")}
<table><tr><td>(In millions)</td><td colspan="6">Year Ended June 30,</td></tr><tr><td></td><td colspan="3">2026</td><td colspan="3">2025</td></tr>
<tr><td>Revenue</td><td>$</td><td><ix:nonFraction name="us-gaap:Revenues" contextRef="c1" scale="6">300,000</ix:nonFraction></td><td></td><td>$</td><td>250,000</td><td></td></tr>
<tr><td>Net margin</td><td></td><td>36</td><td>%</td><td></td><td>(4</td><td>)%</td></tr></table>
<p>* Margins are rounded.</p>
${bold("2.")}<ix:nonNumeric name="us-gaap:RevenueFromContractWithCustomerTextBlock" contextRef="c1">${bold("Revenue")}${italic("Disaggregation of Revenue")}${p(`Revenue recognized from commitments represented <ix:nonFraction name="crwv:Share" contextRef="c1" scale="-2">98</ix:nonFraction>% of revenue. ${filler(30, "revenue")}`)}${italic("Significant Customers")}${p(filler(40, "customers"))}</ix:nonNumeric>
${bold("3.")}<ix:nonNumeric name="us-gaap:LeasesTextBlock" contextRef="c1" continuedAt="cont1">${bold("Leases")}${p(filler(40, "lease"))}</ix:nonNumeric>
${pageBreak(13)}
<ix:continuation id="cont1">${p(filler(40, "leasemore"))}</ix:continuation>
${p("SIGNATURES")}
<script type="text/javascript" src="/random/path"></script>
</body></html>`;

const meta = { documentId: "a".repeat(64), accessionNumber: "0000000000-26-000001", documentUrl: "https://www.sec.gov/Archives/edgar/data/1/000000000026000001/x-20260630.htm", form: "10-K" };

test("splits a 10-K by its items, heading levels and XBRL notes", () => {
  const doc = parseFilingDocument(html, meta);
  assert.equal(doc.structure, "items");
  assert.equal(doc.docType, "primary");
  const titles = (canonical: string) => doc.sections.filter(s => s.canonical === canonical).map(s => s.path.slice(1).join(" › "));
  assert.deepEqual(titles("business"), ["", "GENERAL", "OPERATING SEGMENTS", "OPERATING SEGMENTS › Intelligent Cloud", "OPERATING SEGMENTS › Intelligent Cloud › Server Products and Cloud Services",
    "OPERATING SEGMENTS › Intelligent Cloud › XBOX", "OPERATING SEGMENTS › Intelligent Cloud › Competition", "HUMAN CAPITAL RESOURCES"]);
  const front = doc.sections.find(s => s.canonical === "front")!;
  assert.equal(front.role, "boilerplate");
  assert.equal(doc.sections.find(s => s.canonical === "risk_factors" && s.depth === 0)?.role, "signal");
  // The note is named by its first line inside the tagged span; its bare number outside the span is dropped.
  const note = doc.sections.find(s => s.canonical === "note" && s.xbrlBlock === "us-gaap:RevenueFromContractWithCustomerTextBlock")!;
  assert.equal(note.title, "Revenue");
  assert.ok(doc.sections.some(s => s.parentId === note.sectionId && s.title === "Disaggregation of Revenue"));
  // A continued note collects its continuation, across the page break.
  const leases = doc.sections.find(s => s.xbrlBlock === "us-gaap:LeasesTextBlock")!;
  assert.ok(doc.passages.some(x => x.sectionId === leases.sectionId && x.text.startsWith("leasemore")));
});

test("drops page furniture, the table of contents and injected scripts", () => {
  const doc = parseFilingDocument(html, meta);
  const texts = doc.passages.map(x => x.text);
  assert.ok(!texts.some(t => /^(?:\d+|Table of Contents)$/.test(t)));
  assert.ok(!texts.some(t => /Item 1A\.?\s*Risk Factors\s*5/.test(t)));
  assert.ok(doc.sections.some(s => s.title === "Item 1. BUSINESS"), "inline spans join without a space");
});

test("reads a data table into named columns, folded glyphs, signs and facts", () => {
  const doc = parseFilingDocument(html, meta);
  const table = doc.passages.find(x => x.kind === "table")!;
  assert.deepEqual(table.table!.columns, ["Year Ended June 30, 2026", "Year Ended June 30, 2025"]);
  assert.deepEqual(table.table!.rows.map(r => [r.label, ...r.cells.map(c => c.text)]), [["Revenue", "$300,000", "$250,000"], ["Net margin", "36%", "(4)%"]]);
  assert.deepEqual(table.table!.rows[1]!.cells.map(c => c.value), [36, -4]);
  assert.equal(table.table!.unit, "(In millions)");
  assert.deepEqual(table.table!.notes, ["* Margins are rounded."]);
  assert.deepEqual(table.factRefs.map(f => [f.concept, f.row, f.col]), [["us-gaap:Revenues", 0, 0]]);
  const paragraph = doc.passages.find(x => x.text.startsWith("Revenue recognized"))!;
  const ref = paragraph.factRefs[0]!;
  assert.equal(paragraph.text.slice(ref.start, ref.end), "98");
});

test("splits a long leaf at bold lead-in sentences", () => {
  const doc = parseFilingDocument(html, meta);
  const category = doc.sections.find(s => s.title === "STRATEGIC AND COMPETITIVE RISKS")!;
  const risks = doc.sections.filter(s => s.parentId === category.sectionId).map(s => s.title);
  assert.equal(risks[0], "We face intense competition");
  assert.ok(risks.length >= 5);
});

test("ids depend on content, not position", () => {
  const first = parseFilingDocument(html, meta);
  const shifted = parseFilingDocument(html.replace("<p id=\"i1a\">", `${p(filler(30, "inserted"))}<p id="i1a">`), meta);
  const ids = new Set(shifted.passages.map(x => x.passageId));
  const kept = first.passages.filter(x => ids.has(x.passageId)).length;
  assert.equal(kept, first.passages.length, "inserting a paragraph keeps every other passage id");
  assert.equal(libraryHash("abc"), libraryHash("abc"));
  assert.notEqual(libraryHash("abc"), libraryHash("abd"));
});

test("an index card keeps only what the section's text supports", async () => {
  const { checkCard, noteTopic } = await import("../../../shared/analysis-runtime/filing-library/cards.ts");
  const text = "Server products and cloud services include Azure and SQL Server, sold to enterprises.";
  const card = checkCard({ gist: "介绍 Azure 与 SQL Server", entities: ["Azure", "SQL Server", "Invented Cloud"], topic: "product_line", answers: ["Azure 卖给谁"] }, text, "business");
  assert.deepEqual(card.entities, ["Azure", "SQL Server"]);
  assert.equal(card.topic, "product_line");
  assert.equal(card.gist, "介绍 Azure 与 SQL Server");
  assert.equal(checkCard({ gist: "收入增长 12%", topic: "made-up" }, text, "business").gist, null);
  assert.equal(checkCard({ gist: "收入增长 12%", topic: "made-up" }, text, "business").topic, null);
  assert.equal(noteTopic("us-gaap:RevenueFromContractWithCustomerTextBlock"), "revenue");
  assert.equal(noteTopic("us-gaap:SegmentReportingDisclosureTextBlock"), "segment");
  assert.equal(noteTopic("us-gaap:LesseeOperatingLeasesTextBlock"), "leases");
});

test("a business link names only flow nodes and sections it was shown, and keeps every map business", async () => {
  const { checkLinks } = await import("../../../shared/analysis-runtime/filing-library/links.ts");
  const sections = new Map([["s1", "Item 1 › Intelligent Cloud\nAzure and other cloud services grew."], ["s2", "Item 7 › Segment results\nServer products."]]);
  const flow = [{ flowNodeId: "msft:IntelligentCloudMember", name: "Intelligent Cloud" }, { flowNodeId: "msft:MorePersonalComputingMember", name: "More Personal Computing" }];
  const { links, notes } = checkLinks({ links: [
    { name: "Intelligent Cloud", flowNodeId: "msft:IntelligentCloudMember", sectionIds: ["s1", "s2", "s9"], industryCategory: "cloud_infrastructure" },
    { name: "Azure", flowNodeId: null, sectionIds: ["s1"], industryCategory: "made_up" },
    { name: "Quantum Toaster", flowNodeId: null, sectionIds: ["s1"], industryCategory: "other" },
  ] }, "MSFT", flow, sections);
  assert.deepEqual(links.map(l => [l.businessKey, l.flowNodeId, l.sectionIds, l.industryCategory, l.xbrlMembers]), [
    ["MSFT:intelligent-cloud", "msft:IntelligentCloudMember", ["s1", "s2"], "cloud_infrastructure", ["msft:IntelligentCloudMember"]],
    ["MSFT:azure", null, ["s1"], null, []],
    ["MSFT:more-personal-computing", "msft:MorePersonalComputingMember", [], null, ["msft:MorePersonalComputingMember"]],
  ]);
  assert.deepEqual(notes.sort(), ["unanchored:Quantum Toaster", "unknown_category:Azure", "unknown_sections:Intelligent Cloud", "unplaced:More Personal Computing"]);
});

test("the storage sweep deletes only what no reader can reach", async () => {
  const { SWEEP_RULES } = await import("../src/storage/sweep.ts");
  const now = Date.parse("2026-10-12T00:00:00Z"), day = 86_400_000;
  const ctx = { now, aiTickers: new Set(["ORCL"]), liveSearchObjects: new Set(["web-search/v1/k/live.json"]), analysisSchema: "sec-analysis.v4" };
  const dead = (key: string, age: number) => SWEEP_RULES.find(r => key.startsWith(r.prefix))!.dead(key, now - age, ctx);
  assert.equal(dead("filings/AMZN/1/meta.json", day), true);
  assert.equal(dead("filings/ORCL/1/meta.json", 400 * day), false);
  assert.equal(dead("analysis/ORCL/1/sec-analysis.v3/brief.json", day), true);
  assert.equal(dead("analysis/ORCL/1/sec-analysis.v4/brief.json", day), false);
  assert.equal(dead("web-search/v1/k/live.json", 29 * day), false);
  assert.equal(dead("web-search/v1/k/live.json", 31 * day), true);
  assert.equal(dead("web-search/v1/k/old.json", 2 * 3_600_000), true);
  assert.equal(dead("web-search/v1/k/new.json", 10 * 60_000), false);
  assert.equal(dead("model-recovery/v1/i/f.json", 6 * day), false);
  assert.equal(dead("workflow-results/v1/i/s/d.json", 31 * day), true);
  // An empty company list or search index never reads as "everything is dead".
  const empty = { ...ctx, aiTickers: new Set<string>(), liveSearchObjects: new Set<string>() };
  assert.equal(SWEEP_RULES[0]!.dead("filings/AMZN/1/meta.json", now, empty), false);
  assert.equal(SWEEP_RULES[4]!.dead("web-search/v1/k/old.json", now - 2 * 3_600_000, empty), false);
});

test("a single-business company is named as filings name it, so its anchors can name it", async () => {
  const { anchors, branchAncestors, issuerNames } = await import("../../../shared/analysis-runtime/business-tree.ts");
  assert.deepEqual(issuerNames("Cloudflare, Inc. Class A Common Stock"), ["Cloudflare, Inc.", "Cloudflare"]);
  assert.deepEqual(issuerNames("Nebius Group N.V. - Class A Ordinary Shares"), ["Nebius Group N.V.", "Nebius Group", "Nebius"]);
  assert.deepEqual(issuerNames("Berkshire Hathaway Inc. New Common Stock"), ["Berkshire Hathaway Inc.", "Berkshire Hathaway"]);
  assert.deepEqual(issuerNames("Microsoft Corporation"), ["Microsoft Corporation", "Microsoft"]);
  const passage = "Customers can quickly and easily join Cloudflare by using just one of our products. Our full suite of products consists of (1) our application services.";
  const segment = { flowNodeId: "cloud:ReportableSegmentMember", name: "Reportable Segment" };
  assert.equal(anchors("application services", branchAncestors(segment, "Cloudflare, Inc. Class A Common Stock", true), passage), true);
  assert.equal(anchors("application services", branchAncestors(segment, "Cloudflare, Inc. Class A Common Stock", false), passage), false);
});
