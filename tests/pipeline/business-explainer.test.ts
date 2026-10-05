import assert from "node:assert/strict";
import test from "node:test";

import { excerpt, nodeHint, runBusinessExplainer, type ExplainerModel, type ExplainerNode, type ExplainerSearch } from "../../workers/pipeline/src/business-explainer/agent.ts";
import { businessExplainerCacheKey, explainerFingerprint, explainerNodes, readBusinessExplainerResponse, runBusinessExplainerSweep } from "../../workers/pipeline/src/business-explainer/workflow.ts";
import { readBusinessExplainer } from "../../shared/analysis-runtime/business-explainer.ts";
import { handleAnalysisReadRequest } from "../../workers/pipeline/src/read-api/router.ts";
import { D1SecRepository } from "../../workers/pipeline/src/sec/d1.ts";
import { businessFlowCacheKey } from "../../workers/pipeline/src/sec/business-flow-cache.ts";
import type { SecPipelineEnv } from "../../workers/pipeline/src/operations.ts";
import { createAnalysisDatabase, readEnv, readRequest } from "./helpers/analysis-backend.ts";
import { completeOrclFixture } from "../fixtures/complete-orcl-flow.ts";

const now = "2026-10-04T00:00:00.000Z";
const nodes: ExplainerNode[] = [
  { nodeId: "software", name: "软件", parentId: null, hint: "software" },
  { nodeId: "SoftwareLicense", name: "软件许可", parentId: "software", hint: "Software License" },
  { nodeId: "SoftwareSupport", name: "软件支持", parentId: "software", hint: "Software Support" },
  { nodeId: "HardwareRevenues", name: "硬件", parentId: null, hint: "Hardware" },
];
const filing = "https://www.sec.gov/Archives/edgar/data/1341439/000095017026000001/orcl-10k.htm";
const vendor = "https://www.oracle.com/database/";

function search(options: { failHardware?: boolean } = {}): ExplainerSearch & { queries: string[]; reads: string[] } {
  const queries: string[] = [], reads: string[] = [];
  const wrap = <T>(data: T) => ({ data, provider: "fake", fetchedAt: now, expiresAt: now, cache: "miss" as const, cacheKey: "k" });
  return {
    queries, reads,
    async search(request) {
      queries.push(request.query);
      if (options.failHardware && request.query.includes("Hardware")) throw new Error("provider down");
      const results = request.includeDomains?.includes("sec.gov")
        ? [{ title: "Oracle 10-K", url: filing, snippet: "Annual report", publishedAt: "2026-06-20", score: 1 }]
        : [{ title: "Oracle Database", url: vendor, snippet: "Oracle Database license and support.", publishedAt: null, score: 1 }];
      return wrap({ kind: "search" as const, results });
    },
    async fetchContent(request) {
      reads.push(request.url);
      return wrap({ kind: "content" as const, url: request.url, format: "markdown" as const, completeness: "unverified" as const,
        text: "Cover page text that is long enough to count as a paragraph here.\n\nOur software license revenues come from perpetual licenses to Oracle Database and Java, recognised upfront.\n\nSoftware support revenues are annual renewals that give customers updates and technical support." });
    },
  };
}

function model(review: Array<{ nodeId: string; field: string }> = []): ExplainerModel & { stages: string[] } {
  const stages: string[] = [];
  const fn = async (stage: string, _system: string, payload: unknown) => {
    stages.push(stage);
    if (stage.includes("review")) return { issues: review.map(r => ({ ...r, problem: "unsupported" })) };
    const { businesses, materials } = payload as { businesses: Array<{ nodeId: string }>; materials: Array<{ sourceId: string }> };
    const id = materials[0]!.sourceId;
    return { businesses: businesses.map(b => ({
      nodeId: b.nodeId, summary: { text: `${b.nodeId} 是什么`, sourceIds: [id, "s99"] },
      howItWorks: { text: "交付方式", sourceIds: ["invented"] }, products: ["Oracle Database", "Made Up Suite"],
      customers: { text: "企业客户", sourceIds: [id] }, monetization: { text: "一次性许可费加年度支持费", sourceIds: [id] }, relation: null,
    })) };
  };
  return Object.assign(fn, { stages });
}

test("node hints read the filing's own member wording", () => {
  assert.equal(nodeHint("SoftwareLicense", "软件许可"), "Software License");
  assert.equal(nodeHint("HardwareRevenues", "硬件"), "Hardware");
  assert.equal(nodeHint("SalesRevenueServicesNet", "服务"), "Services");
  assert.equal(nodeHint("云", "云"), "云");
});

test("published ORCL flow yields every business and its children", () => {
  const found = explainerNodes(completeOrclFixture);
  const byId = new Map(found.map(n => [n.nodeId, n]));
  assert.equal(byId.get("SoftwareLicense")?.parentId, "software");
  assert.equal(byId.get("CloudInfrastructure")?.parentId, "cloud");
  assert.ok(byId.has("HardwareRevenues") && byId.has("SalesRevenueServicesNet"));
});

test("explanations keep only cited, material-backed statements and reviewed fields", async () => {
  const fake = search(), writer = model([{ nodeId: "SoftwareSupport", field: "summary" }, { nodeId: "SoftwareLicense", field: "customers" }]);
  const result = await runBusinessExplainer({ ticker: "ORCL", companyName: "Oracle Corporation", nodes, search: fake, model: writer, modelVersion: "deepseek-flash", fingerprint: "fp", now });
  const ids = result.businesses.map(b => b.nodeId);
  assert.deepEqual(ids, ["software", "SoftwareLicense", "HardwareRevenues"], "a flagged summary removes the business");
  const license = result.businesses.find(b => b.nodeId === "SoftwareLicense")!;
  assert.deepEqual(license.summary.sourceIds, ["s1"], "unknown source ids are stripped");
  assert.equal(license.howItWorks, null, "a claim with no valid source is dropped");
  assert.equal(license.customers, null, "a field flagged by review is removed");
  assert.deepEqual(license.products, ["Oracle Database"], "products absent from the material are dropped");
  assert.deepEqual(result.sources.map(s => [s.id, s.kind, s.url]), [["s1", "sec", filing]]);
  assert.ok(fake.reads.includes(filing) && fake.reads.includes(vendor));
  assert.ok(readBusinessExplainer(result, "ORCL"));
  assert.equal(readBusinessExplainer(result, "MSFT"), null);
});

test("one group's failed research never blocks the others", async () => {
  const fake = search({ failHardware: true });
  // Without the filing, hardware has no evidence at all.
  const noFiling: ExplainerSearch = { ...fake, async search(request, policy) { if (request.includeDomains?.length) throw new Error("down"); return fake.search(request, policy); } };
  const result = await runBusinessExplainer({ ticker: "ORCL", companyName: "Oracle Corporation", nodes, search: noFiling, model: model(), modelVersion: "m", fingerprint: "fp", now });
  assert.ok(!result.businesses.some(b => b.nodeId === "HardwareRevenues"));
  assert.ok(result.businesses.some(b => b.nodeId === "SoftwareLicense"));
});

test("excerpt keeps matching paragraphs in document order within budget", () => {
  const text = ["Intro paragraph without any matching words at all here.", "Support renewals are annual and cover updates for licensed software.", "License fees are recognised when the software is delivered to customers."].join("\n\n");
  assert.equal(excerpt(text, ["license", "support"], 1000), text.split("\n\n").slice(1).join("\n\n"));
});

test("sweep starts one run for a changed business list, and the read API serves only valid explanations", async () => {
  const db = await createAnalysisDatabase();
  try {
    const repository = new D1SecRepository(db);
    await repository.setCache(businessFlowCacheKey("ORCL"), completeOrclFixture, "2026-10-01");
    const created: Array<{ id: string; params: { ticker: string; fingerprint: string } }> = [];
    const env = { DB: db, TAVILY_API_KEY: "test", SEC_AI_TICKERS: "ORCL,NET", SEC_AI_ENABLED: "true",
      BUSINESS_EXPLAINER_WORKFLOW: { async create(options: { id: string; params: { ticker: string; fingerprint: string } }) { created.push(options); return {}; } } } as unknown as SecPipelineEnv;
    const first = await runBusinessExplainerSweep(env, Date.parse(now));
    assert.deepEqual(first.started, ["ORCL"]);
    const fingerprint = await explainerFingerprint("ORCL", explainerNodes(completeOrclFixture));
    assert.equal(created[0]!.params.fingerprint, fingerprint);
    assert.match(created[0]!.id, /^business-explainer-ORCL-[0-9a-f]{16}-\d+$/);

    const pending = await handleAnalysisReadRequest(readRequest("/api/v1/companies/ORCL/business-explainer"), readEnv(db));
    assert.equal((await pending.json() as { status: string }).status, "preparing");

    const explainer = await runBusinessExplainer({ ticker: "ORCL", companyName: "Oracle Corporation", nodes, search: search(), model: model(), modelVersion: "m", fingerprint, now });
    await repository.setCache(businessExplainerCacheKey("ORCL"), { ...explainer, privateNote: "PRIVATE" }, now);
    const second = await runBusinessExplainerSweep(env, Date.parse(now));
    assert.deepEqual(second.started, [], "an explanation for the same list is not regenerated");
    const response = await handleAnalysisReadRequest(readRequest("/api/v1/companies/ORCL/business-explainer"), readEnv(db));
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.ok(!text.includes("PRIVATE"));
    assert.equal(JSON.parse(text).explainer.businesses[0].nodeId, "software");
    assert.equal((await readBusinessExplainerResponse(db as unknown as D1Database, "NET")).status, "preparing");
  } finally { db.close(); }
});

test("SP-21 product hierarchy preserves evidence, unknown pricing and review boundaries across companies", async () => {
  for (const [ticker, company, product, line] of [["ORCL", "Oracle", "Oracle Database", "Oracle Database"], ["AAPL", "Apple", "iPhone", "iPhone"]]) {
    const fake = search();
    const provider: ExplainerSearch = { ...fake, async fetchContent(request, policy) {
      const result = await fake.fetchContent(request, policy);
      return { ...result, data: { ...result.data, text: `Software business: ${product} belongs to ${line}. Customers use this product to store information and run applications. The material does not establish its charging model.` } };
    } };
    const result = await runBusinessExplainer({ ticker, companyName: company, nodes: [nodes[0]!], search: provider,
      model: async stage => stage.includes("review") ? { issues: [] } : { businesses: [{ nodeId: "software", summary: { text: "产品业务", sourceIds: ["s1"] }, products: [product], offerings: [
        { name: product, line, membership: {text: `Software business: ${product} belongs to ${line}.`, sourceIds: ["s1"]}, description: { text: "帮助客户处理日常信息。", sourceIds: ["s1"] }, charging: { text: "订阅", sourceIds: ["invented"] }, sourceIds: ["s1"] },
        { name: "Invented Product", line, description: { text: "假产品", sourceIds: ["s1"] }, sourceIds: ["s1"] },
      ] }] }, modelVersion: "fixture", fingerprint: "test", now });
    const offerings = result.businesses[0]!.offerings!;
    assert.equal(offerings.length, 1);
    assert.equal(offerings[0]!.name, product);
    assert.equal(offerings[0]!.charging, null, "unsupported charging must stay unknown");
    const parsed = readBusinessExplainer(result, ticker)!;
    assert.equal(parsed.businesses[0]!.offerings!.length, 1, "public parser retains hierarchy");
    const polluted = structuredClone(result);
    polluted.businesses[0]!.offerings![0]!.description.sourceIds = ["foreign"];
    assert.equal(readBusinessExplainer(polluted, ticker)!.businesses[0]!.offerings!.length, 0);
  }
});

test("SP-21 independent review removes unsupported product mappings without losing the business", async () => {
  const fake = search();
  const result = await runBusinessExplainer({ ticker: "ORCL", companyName: "Oracle", nodes: [nodes[0]!], search: fake,
    model: async stage => stage.includes("review") ? { issues: [{ nodeId: "software", field: "offerings", problem: "product charging is unsupported" }] } : { businesses: [{
      nodeId: "software", summary: { text: "软件业务", sourceIds: ["s1"] }, products: [],
      offerings: [{ name: "Oracle Database", line: null, membership: { text: "Our software license revenues come from perpetual licenses to Oracle Database and Java, recognised upfront.", sourceIds: ["s1"] }, description: { text: "保存和查询信息。", sourceIds: ["s1"] }, charging: null, sourceIds: ["s1"] }],
    }] }, modelVersion: "fixture", fingerprint: "test", now });
  assert.equal(result.businesses.length, 1);
  assert.deepEqual(result.businesses[0]!.offerings, []);
});

test("SP-21 requires a real cited passage for the specific business, not a company product list", async () => {
  const fake = search();
  const text = "Manufacturing includes Widget CAD for mechanical product design. Our cloud products include Studio Tracker for film and game production.";
  const provider: ExplainerSearch = { ...fake, async fetchContent(request, policy) {
    const result = await fake.fetchContent(request, policy);
    return { ...result, data: { ...result.data, text } };
  } };
  const result = await runBusinessExplainer({ ticker: "TEST", companyName: "Example", nodes: [{ nodeId: "Manufacturing", name: "制造", parentId: null, hint: "Manufacturing" }], search: provider,
    model: async stage => stage.includes("review") ? { issues: [] } : { businesses: [{ nodeId: "Manufacturing", summary: { text: "制造软件", sourceIds: ["s1"] }, products: [], offerings: [
      { name: "Widget CAD", line: null, description: { text: "画机械零件并设计产品。", sourceIds: ["s1"] }, membership: { text: "Manufacturing includes Widget CAD for mechanical product design.", sourceIds: ["s1"] }, charging: null, sourceIds: ["s1"] },
      { name: "Studio Tracker", line: null, description: { text: "跟踪影片和游戏制作。", sourceIds: ["s1"] }, membership: { text: "Our cloud products include Studio Tracker for film and game production.", sourceIds: ["s1"] }, charging: null, sourceIds: ["s1"] },
      { name: "Studio Tracker", line: null, description: { text: "制造产品。", sourceIds: ["s1"] }, membership: { text: "Manufacturing includes Studio Tracker.", sourceIds: ["s1"] }, charging: null, sourceIds: ["s1"] },
    ] }] }, modelVersion: "fixture", fingerprint: "test", now });
  assert.deepEqual(result.businesses[0]!.offerings!.map(p => p.name), ["Widget CAD"], "company-level existence and fabricated mapping quotes must both be rejected");
  const parsed = readBusinessExplainer(result, "TEST")!;
  assert.equal(parsed.businesses[0]!.offerings![0]!.membership?.text, "Manufacturing includes Widget CAD for mechanical product design.");
  delete result.businesses[0]!.offerings![0]!.membership;
  assert.deepEqual(readBusinessExplainer(result, "TEST")!.businesses[0]!.offerings, [], "previous offerings without ownership evidence are withheld");
});

test("SP-21 review removes one flawed product while retaining another verified product", async () => {
  const fake = search();
  const result = await runBusinessExplainer({ ticker: "ORCL", companyName: "Oracle", nodes: [nodes[0]!], search: fake,
    model: async stage => stage.includes("review") ? { issues: [{ nodeId: "software", field: "offerings", productId: "product-1", problem: "unsupported description" }] } : { businesses: [{
      nodeId: "software", summary: { text: "软件业务", sourceIds: ["s1"] }, products: [], offerings: ["Oracle Database", "Java"].map(name => ({
        name, line: null, description: { text: "保存信息。", sourceIds: ["s1"] }, charging: null, sourceIds: ["s1"],
        membership: { text: "Our software license revenues come from perpetual licenses to Oracle Database and Java, recognised upfront.", sourceIds: ["s1"] },
      })),
    }] }, modelVersion: "fixture", fingerprint: "test", now });
  assert.deepEqual(result.businesses[0]!.offerings!.map(p => p.name), ["Oracle Database"]);
});


test("SP-21 recovers a model-omitted ownership quote only from cited material, before independent review", async () => {
  const fake = search();
  let reviewed = false;
  const result = await runBusinessExplainer({ ticker: "ORCL", companyName: "Oracle", nodes: [nodes[0]!], search: fake,
    model: async (stage, _system, payload) => {
      if (stage.includes("review")) {
        const { explanations } = payload as { explanations: Array<{offerings: Array<{membership?: {text: string}}>}> };
        assert.match(explanations[0]!.offerings[0]!.membership!.text, /software license revenues.*Oracle Database/);
        reviewed = true;
        return {issues: []};
      }
      return { businesses: [{nodeId: "software", summary: {text: "软件业务", sourceIds: ["s1"]}, products: [], offerings: [{name: "Oracle Database", line: null, description: {text: "保存信息。", sourceIds: ["s1"]}, charging: null, sourceIds: ["s1"]}]}] };
    }, modelVersion: "fixture", fingerprint: "test", now });
  assert.equal(reviewed, true);
  assert.equal(result.businesses[0]!.offerings!.length, 1);
  assert.ok(readBusinessExplainer(result, "ORCL")!.businesses[0]!.offerings![0]!.membership);
});
