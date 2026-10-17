import { test } from "node:test";
import assert from "node:assert/strict";
import { pageExcerpt, runBusinessTree, TREE_TOOLS, type TreeBlock, type TreeMessage, type TreeModel, type TreeReply, type TreeSearch } from "../src/business-tree/agent.ts";
import { treeBusinesses } from "../src/business-tree/workflow.ts";
import { quotedIn, readBusinessTree, withoutCitations } from "../../../shared/analysis-runtime/business-tree.ts";
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
const scripted = (script: Record<string, TreeReply>): TreeModel => ({
  act: async stage => script[stage.replace("business-tree-", "")] ?? call("finish"),
  judge: async () => ({ issues: [] }),
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
  assert.match(steps[2]!.observation, /no named product under them/);
  assert.equal(steps.at(-1)!.observation, "Finished.");
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
