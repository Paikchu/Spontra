import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseFilingDocument } from "../../../shared/analysis-runtime/filing-library/parse.ts";
import { linkInput } from "../src/filing-library/links.ts";

const p = (text: string) => `<p style="font-size:10pt"><span style="font-size:10pt">${text}</span></p>`;
// Intel sets its part titles in a larger plain face: no bold, no capitals, nothing the heading styles catch.
const title = (text: string) => `<p style="font-size:16pt;color:#0068b5"><span style="font-size:16pt">${text}</span></p>`;
const filler = (words: number, seed: string) => Array.from({ length: words }, (_, i) => `${seed}${i % 7}`).join(" ") + ".";

const intelHtml = `<html><body>
<div style="display:none"><ix:header><ix:hidden><ix:nonNumeric name="dei:DocumentType">10-K</ix:nonNumeric></ix:hidden></ix:header></div>
${p("UNITED STATES SECURITIES AND EXCHANGE COMMISSION")}${p("FORM 10-K")}
${title("Organization of Our Form 10-K")}${p("The order and presentation of content in our Form 10-K differs from the traditional SEC Form 10-K format.")}
<table><tr><td>Item 1.</td><td>Business</td><td>Our Business</td></tr><tr><td>Item 1A.</td><td>Risk Factors</td><td>Risk Factors</td></tr>
<tr><td>Item 7.</td><td>Management's Discussion and Analysis</td><td>Management's Discussion and Analysis</td></tr><tr><td>Item 8.</td><td>Financial Statements</td><td>Financial Statements and Supplemental Details</td></tr></table>
${p("Risk Factors")}${p(filler(20, "index"))}
${title("Forward-Looking Statements")}${p(filler(40, "caution"))}
${title("Our Strategy")}${p(filler(60, "strategy"))}
${title("Our Business")}${p(filler(40, "business"))}
${p("CCG")}${p(filler(80, "client"))}${p("DCAI")}${p(filler(80, "datacenter"))}
${title("Management&#8217;s Discussion and Analysis")}${p(filler(80, "results"))}
${title("Risk Factors")}${p(filler(300, "risk"))}
${title("Financial Statements and Supplemental Details")}${p(filler(20, "statements"))}
<p>Note 3 :</p><ix:nonNumeric name="us-gaap:SegmentReportingDisclosureTextBlock" contextRef="c1">${p("Operating Segments")}${p(filler(60, "segment"))}</ix:nonNumeric>
<p>Note 19 :</p><ix:nonNumeric name="us-gaap:CommitmentsAndContingenciesDisclosureTextBlock" contextRef="c1">${p("Commitments and Contingencies")}${p(filler(30, "commit"))}${p("Legal Proceedings")}${p(filler(40, "lawsuit"))}</ix:nonNumeric>
</body></html>`;
const meta = { documentId: "b".repeat(64), accessionNumber: "0000050863-26-000010", documentUrl: "https://www.sec.gov/Archives/edgar/data/50863/000005086326000010/intc-20251227.htm", form: "10-K" };

test("an annual report titled in words instead of items is split into its business, MD&A, risk factors and statements", () => {
  const doc = parseFilingDocument(intelHtml, meta);
  assert.equal(doc.structure, "items");
  assert.deepEqual(doc.issues, ["ITEMS_FROM_TITLES"]);
  const tops = doc.sections.filter(s => s.depth === 0).map(s => [s.title, s.canonical]);
  assert.deepEqual(tops, [["Front matter", "front"], ["Our Strategy", "business"], ["Our Business", "business"], ["Management’s Discussion and Analysis", "mdna"],
    ["Risk Factors", "risk_factors"], ["Financial Statements and Supplemental Details", "financial_statements"]]);
  // The cross-reference index and its stray title stay in the front matter.
  const canonicalOf = (text: string) => doc.sections.find(s => s.sectionId === doc.passages.find(x => x.text.startsWith(text))!.sectionId)!.canonical;
  assert.equal(canonicalOf("Risk Factors"), "front");
  assert.equal(canonicalOf("datacenter"), "business");
  assert.equal(doc.sections.find(s => s.canonical === "risk_factors")!.role, "signal");
  // Notes still split under the statements; a note's own "Legal Proceedings" opens no part.
  const segment = doc.sections.find(s => s.xbrlBlock === "us-gaap:SegmentReportingDisclosureTextBlock" && s.canonical === "note")!;
  assert.equal(doc.sections.find(s => s.sectionId === segment.parentId)!.canonical, "financial_statements");
  assert.ok(!doc.sections.some(s => s.canonical === "legal"));
  assert.equal(canonicalOf("Legal Proceedings"), "note");
});

test("an annual report with items keeps its item split however its parts are also titled", () => {
  const itemized = intelHtml.replace(title("Our Business"), `<p><span style="font-weight:bold">ITEM 1. BUSINESS</span></p>`)
    .replace(title("Management&#8217;s Discussion and Analysis"), `<p><span style="font-weight:bold">ITEM 7. MANAGEMENT&#8217;S DISCUSSION AND ANALYSIS</span></p>`);
  const doc = parseFilingDocument(itemized, meta);
  assert.deepEqual(doc.issues, []);
  assert.deepEqual(doc.sections.filter(s => s.depth === 0).map(s => s.itemKey), [null, "1", "7"]);
});

/** D1 over node:sqlite with every migration applied. */
function database(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8").replace(/--> statement-breakpoint/g, ""));
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => { sqlite.prepare(sql).run(...values as never[]); return { success: true }; },
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
    first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) ?? null) as T | null,
  });
  return { db: { prepare: (sql: string) => statement(sql), batch: async (list: Array<{ run(): Promise<unknown> }>) => { for (const s of list) await s.run(); return []; } } as unknown as D1Database, sqlite };
}

function library(ticker: string) {
  const { db, sqlite } = database();
  sqlite.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, '{}', '2026-01-01')").run(`library-cards:v1:${ticker}`);
  const document = (id: string, form: string, filedAt: string) => sqlite.prepare(`INSERT INTO sec_documents (document_id, ticker, accession_number, form, doc_type, filed_at, document_url, source_sha256, parser_version, structure, status, prepared_at)
    VALUES (?, ?, ?, ?, 'primary', ?, '', '', 'v', 'items', 'ready', '')`).run(id, ticker, id, form, filedAt);
  let ordinal = 0;
  const section = (id: string, documentId: string, canonical: string, path: string[], card: { gist: string | null; topic: string | null } | null, isLeaf = 1) => {
    sqlite.prepare(`INSERT INTO sec_sections (section_id, document_id, ordinal, depth, is_leaf, canonical, title, path, role, change, chars, text_sha256) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'core', 'new', 1, '')`)
      .run(id, documentId, ordinal++, isLeaf, canonical, path.at(-1)!, JSON.stringify(path));
    if (card) sqlite.prepare(`INSERT INTO sec_section_cards (section_id, document_id, ticker, card_version, text_sha256, gist, topic, model, reasoning, status, created_at) VALUES (?, ?, ?, 'v', '', ?, ?, 'm', 'r', 'ready', '')`)
      .run(id, documentId, ticker, card.gist, card.topic);
  };
  return { db, document, section };
}

test("link candidates fall back to an annual report's carded unclassified sections when it has no business or MD&A", async () => {
  const { db, document, section } = library("INTC");
  document("k1", "10-K", "2026-01-23");
  section("cover", "k1", "other", ["UNITED STATES SECURITIES AND EXCHANGE COMMISSION"], { gist: null, topic: "other" }, 0);
  section("ccg", "k1", "other", ["UNITED STATES SECURITIES AND EXCHANGE COMMISSION", "CCG"], { gist: "概述 CCG 业务", topic: "other" });
  section("dcai", "k1", "other", ["UNITED STATES SECURITIES AND EXCHANGE COMMISSION", "DCAI"], { gist: "概述 DCAI 产品", topic: "other" });
  section("seg", "k1", "note", ["Note 3 :"], { gist: "分部信息", topic: "segment" });
  section("tax", "k1", "note", ["Note 8 :"], { gist: "所得税", topic: "tax" });
  const input = (await linkInput(db, "INTC"))!;
  assert.equal(input.documentId, "k1");
  assert.deepEqual(input.candidates.map(c => c.sectionId), ["ccg", "dcai", "seg"]);
  // Once the report has a business section, unclassified sections are not offered.
  section("biz", "k1", "business", ["Our Business"], { gist: "业务概述", topic: "overview" });
  assert.deepEqual((await linkInput(db, "INTC"))!.candidates.map(c => c.sectionId), ["seg", "biz"]);
});

test("a company without an annual report links from its newest quarterly report until one arrives", async () => {
  const { db, document, section } = library("SPCX");
  assert.equal(await linkInput(db, "SPCX"), null);
  document("q1", "10-Q", "2026-05-10");
  document("q2", "10-Q", "2026-08-10");
  section("q1-mdna", "q1", "mdna", ["Item 2. MD&A", "Overview"], { gist: "旧季度概述", topic: "overview" });
  section("q2-mdna", "q2", "mdna", ["Item 2. MD&A", "Overview"], { gist: "季度概述", topic: "overview" });
  section("q2-liq", "q2", "mdna", ["Item 2. MD&A", "Liquidity"], { gist: "流动性", topic: "liquidity" });
  section("q2-seg", "q2", "note", ["Note 4. Segments"], { gist: "分部", topic: "segment" });
  const quarterly = (await linkInput(db, "SPCX"))!;
  assert.equal(quarterly.documentId, "q2");
  assert.deepEqual(quarterly.candidates.map(c => c.sectionId), ["q2-mdna", "q2-seg"]);
  // The first annual report takes over, and the changed document changes the fingerprint, so links run again.
  document("k1", "10-K", "2027-02-20");
  section("k1-biz", "k1", "business", ["Item 1. Business"], { gist: "业务", topic: "overview" });
  const annual = (await linkInput(db, "SPCX"))!;
  assert.equal(annual.documentId, "k1");
  assert.deepEqual(annual.candidates.map(c => c.sectionId), ["k1-biz"]);
  assert.notEqual(annual.fingerprint, quarterly.fingerprint);
});
