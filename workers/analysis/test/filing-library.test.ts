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

test("statements and notes filed under the exhibits item are read as under Item 8; the exhibit index stays an exhibit list", () => {
  // Oracle's 10-K: Item 8 points at Item 15, where the statements sit under "(b) Exhibits" and the tagged notes follow them.
  const exhibitsHtml = `<html><body>
<div style="display:none"><ix:header><ix:hidden><ix:nonNumeric name="dei:DocumentType">10-K</ix:nonNumeric></ix:hidden></ix:header></div>
${p("FORM 10-K")}
<p id="i1"><span style="font-weight:bold">ITEM 1. BUSINESS</span></p>${p(filler(60, "general"))}
<p id="i8"><span style="font-weight:bold">ITEM 8. FINANCIAL STATEMENTS AND SUPPLEMENTARY DATA</span></p>${p("The financial statements are set forth under Item 15.")}
<p id="i15"><span style="font-weight:bold">ITEM 15. EXHIBITS AND FINANCIAL STATEMENT SCHEDULES</span></p>
${p("(a) 1. Financial Statements: the following are filed as part of this report.")}
${top("INDEX OF EXHIBITS")}
<table><tr><td>Exhibit No.</td><td>Description</td></tr><tr><td>3.01</td><td>Restated Certificate of Incorporation</td></tr><tr><td>10.01</td><td>Credit Agreement dated as of March 1, 2026</td></tr><tr><td>31.01</td><td>Certification of Chief Executive Officer</td></tr></table>
${top("(b) Exhibits")}${p("The exhibits listed in the Index of Exhibits are filed as part of this report.")}
${bold("CONSOLIDATED BALANCE SHEETS")}
<table><tr><td>(In millions)</td><td colspan="3">May 31, 2026</td></tr>
<tr><td>Cash</td><td>$</td><td><ix:nonFraction name="us-gaap:Cash" contextRef="c1" scale="6">11,000</ix:nonFraction></td><td></td></tr>
<tr><td>Total assets</td><td>$</td><td>170,000</td><td></td></tr></table>
${bold("NOTES TO CONSOLIDATED FINANCIAL STATEMENTS")}
${bold("7.")}<ix:nonNumeric name="us-gaap:DebtDisclosureTextBlock" contextRef="c1">${bold("NOTES PAYABLE AND OTHER BORROWINGS")}${p(`Notes payable and other borrowings consisted of the following. ${filler(40, "debt")}`)}
<table><tr><td>(In millions)</td><td colspan="3">May 31, 2026</td></tr><tr><td>Senior notes</td><td>$</td><td><ix:nonFraction name="us-gaap:SeniorNotes" contextRef="c1" scale="6">95,000</ix:nonFraction></td><td></td></tr><tr><td>Commercial paper</td><td>$</td><td>2,000</td><td></td></tr></table></ix:nonNumeric>
<p id="i16"><span style="font-weight:bold">ITEM 16. FORM 10-K SUMMARY</span></p>${p("None.")}
${p("SIGNATURES")}
</body></html>`;
  const doc = parseFilingDocument(exhibitsHtml, meta);
  assert.equal(doc.structure, "items");
  const item15 = doc.sections.find(s => s.itemKey === "15" && s.depth === 0)!;
  assert.equal(item15.canonical, "exhibits");
  const note = doc.sections.find(s => s.xbrlBlock === "us-gaap:DebtDisclosureTextBlock")!;
  assert.equal(note.canonical, "note");
  assert.equal(note.role, "core");
  assert.equal(note.parentId, item15.sectionId);
  assert.equal(note.title, "NOTES PAYABLE AND OTHER BORROWINGS");
  const noteTable = doc.passages.find(x => x.sectionId === note.sectionId && x.kind === "table")!;
  assert.deepEqual(noteTable.factRefs.map(f => f.concept), ["us-gaap:SeniorNotes"]);
  assert.ok(doc.passages.some(x => x.sectionId === note.sectionId && x.text.startsWith("Notes payable and other borrowings")));
  // The statements, and the heading they sit under, read as financial statements, as they would under Item 8.
  const balance = doc.sections.find(s => s.title === "CONSOLIDATED BALANCE SHEETS")!;
  assert.equal(balance.canonical, "financial_statements");
  assert.equal(balance.role, "core");
  assert.equal(doc.sections.find(s => s.title === "(b) Exhibits")?.canonical, "financial_statements");
  // The exhibit index and the item's own text keep the exhibits canonical and stay boilerplate.
  const index = doc.sections.find(s => s.title === "INDEX OF EXHIBITS")!;
  assert.equal(index.canonical, "exhibits");
  assert.equal(index.role, "boilerplate");
  assert.ok(doc.passages.some(x => x.sectionId === index.sectionId && x.kind === "table" && x.text.includes("Restated Certificate of Incorporation")));
  assert.equal(item15.role, "boilerplate");
  assert.equal(doc.sections.find(s => s.itemKey === "16" && s.depth === 0)?.canonical, "summary");
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

test("a follow-up query is anchored on the issuer's names, never on the listing title", async () => {
  const { issuerNames } = await import("../../../shared/analysis-runtime/business-tree.ts");
  const { companyQuery } = await import("../src/business-explainer/agent.ts");
  const company = issuerNames("Cloudflare, Inc. Class A Common Stock")[0]!;
  assert.equal(companyQuery("cloudflare workers pricing per request", company), "cloudflare workers pricing per request");
  assert.equal(companyQuery("edge compute pricing per request", company), "Cloudflare, Inc. edge compute pricing per request");
  assert.equal(companyQuery("JPMorgan Chase card interchange fees", issuerNames("JP Morgan Chase & Co. Common Stock")[0]!), "JPMorgan Chase card interchange fees");
  // A leading article is not the company's name.
  assert.equal(companyQuery("how the platform charges advertisers", issuerNames("The Trade Desk, Inc. Class A Common Stock")[0]!), "The Trade Desk, Inc. how the platform charges advertisers");
});

test("a link is verified only when an independent review agrees on its category, and keeps only the sections the review vouches for", async () => {
  const { readReviews, settleLinks } = await import("../../../shared/analysis-runtime/filing-library/links.ts");
  const draft = (key: string, category: string | null, sectionIds: string[]) => ({ businessKey: key, name: key, flowNodeId: null, xbrlMembers: [], sectionIds, industryCategory: category as never });
  const drafts = [draft("A:cloud", "cloud_infrastructure", ["s1", "s2"]), draft("A:devices", "consumer_devices", ["s3"]), draft("A:other", null, []), draft("A:skipped", "advertising", ["s4"])];
  const reviews = readReviews({ reviews: [
    { key: "A:cloud", industryCategory: "cloud_infrastructure", sectionIds: ["s1"] },
    { key: "A:devices", industryCategory: "hardware_systems", sectionIds: ["s3"] },
    { key: "A:other", industryCategory: null, sectionIds: [] },
    { key: "A:invented", industryCategory: "other", sectionIds: [] },
    { key: "A:cloud", industryCategory: "advertising", sectionIds: [] },
  ] }, drafts);
  const settled = settleLinks(drafts, reviews);
  assert.deepEqual(settled.map(l => [l.businessKey, l.status, l.industryCategory, l.sectionIds, l.review.droppedSections]), [
    ["A:cloud", "verified", "cloud_infrastructure", ["s1"], ["s2"]],
    ["A:devices", "disputed", null, ["s3"], []],
    ["A:other", "verified", null, [], []],
    ["A:skipped", "disputed", null, ["s4"], []],
  ]);
  assert.equal(settled[3]!.review.reviewedPresent, false);
});

test("an earnings release yields the next quarter only when every line reconciles, and segments are found by their names", async () => {
  const { releaseQuarter } = await import("../../../shared/analysis-runtime/financial-data/earnings-release.ts");
  const src = "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/10q.htm";
  const amount = (value: number, key: string) => ({ value: String(value), basis: "reported" as const, definition: key, comparabilityKey: `k:${key}`, sourceIds: ["A"], lineage: [{ accession: "A", url: src, concept: key, contextId: "c", periodStart: "2026-04-01", periodEnd: "2026-06-30", dimensions: {}, parserVersion: "v" }] });
  const derived = (value: number, key: string) => ({ ...amount(value, key), basis: "derived" as const, formula: "f" });
  const previous: any = {
    id: "2026-06-30", incomeModel: "standard", label: "Q", periodStart: "2026-04-01", periodEnd: "2026-06-30", periodType: "3M", currency: "USD", scale: 1, basisLabel: "b", reportedAt: null,
    figures: { revenue: amount(1000e6, "revenue"), cost: amount(400e6, "cost"), gross: amount(600e6, "gross"), operatingExpenses: derived(300e6, "operatingExpenses"), operating: amount(300e6, "operating"), other: derived(10e6, "other"), pretax: amount(310e6, "pretax"), tax: amount(60e6, "tax"), net: amount(250e6, "net"), research: amount(200e6, "research") },
    expenseComponents: [{ id: "ResearchAndDevelopmentExpense", name: "Research and development", group: "research", amount: amount(200e6, "rd") }, { id: "SellingGeneralAndAdministrativeExpense", name: "Selling, general and administrative", group: "other", amount: amount(100e6, "sga") }],
    otherComponents: [{ id: "reported-net-other", name: "Other income (expense), net", amount: derived(10e6, "other") }],
    segments: [{ id: "x:CloudMember", name: "Cloud", revenue: amount(700e6, "seg"), description: "", products: [], customers: null, monetization: null, disclosure: "", sourceIds: ["A"] }, { id: "x:DevicesMember", name: "Devices", revenue: amount(300e6, "seg"), description: "", products: [], customers: null, monetization: null, disclosure: "", sourceIds: ["A"] }],
    segmentsComplete: true, sources: [{ id: "A", title: "10-Q", url: src, publishedAt: "2026-08-01" }],
  };
  const row = (label: string, a: string, b: string) => `<tr><td>${label}</td><td>$</td><td>${a}</td><td>$</td><td>${b}</td></tr>`;
  const html = (net: string) => `<p>CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS (In millions)</p><table>
    <tr><td></td><td colspan="4">Three Months Ended September 30,</td></tr><tr><td></td><td colspan="2">2026</td><td colspan="2">2025</td></tr>
    ${row("Total revenue", "1,200", "900")}${row("Cost of revenue", "450", "380")}${row("Gross margin", "750", "520")}${row("Research and development", "230", "190")}
    ${row("Selling, general and administrative", "120", "100")}${row("Restructuring", "(5)", "—")}${row("Operating income", "405", "230")}${row("Other income (expense), net", "(15)", "5")}
    ${row("Income before income taxes", "390", "235")}${row("Provision for income taxes", "(80)", "(50)")}${row("Net income", net, "185")}</table>
    <p>Segment revenue (In millions)</p><table><tr><td></td><td colspan="4">Three Months Ended September 30,</td></tr><tr><td></td><td colspan="2">2026</td><td colspan="2">2025</td></tr>
    ${row("Cloud segment", "850", "600")}${row("Devices", "350", "300")}${row("Total", "1,200", "900")}</table>`;
  const source = { accession: "B", filedAt: "2026-10-20", parserVersion: "v" };
  const read = releaseQuarter([{ url: "https://www.sec.gov/Archives/edgar/data/1/000000000126000002/ex99.htm", html: html("310") }], previous, source);
  assert.deepEqual(read.issues, []);
  const q = read.quarter!;
  assert.equal(q.periodEnd, "2026-09-30");
  assert.deepEqual(Object.fromEntries(Object.entries(q.figures).map(([k, v]: any) => [k, Number(v.value) / 1e6])), { revenue: 1200, cost: 450, gross: 750, operating: 405, pretax: 390, net: 310, tax: 80, operatingExpenses: 345, other: -15, research: 230 });
  assert.deepEqual(q.expenseComponents!.map(c => [c.id, Number(c.amount.value) / 1e6]), [["ResearchAndDevelopmentExpense", 230], ["SellingGeneralAndAdministrativeExpense", 120], ["release-restructuring", -5]]);
  assert.deepEqual(q.segments.map(s => [s.id, Number(s.revenue!.value) / 1e6]), [["x:CloudMember", 850], ["x:DevicesMember", 350]]);
  assert.equal(q.figures.revenue!.comparabilityKey, "k:revenue");
  // A net income that does not follow from its own statement leaves the quarter to the 10-Q.
  assert.equal(releaseQuarter([{ url: "https://www.sec.gov/x.htm", html: html("311") }], previous, source).quarter, null);
});
