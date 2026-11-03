import { test } from "node:test";
import assert from "node:assert/strict";
import { leadIn, pageExcerpt, runBusinessTree as runTreeAgent, sectionHeading, TREE_TOOLS, type TreeBlock, type TreeLibrary, type TreeMessage, type TreeModel, type TreeReply, type TreeSearch } from "../src/business-tree/agent.ts";

/**
 * SEC documents are read from the filing library alone (docs/sec-archive.md). These tests describe the library with the
 * same page the fake search serves, so the filing's text reaches the agent as the archive would hold it.
 */
const libraryOf = (search: TreeSearch, filings: Array<{ url: string; title: string; publishedAt: string | null }>): TreeLibrary => ({
  documents: async () => filings,
  read: async (url, terms, maxChars) => pageExcerpt((await search.fetchContent({ url, depth: "advanced" }, { scope: "test", maxAgeMs: 0 })).data.text, terms, maxChars),
  businessSection: async () => null,
});
const runBusinessTree: typeof runTreeAgent = input => runTreeAgent({ ...input, filingLibrary: input.filingLibrary ?? libraryOf(input.search, input.filings ?? []) });
import { treeBusinesses } from "../src/business-tree/workflow.ts";
import { lineAliases, namedIn, quotedIn, quoteProblem, readBusinessTree, withoutCitations } from "../../../shared/analysis-runtime/business-tree.ts";
import type { PublicBusinessFlow } from "../../../shared/analysis-contract/business-flow.ts";

const TENK = `More Personal Computing

Our More Personal Computing segment consists of products and services that put customers at the center of the experience with our technology. This segment primarily comprises:

Windows and Devices, including Windows OEM licensing and Devices, comprising Surface and PC accessories.

XBOX (formerly Gaming), including XBOX hardware and XBOX content and services.`;
const JOINED = "Our More Personal Computing segment consists of products and services that put customers at the center of the experience with our technology. This segment primarily comprises: … XBOX (formerly Gaming), including XBOX hardware and XBOX content and services.";
const FILING = { url: "https://www.sec.gov/Archives/edgar/data/789019/000119312526323660/msft-20260630.htm", title: "10-K", publishedAt: null };

/** A search provider that returns one page for every read and the given hits for every search. */
function search(page: string, hits: Array<{ title: string; url: string; snippet: string }> = []): TreeSearch {
  return {
    async search() { return { data: { kind: "search", results: hits.map(h => ({ ...h, publishedAt: null, score: 1 })) } }; },
    async fetchContent(request: { url: string }) { return { data: { kind: "content", url: request.url, text: page, format: "markdown", completeness: "unverified" } }; },
  } as unknown as TreeSearch;
}
let ids = 0;
/** A reply calling the given tools, as the Messages API returns it. */
const calls = (...list: Array<[string, Record<string, unknown>]>): TreeReply => ({ stopReason: "tool_use", content: list.map(([name, input]) => ({ type: "tool_use", id: `toolu_${++ids}`, name, input })) });
const call = (name: string, input: Record<string, unknown> = {}) => calls([name, input]);
/** Replies by `business-turn`; the review approves everything; anything unscripted finishes. */
const scripted = (script: Record<string, TreeReply>, verdicts: Record<string, Record<string, unknown>> = {}): TreeModel => ({
  act: async stage => script[stage.replace("business-tree-", "")] ?? call("finish"),
  judge: async stage => verdicts[stage] ?? { issues: [] },
});
const run = (businesses: Array<{ flowNodeId: string; name: string }>, model: TreeModel, page = TENK, hits: Array<{ title: string; url: string; snippet: string }> = []) =>
  runBusinessTree({ ticker: "MSFT", companyName: "Microsoft Corp", periodEnd: "2026-06-30", now: "2026-10-17T00:00:00.000Z", fingerprint: "f", modelVersion: "test",
    businesses: businesses.map(b => ({ ...b, children: [] })), filings: [FILING], search: search(page, hits), model });

test("every action is a strict tool whose objects admit no other field", () => {
  assert.deepEqual(TREE_TOOLS.map(t => t.name), ["search", "read", "add", "revise", "remove", "finish"]);
  const closed = (schema: unknown): boolean => {
    if (!schema || typeof schema !== "object") return true;
    const s = schema as Record<string, unknown>;
    if (s.type === "object" && s.additionalProperties !== false) return false;
    return Object.values(s).every(v => Array.isArray(v) ? v.every(closed) : closed(v));
  };
  for (const tool of TREE_TOOLS) { assert.equal(tool.strict, true); assert.ok(closed(tool.input_schema), tool.name); }
  assert.deepEqual(TREE_TOOLS.find(t => t.name === "revise")!.input_schema.required, ["id"]);
});

test("an anchor may join fragments of one passage, in order and close together, but not a table row", () => {
  assert.ok(quotedIn(JOINED, TENK));
  assert.ok(!quotedIn("XBOX (formerly Gaming), including XBOX hardware … Our More Personal Computing segment consists of products", TENK), "out of order");
  assert.ok(!quotedIn(JOINED, TENK.replace("comprises:", "comprises:" + " filler".repeat(500))), "too far apart");
  assert.ok(!quotedIn("Our More Personal Computing segment consists … XBOX", TENK), "a fragment too short to place");
  const table = "The North America segment primarily consists of amounts earned from retail sales of consumer products.\n\n| Third-party seller services (3) | 40,348 |";
  assert.ok(!quotedIn("The North America segment primarily consists of amounts earned from retail sales … Third-party seller services (3)", table));
  assert.ok(quotedIn("Windows and Devices, including Windows OEM licensing and Devices", TENK), "a single passage as before");
});

test("a listed item is read with its lead-in, and source ids leave the prose", () => {
  const page = "An introduction long enough to count as a paragraph about nothing in particular.\n\nThis segment primarily comprises:\n\nXBOX (formerly Gaming), including XBOX hardware and XBOX content and services.";
  assert.ok(pageExcerpt(page, ["xbox"], 2_000).startsWith("This segment primarily comprises:"));
  assert.equal(withoutCitations("Sells cloud services to enterprises (Source: b1-s1, b1-s6)."), "Sells cloud services to enterprises.");
  assert.equal(withoutCitations("Office apps sold per user [b2-s3]."), "Office apps sold per user.");
});

test("regions are skipped only when every segment is one", () => {
  const seg = (id: string, name: string) => ({ id, name, revenue: null, description: "", products: [], customers: null, monetization: null, disclosure: "", sourceIds: [] });
  const flow = (segments: ReturnType<typeof seg>[]) => ({ schemaVersion: "business-flow.v1", ticker: "X", fetchedAt: "", quarters: [{ id: "q", periodEnd: "2026-06-30", incomeModel: "standard", segments }] }) as unknown as PublicBusinessFlow;
  assert.equal(treeBusinesses(flow([seg("amzn:NorthAmericaSegmentMember", "North America"), seg("amzn:InternationalSegmentMember", "International"), seg("amzn:AmazonWebServicesSegmentMember", "AWS")]))?.businesses.length, 3);
  assert.equal(treeBusinesses(flow([seg("aapl:AmericasSegmentMember", "Americas"), seg("aapl:EuropeSegmentMember", "Europe")])), null);
});

test("a line the filing lists under a heading is kept through a joined anchor, its prose cleaned", async () => {
  const tree = await run([{ flowNodeId: "msft:MorePersonalComputingMember", name: "MorePersonalComputing" }], scripted({
    "1-1": call("read", { source: "b1-s1", focus: "XBOX" }),
    "1-2": call("add", { parent: "root", nodes: [{ name: "XBOX", gloss: "gaming console and content", kind: "line", anchor: { text: JOINED, sourceIds: ["b1-s1"] }, summary: { text: "Consoles, games and subscriptions (Source: b1-s1).", sourceIds: ["b1-s1"] }, revenue: [] }] }),
  }));
  const node = readBusinessTree(JSON.parse(JSON.stringify(tree)), "MSFT")?.branches[0]?.children[0];
  assert.equal(node?.name, "XBOX");
  assert.equal(node?.summary?.text, "Consoles, games and subscriptions.");
});

test("descriptions the loop left out or the review struck are written from the passages naming each node, then judged again", async () => {
  const asked: Array<{ id: string; evidence: Array<{ sourceId: string }> }> = [];
  const judged: string[] = [];
  const tree = await run([{ flowNodeId: "msft:MorePersonalComputingMember", name: "MorePersonalComputing" }], {
    act: async stage => ({
      "business-tree-1-1": call("read", { source: "b1-s1", focus: "XBOX" }),
      "business-tree-1-2": call("add", { parent: "root", nodes: [{ name: "XBOX", gloss: "gaming console and content", kind: "line", anchor: { text: JOINED, sourceIds: ["b1-s1"] }, summary: { text: "The best-selling console of the decade.", sourceIds: ["b1-s1"] }, revenue: [] }] }),
    } as Record<string, TreeReply>)[stage] ?? call("finish"),
    judge: async (stage, _system, payload) => {
      judged.push(stage);
      if (stage === "business-tree-review-b1") return { issues: [{ id: "b1-n1", field: "summary", problem: "not in the material" }] };
      if (stage === "business-tree-describe-b1") {
        asked.push(...(payload as { nodes: typeof asked }).nodes);
        return { summaries: [
          { id: "b1-n1", text: "XBOX consoles, games and content services for players.", sourceIds: ["b1-s1", "b1-s9"] },
          { id: "root", text: "The passages do not say who buys these products.", sourceIds: ["b1-s1"] },
        ] };
      }
      // The second round may only strike summaries: whatever else it reports is not applied or logged.
      return { issues: [{ id: "b1-n1", field: "node", problem: "not a product" }, { id: "b1-n1", field: "gloss", problem: "unsupported" }] };
    },
  });
  assert.deepEqual(judged, ["business-tree-review-b1", "business-tree-describe-b1", "business-tree-describe-review-b1"]);
  assert.deepEqual(asked.map(n => n.id), ["root", "b1-n1"]);
  assert.ok(asked.every(n => n.evidence.length && n.evidence.every(e => e.sourceId === "b1-s1")), "only passages of what was read");
  const branch = readBusinessTree(JSON.parse(JSON.stringify(tree)), "MSFT")!.branches[0]!;
  assert.deepEqual(branch.children[0]!.summary, { text: "XBOX consoles, games and content services for players.", sourceIds: ["s1"] });
  assert.equal(branch.summary, null, "a sentence about the passages is refused");
  const steps = tree.research![0]!.steps;
  assert.deepEqual(steps.slice(-3).map(s => s.action), ["review", "describe", "describe-review"]);
  assert.equal(steps.at(-3)!.observation, "b1-n1 XBOX · summary: not in the material");
  assert.match(steps.at(-2)!.observation, /Described 1 of 2: b1-n1\. Refused: root writes about the passages/);
  assert.equal(steps.at(-1)!.observation, "No issues.");
  assert.equal(branch.children[0]!.gloss, "gaming console and content");
});

test("a lead-in is the sentence or heading that introduces the listed paragraph a quote comes from", () => {
  const page = "Application Services\n\nCloudflare offers a suite of application services products:\n\n•DNS: Resolves names fast.\n\n•Bot Management: Detects and manages undesired traffic.";
  assert.equal(leadIn(page, "•Bot Management: Detects and manages undesired traffic."), "Cloudflare offers a suite of application services products:");
  assert.equal(leadIn(TENK, JOINED), "More Personal Computing");
  assert.equal(leadIn(page, "Not in the page"), null);
});

test("what hangs under a node the review strikes moves up where its own passage names the new parent, and the verdicts are logged", async () => {
  const filing = "Our Intelligent Cloud segment primarily comprises server products and cloud services, including Azure and other cloud services, GitHub and Nuance. Azure is a comprehensive set of cloud services of Intelligent Cloud. Azure AI Foundry is offered within Azure and other cloud services.";
  // Two businesses, so the company's own filing does not place everything under the company.
  const tree = await run([{ flowNodeId: "msft:IntelligentCloudMember", name: "IntelligentCloud" }, { flowNodeId: "msft:MorePersonalComputingMember", name: "MorePersonalComputing" }], scripted({
    "1-1": call("read", { source: "b1-s1", focus: "Azure" }),
    "1-2": call("add", { parent: "root", nodes: [{ name: "Azure and other cloud services", gloss: "public cloud", kind: "line", anchor: { text: filing.split(". ")[0] + ".", sourceIds: ["b1-s1"] }, summary: null, revenue: [] }] }),
    "1-3": call("add", { parent: "b1-n1", nodes: [
      { name: "Azure", gloss: "cloud platform", kind: "product", anchor: { text: "Azure is a comprehensive set of cloud services of Intelligent Cloud.", sourceIds: ["b1-s1"] }, summary: null, revenue: [] },
      { name: "GitHub", gloss: "code hosting", kind: "product", anchor: { text: filing.split(". ")[0] + ".", sourceIds: ["b1-s1"] }, summary: null, revenue: [] },
      { name: "Azure AI Foundry", gloss: "AI app platform", kind: "product", anchor: { text: "Azure AI Foundry is offered within Azure and other cloud services.", sourceIds: ["b1-s1"] }, summary: null, revenue: [] }] }),
  }, { "business-tree-review-b1": { issues: [{ id: "b1-n1", field: "node", problem: "generic name" }] } }), filing);
  const line = tree.branches[0]!.children;
  assert.deepEqual(line.map(n => n.name), ["Azure", "GitHub"], "products whose passage names the segment move up; one placed only by the struck line goes");
  const review = tree.research![0]!.steps.find(s => s.action === "review")!;
  assert.match(review.observation, /^b1-n1 Azure and other cloud services · node: generic name\nMoved up: b1-n2 Azure → root; b1-n3 GitHub → root$/);
});

test("a product described in a section headed by its line is placed by that heading, which the anchor carries", async () => {
  const segment = "The Compute & Networking segment includes our Data Center accelerated computing and networking platforms and AI solutions and software.";
  const blackwell = "In fiscal year 2025, we launched the NVIDIA Blackwell architecture, a full set of rack-scale infrastructure that includes GPUs, CPUs and networking adapters.";
  const page = `## Our Businesses\n\n${segment}\n\n## Data Center\n\nThe NVIDIA Data Center platform is focused on accelerating compute-intensive workloads such as AI and scientific computing.\n\n${blackwell}`;
  assert.equal(sectionHeading(page, blackwell), "Data Center");
  assert.equal(sectionHeading(page, "Not in the page"), null);
  const tree = await run([{ flowNodeId: "nvda:ComputeAndNetworkingSegmentMember", name: "Compute & Networking" }, { flowNodeId: "nvda:GraphicsSegmentMember", name: "Graphics" }], scripted({
    "1-1": call("read", { source: "b1-s1", focus: "Data Center Blackwell networking" }),
    "1-2": call("add", { parent: "root", nodes: [{ name: "Data Center", gloss: "AI computing platforms", kind: "line", anchor: { text: segment, sourceIds: ["b1-s1"] }, summary: null, revenue: [] }] }),
    "1-3": call("add", { parent: "b1-n1", nodes: [
      { name: "NVIDIA Blackwell", gloss: "AI GPU architecture", kind: "product", anchor: { text: blackwell, sourceIds: ["b1-s1"] }, summary: null, revenue: [] },
      { name: "Grace", gloss: "data center CPU", kind: "product", anchor: { text: segment, sourceIds: ["b1-s1"] }, summary: null, revenue: [] }] }),
  }), page);
  const line = readBusinessTree(JSON.parse(JSON.stringify(tree)), "MSFT")!.branches[0]!.children[0]!;
  assert.deepEqual(line.children.map(n => [n.name, n.anchor?.text]), [["NVIDIA Blackwell", `Data Center … ${blackwell}`]], "the reader keeps the joined anchor");
  assert.match(tree.research![0]!.steps[2]!.observation, /Grace — anchor does not contain the name "Grace"/);
});

test("a placement verdict on a node its own lead-in places is overruled, and the verdict is logged", async () => {
  const tree = await run([{ flowNodeId: "msft:MorePersonalComputingMember", name: "MorePersonalComputing" }, { flowNodeId: "msft:IntelligentCloudMember", name: "IntelligentCloud" }], scripted({
    "1-1": call("read", { source: "b1-s1", focus: "XBOX" }),
    "1-2": call("add", { parent: "root", nodes: [{ name: "XBOX", gloss: "gaming", kind: "line", anchor: { text: JOINED, sourceIds: ["b1-s1"] }, summary: null, revenue: [] }] }),
  }, { "business-tree-review-b1": { issues: [{ id: "b1-n1", field: "node", kind: "placement", problem: "company-wide list of segments" }] } }));
  assert.deepEqual(tree.branches[0]!.children.map(n => n.name), ["XBOX"]);
  const review = tree.research![0]!.steps.find(s => s.action === "review")!;
  assert.equal(review.observation, "b1-n1 XBOX · node placement: company-wide list of segments\nPlaced: b1-n1 XBOX stays: its lead-in names its parent");
});

test("a misplaced node moves where the review says it belongs when a passage places it there, and is removed when none does", async () => {
  const page = "Family of Apps (FoA) includes Facebook, Instagram and WhatsApp.\n\nFamily of Apps advertising services let marketers reach people on Facebook, Instagram and Threads.";
  const ads = "Family of Apps advertising services let marketers reach people on Facebook, Instagram and Threads.";
  const product = (name: string) => ({ name, gloss: "app", kind: "product", anchor: { text: ads, sourceIds: ["b1-s1"] }, summary: null, revenue: [] });
  const tree = await run([{ flowNodeId: "meta:FamilyOfAppsMember", name: "Family of Apps" }, { flowNodeId: "meta:RealityLabsMember", name: "Reality Labs" }], scripted({
    "1-1": call("read", { source: "b1-s1", focus: "Facebook advertising" }),
    "1-2": call("add", { parent: "root", nodes: [{ name: "Advertising services", gloss: "ads", kind: "line", anchor: { text: ads, sourceIds: ["b1-s1"] }, summary: null, revenue: [] }] }),
    "1-3": call("add", { parent: "b1-n1", nodes: [product("Facebook"), product("Threads"), product("Reels")] }),
  }, { "business-tree-review-b1": { issues: [
    { id: "b1-n2", field: "node", kind: "placement", parent: "root", problem: "an app of FoA, not an ad product" },
    { id: "b1-n3", field: "node", kind: "placement", problem: "not placed anywhere in this business" },
    { id: "b1-n4", field: "node", kind: "name", problem: "a feature" },
  ] } }), page);
  const top = tree.branches[0]!.children;
  assert.deepEqual(top.map(n => [n.name, n.children.map(c => c.name)]), [["Advertising services", []], ["Facebook", []]], "Threads names no parent to move to; Reels is not a product");
  assert.equal(top[1]!.anchor!.text, "Family of Apps (FoA) includes Facebook, Instagram and WhatsApp.");
  assert.match(tree.research![0]!.steps.find(s => s.action === "review")!.observation, /Placed: b1-n2 Facebook → root$/);
});

test("finishing with a bare category line is answered once with a request for named products and pricing", async () => {
  const filing = "We serve developers and enterprises of all sizes through AWS, which offers a broad set of on-demand technology services, including compute, storage, database, analytics, and other services.";
  const ec2 = "Amazon EC2 provides secure and resizable compute capacity in the cloud, the compute service of AWS. With On-Demand Instances you pay for compute capacity by the second with no long-term commitments.";
  const tree = await runBusinessTree({ ticker: "AMZN", companyName: "Amazon.com, Inc.", periodEnd: "2026-06-30", now: "2026-10-17T00:00:00.000Z", fingerprint: "f", modelVersion: "test",
    businesses: [{ flowNodeId: "amzn:AmazonWebServicesSegmentMember", name: "AWS", children: [] }, { flowNodeId: "amzn:NorthAmericaSegmentMember", name: "North America", children: [] }],
    filings: [FILING], search: { ...search(filing, [{ title: "Amazon EC2", url: "https://aws.amazon.com/ec2/", snippet: ec2 }]),
      async fetchContent(request: { url: string }) { return { data: { kind: "content", url: request.url, text: request.url.includes("aws.amazon.com") ? ec2 : filing, format: "markdown", completeness: "unverified" } }; } } as unknown as TreeSearch,
    model: scripted({
      "1-1": call("read", { source: "b1-s1", focus: "compute" }),
      "1-2": call("add", { parent: "root", nodes: [{ name: "compute", gloss: "cloud compute", kind: "line", anchor: { text: filing, sourceIds: ["b1-s1"] }, summary: null, revenue: [] }] }),
      "1-3": call("finish"),
      "1-4": call("search", { query: "Amazon Web Services compute products pricing" }),
      "1-5": call("add", { parent: "b1-n1", nodes: [{ name: "Amazon EC2", gloss: "virtual servers", kind: "product", anchor: { text: "Amazon EC2 provides secure and resizable compute capacity in the cloud, the compute service of AWS.", sourceIds: ["b1-s2"] }, summary: null,
        revenue: [{ type: "consumption", label: "Pay per second", text: "Customers pay for compute capacity by the second with no long-term commitment.", sourceIds: ["b1-s2"] }] }] }),
      "1-6": call("finish"),
    }) });
  const steps = tree.research![0]!.steps;
  assert.match(steps[2]!.observation, /name fewer than two products: b1-n1 Compute \(none\)/);
  assert.equal(steps.at(-3)!.observation, "Finished.");
  assert.deepEqual(steps.slice(-2).map(s => [s.action, s.observation]), [["review", "No issues."], ["describe", steps.at(-1)!.observation]]);
  const compute = tree.branches[0]!.children[0]!;
  assert.equal(compute.children[0]!.name, "Amazon EC2");
  assert.equal(compute.children[0]!.revenue[0]!.type, "consumption");
});

test("replies that keep failing stop the run with the provider's words instead of spending the budget", async () => {
  let turns = 0;
  const failing: TreeModel = { act: async () => { turns++; return { error: "stream_incomplete: Model business-tree-1-1 stream interrupted: Overloaded" }; }, judge: async () => ({ issues: [] }) };
  await assert.rejects(run([{ flowNodeId: "msft:IntelligentCloudMember", name: "IntelligentCloud" }], failing), /3 model replies in a row failed; last: stream_incomplete: .*Overloaded/);
  assert.equal(turns, 3);
  const declining: TreeModel = { act: async () => ({ content: [], stopReason: "refusal", refusalCategory: "general_harms" }), judge: async () => ({ issues: [] }) };
  await assert.rejects(run([{ flowNodeId: "msft:IntelligentCloudMember", name: "IntelligentCloud" }], declining), /last: refusal \(general_harms\)/);
});

test("the exchange only grows: each reply goes back exactly as returned, thinking included, followed by its results", async () => {
  const sent: TreeMessage[][] = [];
  const thinking: TreeBlock = { type: "thinking", thinking: "", signature: "sig-1" };
  const replies: Record<string, TreeReply> = {
    "1-1": { stopReason: "tool_use", content: [thinking, { type: "tool_use", id: "toolu_read", name: "read", input: { source: "b1-s1", focus: "XBOX" } }] },
    "1-2": { error: "stream_incomplete: interrupted" },
    "1-3": calls(["search", { query: "Microsoft Xbox Game Pass subscription pricing" }], ["Read", { source: "b1-s1", focus: "Surface" }]),
    "1-4": { stopReason: "end_turn", content: [{ type: "text", text: "Done." }] },
    "1-5": { stopReason: "end_turn", content: [{ type: "text", text: "Still done." }] },
  };
  const model: TreeModel = {
    act: async (stage, system, tools, messages) => { sent.push(structuredClone(messages)); assert.equal(tools, TREE_TOOLS); assert.doesNotMatch(system, /thought|Return only JSON/i); return replies[stage.replace("business-tree-", "")] ?? call("finish"); },
    judge: async () => ({ issues: [] }),
  };
  // Nothing is added, so the run ends without a tree; the exchange is what is checked.
  await assert.rejects(run([{ flowNodeId: "msft:MorePersonalComputingMember", name: "MorePersonalComputing" }], model, TENK, [{ title: "Xbox Game Pass", url: "https://www.xbox.com/game-pass", snippet: "Game Pass is a monthly subscription." }]), /found nothing/);
  // Every request extends the one before it; a failed reply adds nothing, so the retry sends the same exchange.
  for (let i = 1; i < sent.length; i++) assert.deepEqual(sent[i]!.slice(0, sent[i - 1]!.length), sent[i - 1]);
  assert.deepEqual(sent[2], sent[1]);
  assert.match(sent[0]![0]!.content as string, /"company":"Microsoft Corp"/);
  assert.deepEqual(sent[1]![1], { role: "assistant", content: replies["1-1"]!.content });
  const results = sent[1]![2]!.content as TreeBlock[];
  assert.equal(results[0]!.tool_use_id, "toolu_read");
  assert.match(String(results[0]!.content), /XBOX[\s\S]*Budget left: 15 turns, 6 searches, 5 reads/);
  // Two calls in one reply, the second named in another case, each get their result.
  const both = sent[3]!.at(-1)!.content as TreeBlock[];
  assert.deepEqual(both.map(b => b.type), ["tool_result", "tool_result"]);
  assert.match(String(both[1]!.content), /^\[b1-s1\]/);
  // A reply calling no tool is asked once to go on; the second ends the business.
  assert.deepEqual(sent[4]!.at(-1), { role: "user", content: "Continue the breakdown by calling the tools; call finish when it is complete." });
  assert.equal(sent.length, 5);
});

test("a tool the harness does not know is answered as an error the model can correct", async () => {
  let answer: TreeBlock | undefined;
  await run([{ flowNodeId: "msft:IntelligentCloudMember", name: "IntelligentCloud" }], {
    act: async (stage, _system, _tools, messages) => {
      if (stage.endsWith("-2")) answer = (messages.at(-1)!.content as TreeBlock[])[0];
      return stage.endsWith("-1") ? call("browse", { url: "x" }) : call("finish");
    },
    judge: async () => ({ issues: [] }),
  }).catch(() => null);
  assert.equal(answer?.is_error, true);
  assert.match(String(answer?.content), /There is no tool "browse"/);
});

const AMZN_SEGMENT = "The North America segment primarily consists of amounts earned from retail sales of consumer products (including from sellers) and advertising and subscription services through North America-focused online and physical stores.";

test("a list whose members share their last word names each member, and nothing else", () => {
  assert.ok(namedIn("Advertising services", AMZN_SEGMENT));
  assert.ok(namedIn("Online stores", AMZN_SEGMENT));
  assert.ok(namedIn("Physical stores", AMZN_SEGMENT));
  assert.ok(namedIn("Storage services", "We offer compute, storage, and database services."));
  assert.ok(namedIn("Compute services", "We offer compute, storage, and database services."));
  assert.ok(!namedIn("Retail services", AMZN_SEGMENT), "retail heads another phrase");
  assert.ok(!namedIn("Online services", AMZN_SEGMENT), "online belongs to stores, not services");
  assert.ok(!namedIn("Subscription stores", "subscription services and physical stores"));
  assert.ok(namedIn("SASE platform", 'Our Secure Access Service Edge ("SASE") platform combines network services.'), "punctuation is not a word");
  assert.ok(namedIn("Third-party seller services", "Third party seller services - We offer programs"));
  assert.ok(!namedIn("Azure", "services from AzureStack"), "a name is a whole word");
});

test("a quote that does not stand in its source says why", () => {
  assert.match(quoteProblem("XBOX hardware and the moon", TENK)!, /"XBOX hardware and the moon" is not in the source word for word/);
  assert.match(quoteProblem(JOINED, TENK.replace("comprises:", "comprises:" + " filler".repeat(500)))!, /not one passage/);
  assert.equal(quoteProblem(JOINED, TENK), null);
});

test("the segment's own sentence anchors its lines, which read capitalised; a described product is refused", async () => {
  const tree = await runBusinessTree({ ticker: "AMZN", companyName: "Amazon.com, Inc.", periodEnd: "2026-06-30", now: "2026-10-17T00:00:00.000Z", fingerprint: "f", modelVersion: "test",
    businesses: [{ flowNodeId: "amzn:NorthAmericaSegmentMember", name: "North America", children: [] }, { flowNodeId: "amzn:AmazonWebServicesSegmentMember", name: "AWS", children: [] }],
    filings: [FILING], search: search(`${AMZN_SEGMENT}\n\nWe provide advertising services to sellers, vendors, publishers, authors, and others, through programs such as sponsored ads, display, and video advertising.`),
    model: scripted({
      "1-1": call("read", { source: "b1-s1", focus: "North America" }),
      "1-2": call("add", { parent: "root", nodes: [
        { name: "advertising services", gloss: "ads sold to sellers and brands", kind: "line", anchor: { text: AMZN_SEGMENT, sourceIds: ["b1-s1"] }, summary: null, revenue: [] },
        { name: "Our online stores", gloss: "first-party e-commerce", kind: "line", anchor: { text: AMZN_SEGMENT, sourceIds: ["b1-s1"] }, summary: null, revenue: [] }] }),
      "1-3": call("add", { parent: "b1-n1", nodes: [{ name: "sponsored ads", gloss: "search ads", kind: "product", anchor: { text: "We provide advertising services to sellers, vendors, publishers, authors, and others, through programs such as sponsored ads, display, and video advertising.", sourceIds: ["b1-s1"] }, summary: null, revenue: [] }] }),
    }) });
  const lines = tree.branches[0]!.children;
  assert.deepEqual(lines.map(n => n.name), ["Advertising services", "Online stores"]);
  assert.match(tree.research![0]!.steps[2]!.observation, /"sponsored ads" describes a product rather than naming it/);
});

test("a company with one business anchors its lines in its own filing without naming itself; a web page still must", async () => {
  const filing = "Our SASE platform combines network services and Zero Trust and workplace security products to provide a cloud-based network and security-as-a-service offering.";
  const vendor = "The SASE platform helps teams secure remote work.";
  const own = (id: string) => ({ flowNodeId: "cloud:ReportableSegmentMember", name: "Reportable Segment", children: [] as Array<{ flowNodeId: string; name: string }>, id });
  const tree = await runBusinessTree({ ticker: "NET", companyName: "Cloudflare, Inc. Class A Common Stock", periodEnd: "2026-06-30", now: "2026-10-17T00:00:00.000Z", fingerprint: "f", modelVersion: "test",
    businesses: [own("x")], filings: [FILING],
    search: { ...search(filing, [{ title: "SASE", url: "https://example.com/sase", snippet: vendor }]),
      async fetchContent(request: { url: string }) { return { data: { kind: "content", url: request.url, text: request.url.includes("example.com") ? vendor : filing, format: "markdown", completeness: "unverified" } }; } } as unknown as TreeSearch,
    model: scripted({
      "1-1": call("read", { source: "b1-s1", focus: "SASE" }),
      "1-2": call("search", { query: "Cloudflare SASE platform" }),
      "1-3": call("add", { parent: "root", nodes: [{ name: "SASE platform", gloss: "Zero Trust and network services", kind: "line", anchor: { text: vendor, sourceIds: ["b1-s2"] }, summary: null, revenue: [] }] }),
      "1-4": call("add", { parent: "root", nodes: [{ name: "SASE platform", gloss: "Zero Trust and network services", kind: "line", anchor: { text: filing, sourceIds: ["b1-s1"] }, summary: null, revenue: [] }] }),
    }) });
  assert.match(tree.research![0]!.steps[2]!.observation, /names "SASE platform" but not its parent/);
  assert.equal(tree.sources.find(x => x.url === FILING.url)?.own, true);
  // The reader applies the same rule from the stored sources.
  const read = readBusinessTree(JSON.parse(JSON.stringify(tree)), "NET");
  assert.equal(read?.branches[0]?.children[0]?.name, "SASE platform");
  const stripped = { ...tree, sources: tree.sources.map(source => ({ ...source, own: false })) };
  assert.equal(readBusinessTree(JSON.parse(JSON.stringify(stripped)), "NET"), null, "without the company's own filing the line names no parent");
});

test("a line that already says how it charges is still asked once for its named products", async () => {
  const filing = "We serve developers and enterprises of all sizes through AWS, which offers a broad set of on-demand technology services, including compute, storage, database, analytics, and other services. Customers pay for compute as they use it.";
  const tree = await runBusinessTree({ ticker: "AMZN", companyName: "Amazon.com, Inc.", periodEnd: "2026-06-30", now: "2026-10-17T00:00:00.000Z", fingerprint: "f", modelVersion: "test",
    businesses: [{ flowNodeId: "amzn:AmazonWebServicesSegmentMember", name: "AWS", children: [] }, { flowNodeId: "amzn:NorthAmericaSegmentMember", name: "North America", children: [] }],
    filings: [FILING], search: search(filing),
    model: scripted({
      "1-1": call("read", { source: "b1-s1", focus: "compute" }),
      "1-2": call("add", { parent: "root", nodes: [{ name: "compute", gloss: "cloud compute", kind: "line", anchor: { text: filing.split(". ")[0] + ".", sourceIds: ["b1-s1"] }, summary: null,
        revenue: [{ type: "consumption", label: "Pay as you go", text: "Customers pay for compute as they use it.", sourceIds: ["b1-s1"] }] }] }),
    }) });
  const finish = tree.research![0]!.steps.find(x => x.action === "finish")!;
  assert.match(finish.observation, /name fewer than two products: b1-n1 Compute \(none\)\. /);
  assert.doesNotMatch(finish.observation, /charged/);
});

test("a category line is named by its own words; a disclosed business only in full", async () => {
  assert.deepEqual(lineAliases("Advertising services"), ["Advertising"]);
  assert.deepEqual(lineAliases("Artificial intelligence and machine learning"), ["Artificial intelligence", "machine learning"]);
  assert.deepEqual(lineAliases("Online stores"), []);
  const ads = "Sponsored Products are cost-per-click ads that promote individual product listings; Amazon advertising reaches shoppers where they browse.";
  const tree = await runBusinessTree({ ticker: "AMZN", companyName: "Amazon.com, Inc.", periodEnd: "2026-06-30", now: "2026-10-17T00:00:00.000Z", fingerprint: "f", modelVersion: "test",
    businesses: [{ flowNodeId: "amzn:NorthAmericaSegmentMember", name: "North America", children: [] }, { flowNodeId: "amzn:AmazonWebServicesSegmentMember", name: "AWS", children: [] }],
    filings: [FILING], search: { ...search(AMZN_SEGMENT, [{ title: "Sponsored Products", url: "https://advertising.amazon.com/sponsored-products", snippet: ads }]),
      async fetchContent(request: { url: string }) { return { data: { kind: "content", url: request.url, text: request.url.includes("advertising") ? ads : AMZN_SEGMENT, format: "markdown", completeness: "unverified" } }; } } as unknown as TreeSearch,
    model: scripted({
      "1-1": calls(["read", { source: "b1-s1", focus: "North America" }], ["search", { query: "Amazon Sponsored Products" }]),
      "1-2": call("add", { parent: "root", nodes: [{ name: "Advertising services", gloss: "ads", kind: "line", anchor: { text: AMZN_SEGMENT, sourceIds: ["b1-s1"] }, summary: null, revenue: [] }] }),
      "1-3": call("add", { parent: "b1-n1", nodes: [{ name: "Sponsored Products", gloss: "cost-per-click listing ads", kind: "product", anchor: { text: ads, sourceIds: ["b1-s2"] }, summary: null, revenue: [] }] }),
    }) });
  assert.equal(tree.branches[0]!.children[0]!.children[0]?.name, "Sponsored Products");
  assert.equal(readBusinessTree(JSON.parse(JSON.stringify(tree)), "AMZN")?.branches[0]?.children[0]?.children[0]?.name, "Sponsored Products", "the reader reads the line the same way");
});

test("a node refused twice under one parent is told to be left out", async () => {
  const add = call("add", { parent: "root", nodes: [{ name: "Third-party seller services", gloss: "marketplace", kind: "line", anchor: { text: "Third-party seller services", sourceIds: ["b1-s1"] }, summary: null, revenue: [] }] });
  const steps: string[] = [];
  await run([{ flowNodeId: "msft:IntelligentCloudMember", name: "IntelligentCloud" }], {
    act: async (stage, _s, _t, messages) => { const last = messages.at(-1)!; if (Array.isArray(last.content)) steps.push(String(last.content[0]!.content)); return stage.endsWith("-1") || stage.endsWith("-2") ? { ...add, content: add.content.map(b => ({ ...b, id: `toolu_${stage}` })) } : call("finish"); },
    judge: async () => ({ issues: [] }),
  }).catch(() => null);
  assert.doesNotMatch(steps[0]!, /refused/);
  assert.match(steps[1]!, /refused 2 times: leave it out/);
});
