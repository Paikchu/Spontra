import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BusinessUnit } from "../../../shared/analysis-contract/business-tags.ts";
import type { PeersPublication } from "../../../shared/analysis-contract/peers.ts";
import { basisOf, buildUnits, checkTags, COMPANY_TOTAL, coverage, nameGuard, pairsFromHits, readAssignments, readTagReview, readThresholds, tagIdOf, tierOf, type MatchTag } from "../../../shared/analysis-runtime/business-tags.ts";
import type { FindingData } from "../../../shared/analysis-runtime/findings.ts";
import { compileTable, peersOf } from "../../../shared/analysis-runtime/lens/table.ts";
import { comparablePeers, peersFor, readPeersPublication } from "../../../shared/analysis-runtime/peers.ts";
import { matchCompany } from "../src/business-tags/match.ts";
import { setTagStatus } from "../src/business-tags/view.ts";
import { writeTags } from "../src/business-tags/workflow.ts";
import { exposureOf } from "../src/business-tags/input.ts";
import type { SecPipelineEnv, TagIndex } from "../src/operations.ts";
import { SUBSCRIPTIONS, TASKS, validateRegistry } from "../src/pipeline/registry.ts";

const link = (businessKey: string, name: string, flowNodeId: string | null, industryCategory: string | null, sectionIds: string[], status: "verified" | "disputed" | "confirmed" = "verified") =>
  ({ businessKey, name, flowNodeId, industryCategory: industryCategory as never, sectionIds, status });

test("units: one per revenue node; a single-segment company's links all fall under its total; an unnoded link waits for a placement", () => {
  const crwv = buildUnits("CRWV", [link("CRWV:platform", "CoreWeave Cloud Platform", null, "cloud_infrastructure", ["s1", "s2"]), link("CRWV:wandb", "Weights & Biases", null, "developer_tools", ["s3"]), link("CRWV:x", "X", null, null, ["s2"], "disputed")], []);
  assert.equal(crwv.units.length, 1);
  assert.equal(crwv.units[0]!.unitKey, `CRWV|${COMPANY_TOTAL}`);
  assert.deepEqual(crwv.units[0]!.sectors, ["cloud_infrastructure", "developer_tools"], "a disputed link brings no sector");
  assert.deepEqual(crwv.units[0]!.sectionIds, ["s1", "s2", "s3"]);
  const nodes = [{ flowNodeId: "msft:IntelligentCloudMember", name: "Intelligent Cloud" }, { flowNodeId: "msft:MorePersonalComputingMember", name: "More Personal Computing" }];
  const links = [link("MSFT:intelligent-cloud", "Intelligent Cloud", "msft:IntelligentCloudMember", "cloud_infrastructure", ["a"]), link("MSFT:server", "Server Products and Cloud Services", null, "cloud_infrastructure", ["b"])];
  const before = buildUnits("MSFT", links, nodes);
  assert.deepEqual(before.unplaced.map(u => u.businessKey), ["MSFT:server"]);
  const assignments = readAssignments({ linkUnits: [{ businessKey: "MSFT:server", flowNodeId: "msft:IntelligentCloudMember" }, { businessKey: "MSFT:intelligent-cloud", flowNodeId: "msft:MorePersonalComputingMember" }, { businessKey: "MSFT:server", flowNodeId: "made-up" }] }, ["MSFT:server"], nodes);
  assert.deepEqual(assignments, { "MSFT:server": "msft:IntelligentCloudMember" }, "only unplaced links and offered nodes count");
  const after = buildUnits("MSFT", links, nodes, assignments);
  assert.equal(after.unplaced.length, 0);
  assert.deepEqual(after.units[0]!.linkKeys, ["MSFT:intelligent-cloud", "MSFT:server"]);
  assert.deepEqual(after.units[0]!.sectionIds, ["a", "b"]);
});

test("tags: the unit's sector and passages only, no digits, no company names; tickers match only as whole upper-case words", () => {
  const guard = nameGuard(["NET", "NBIS"], ["Cloudflare", "Nebius Group"]);
  assert.equal(guard("network edge services"), null);
  assert.equal(guard("like NET does"), "NET");
  assert.equal(guard("cloudflare-style edge"), "Cloudflare");
  const scopes = new Map([["CRWV|reported-company-total", { sectors: ["cloud_infrastructure" as const], passageIds: new Set(["p1", "p2"]) }]]);
  const tag = (over: Record<string, unknown>) => ({ sector: "cloud_infrastructure", facet: "offering", label: "GPU capacity leasing", labelZh: "GPU 产能租赁", definition: "Renting accelerated compute capacity to customers.", passageIds: ["p1"], ...over });
  const raw = { units: [{ unitKey: "CRWV|reported-company-total", tags: [
    tag({}), tag({ label: "GPU capacity leasing" }), tag({ facet: "customers", label: "AI research labs", labelZh: "AI 实验室", definition: "Laboratories training models." }),
    tag({ label: "cloud", labelZh: "云" }), tag({ label: "Nebius Group style cloud" }), tag({ label: "capacity of 250 thousand GPUs" }), tag({ sector: "advertising", label: "ad sales network" }),
    tag({ label: "debt financed GPU fleet", facet: "cost", passageIds: ["p9"] }), tag({ facet: "price", label: "usage based billing" }),
  ] }, { unitKey: "CRWV|other", tags: [tag({})] }] };
  const { tags, notes } = checkTags(raw, scopes, guard);
  assert.deepEqual(tags.map(t => t.label), ["GPU capacity leasing", "AI research labs"]);
  assert.equal(tags[0]!.tagId, tagIdOf("CRWV|reported-company-total", "cloud_infrastructure", "offering", "gpu capacity leasing"));
  for (const reason of ["label:", "names_company:", "digits:", "sector:", "passages:", "facet:", "unknown_unit:"]) assert.ok(notes.some(n => n.startsWith(reason)), reason);
  assert.deepEqual([...readTagReview({ reviews: [{ id: tags[0]!.tagId, supported: true }, { id: tags[1]!.tagId, supported: "yes" }, { id: "t-unknown", supported: true }] }, tags.map(t => t.tagId))], [tags[0]!.tagId], "only an explicit yes keeps a tag");
});

test("tiers: what is sold decides whether units are peers, the other facets how close; the basis follows from tier and exposure", () => {
  assert.equal(tierOf({ offering: "same", customers: "same", contract: "partial", cost: "same" }), "direct");
  assert.equal(tierOf({ offering: "same", customers: "partial", contract: "unknown", cost: "different" }), "partial");
  assert.equal(tierOf({ offering: "same", customers: "same", contract: "same", cost: "different" }), "partial", "a known facet that differs keeps a pair from direct");
  assert.equal(tierOf({ offering: "partial", customers: "partial", contract: "different", cost: "different" }), "partial");
  assert.equal(tierOf({ offering: "partial", customers: "different", contract: "unknown", cost: "different" }), "adjacent");
  assert.equal(tierOf({ offering: "different", customers: "same", contract: "same", cost: "same" }), "sector");
  const whole = { exposure: 1, revenue: "2575000000" }, nebius = { exposure: 0.987, revenue: "574900000" }, oci = { exposure: 0.382, revenue: "7388000000" }, hidden = { exposure: null, revenue: null };
  assert.equal(basisOf("direct", whole, nebius), "company");
  assert.equal(basisOf("partial", whole, oci), "unit");
  assert.equal(basisOf("partial", whole, hidden), "quote");
  assert.equal(basisOf("adjacent", whole, nebius), "quote");
  assert.equal(exposureOf("7388000000", "19345000000"), 0.382);
  assert.equal(exposureOf(null, "1"), null);
  assert.deepEqual(readThresholds('{"same":0.9,"near":0.7}'), { same: 0.9, near: 0.7 });
  assert.deepEqual(readThresholds('{"same":0.5,"near":0.7}'), { same: 0.77, near: 0.7 }, "an inverted pair keeps the defaults");
  assert.equal(tierOf({ offering: "same", customers: "same", contract: "unknown", cost: "partial" }), "direct", "a facet one side has no tag in says nothing");
  assert.equal(tierOf({ offering: "same", customers: "unknown", contract: "unknown", cost: "unknown" }), "partial", "the offering alone is not enough for direct");
});

const unit = (ticker: string, node: string, sectors: string[]): BusinessUnit => ({ ticker, unitKey: `${ticker}|${node}`, flowNodeId: node, name: node, linkKeys: [], sectors: sectors as never, sectionIds: [] });
const mtag = (id: string, unitKey: string, facet: MatchTag["facet"], sector = "cloud_infrastructure"): MatchTag => ({ tagId: id, unitKey, sector: sector as never, facet });

test("pairs: each shared sector's facets from the best hits, the best tier any sector gives, stored the same way from either side", () => {
  const crwv = unit("CRWV", COMPANY_TOTAL, ["cloud_infrastructure", "developer_tools"]), nbis = unit("NBIS", "Nebius AI cloud", ["cloud_infrastructure"]), net = unit("NET", "total", ["cloud_infrastructure", "developer_tools"]);
  const own = [mtag("c1", crwv.unitKey, "offering"), mtag("c2", crwv.unitKey, "customers"), mtag("c3", crwv.unitKey, "cost"), mtag("c4", crwv.unitKey, "offering", "developer_tools")];
  const peers = [mtag("n1", nbis.unitKey, "offering"), mtag("n2", nbis.unitKey, "customers"), mtag("n3", nbis.unitKey, "cost"), mtag("e1", net.unitKey, "offering"), mtag("e2", net.unitKey, "offering", "developer_tools")];
  const hits = [{ own: "c1", peer: "n1", score: 0.91 }, { own: "c2", peer: "n2", score: 0.84 }, { own: "c3", peer: "n3", score: 0.83 }, { own: "c1", peer: "e1", score: 0.55 }, { own: "c4", peer: "e2", score: 0.72 }, { own: "c1", peer: "n1", score: 0.6 }];
  const pairs = pairsFromHits([crwv], [nbis, net], own, peers, hits, { same: 0.8, near: 0.68 });
  const withNbis = pairs.find(p => p.pairKey.includes("NBIS"))!;
  assert.equal(withNbis.tier, "direct");
  assert.equal(withNbis.sectors.cloud_infrastructure!.offering.score, 0.91, "the best hit counts");
  assert.equal(withNbis.sectors.cloud_infrastructure!.contract.value, "unknown", "no side has a contract tag");
  assert.equal(withNbis.left, crwv.unitKey, "CRWV sorts first");
  const withNet = pairs.find(p => p.pairKey.includes("NET"))!;
  assert.equal(withNet.tier, "adjacent", "close under developer tools, different under cloud");
  assert.equal(withNet.tierSector, "developer_tools");
  // From NBIS's side the same row comes out.
  const back = pairsFromHits([nbis], [crwv], peers.filter(t => t.unitKey === nbis.unitKey), own, hits.map(h => ({ own: h.peer, peer: h.own, score: h.score })), { same: 0.8, near: 0.68 });
  assert.equal(back[0]!.pairKey, withNbis.pairKey);
  assert.equal(back[0]!.left, withNbis.left);
  assert.equal(back[0]!.sectors.cloud_infrastructure!.offering.leftTag, "c1");
});

test("coverage: one shared tag does not make a broad business the same as a narrow one; both sides must be covered", () => {
  const table: Record<string, number> = { "gpu~gpu2": 0.9, "gpu~ai": 0.85, "gpu~iaas": 0.6, "gpu~db": 0.5, "gpu~sec": 0.45, "k8s~gpu2": 0.8, "k8s~ai": 0.7, "k8s~iaas": 0.72, "k8s~db": 0.55, "k8s~sec": 0.5 };
  const score = (a: string, b: string) => table[`${a}~${b}`] ?? null;
  const narrow = coverage(["gpu", "k8s"], ["gpu2"], score)!;
  const broad = coverage(["gpu", "k8s"], ["ai", "iaas", "db", "sec"], score)!;
  assert.ok(narrow.score > 0.84, `narrow ${narrow.score}`);
  assert.ok(broad.score < 0.77 && broad.score < narrow.score - 0.1, `broad ${broad.score}: its database and security tags are not covered`);
  assert.deepEqual([broad.own, broad.peer], ["gpu", "ai"], "the closest pair is kept for display");
  assert.equal(coverage(["gpu"], ["x"], () => null), null);
  // A search cut off at its top-k scores the tags it did not reach at its lowest returned score.
  const units = [unit("A", "total", ["cloud_infrastructure"]), unit("B", "total", ["cloud_infrastructure"])];
  const pairs = pairsFromHits([units[0]!], [units[1]!], [mtag("a1", units[0]!.unitKey, "offering")], [mtag("b1", units[1]!.unitKey, "offering"), mtag("b2", units[1]!.unitKey, "offering")], [{ own: "a1", peer: "b1", score: 0.9 }], { same: 0.77, near: 0.7 }, new Map([["a1", 0.5]]));
  assert.equal(pairs[0]!.sectors.cloud_infrastructure!.offering.score, Math.round(2 * 0.9 * 0.7 / 1.6 * 1000) / 1000);
});

const publication: PeersPublication = {
  schemaVersion: "peers.v1", generatedAt: "2026-10-18T00:00:00.000Z",
  companies: ["CRWV", "NBIS", "ORCL", "MSFT"].map(ticker => ({ ticker, categories: ["cloud_infrastructure"], newestQuarter: "2026-06-30", quarters: [{ periodEnd: "2026-06-30", accessions: [`${ticker}-1`], figures: { capex: "1000000000", revenue: "2000000000" } }] })),
  units: [
    { ticker: "CRWV", unitKey: "CRWV|reported-company-total", name: "Total company", flowNodeId: COMPANY_TOTAL, sectors: ["cloud_infrastructure"], periodEnd: "2026-06-30", revenue: "2575000000", exposure: 1 },
    { ticker: "NBIS", unitKey: "NBIS|Nebius AI cloud", name: "Nebius AI cloud", flowNodeId: "Nebius AI cloud", sectors: ["cloud_infrastructure"], periodEnd: "2026-06-30", revenue: "574900000", exposure: 0.987 },
    { ticker: "ORCL", unitKey: "ORCL|CloudInfrastructure", name: "Cloud infrastructure", flowNodeId: "CloudInfrastructure", sectors: ["cloud_infrastructure"], periodEnd: "2026-08-31", revenue: "7388000000", exposure: 0.382 },
    { ticker: "MSFT", unitKey: "MSFT|msft:IntelligentCloudMember", name: "Intelligent Cloud", flowNodeId: "msft:IntelligentCloudMember", sectors: ["cloud_infrastructure"], periodEnd: "2026-06-30", revenue: "39306000000", exposure: 0.437 },
  ],
  pairs: [
    { left: "CRWV|reported-company-total", right: "NBIS|Nebius AI cloud", tier: "direct", sector: "cloud_infrastructure", basis: "company", facets: { offering: { value: "same", score: 0.9, leftTag: "a", rightTag: "b" }, customers: { value: "same", score: 0.85, leftTag: null, rightTag: null }, contract: { value: "unknown", score: null, leftTag: null, rightTag: null }, cost: { value: "same", score: 0.83, leftTag: null, rightTag: null } } },
    { left: "CRWV|reported-company-total", right: "ORCL|CloudInfrastructure", tier: "partial", sector: "cloud_infrastructure", basis: "unit", facets: { offering: { value: "same", score: 0.82, leftTag: null, rightTag: null }, customers: { value: "partial", score: 0.7, leftTag: null, rightTag: null }, contract: { value: "unknown", score: null, leftTag: null, rightTag: null }, cost: { value: "different", score: 0.5, leftTag: null, rightTag: null } } },
    { left: "CRWV|reported-company-total", right: "MSFT|msft:IntelligentCloudMember", tier: "adjacent", sector: "cloud_infrastructure", basis: "quote", facets: { offering: { value: "partial", score: 0.7, leftTag: null, rightTag: null }, customers: { value: "different", score: 0.4, leftTag: null, rightTag: null }, contract: { value: "unknown", score: null, leftTag: null, rightTag: null }, cost: { value: "unknown", score: null, leftTag: null, rightTag: null } } },
  ],
};

test("readers: pairs order the peers, company-wide tables keep only basis company, and a named partial peer is refused", () => {
  assert.ok(readPeersPublication(publication), "units and pairs read through the contract");
  const comparable = comparablePeers(publication, "CRWV")!;
  assert.deepEqual(comparable.map(c => [c.ticker, c.pair.tier]), [["NBIS", "direct"], ["ORCL", "partial"], ["MSFT", "adjacent"]]);
  assert.deepEqual(comparablePeers(publication, "ORCL")!.map(c => c.ticker), ["CRWV"], "seen from the other side");
  assert.equal(comparablePeers(publication, "AAPL"), null, "a company without pairs falls back");
  const data = { quarters: [], history: null, capital: null, fundamentals: null, guidance: null, peers: publication } as unknown as FindingData;
  assert.deepEqual(peersOf(data, "CRWV"), ["NBIS"]);
  const asked = compileTable({ columns: "peers", span: "quarter", peers: ["NBIS", "ORCL"], rows: [{ ref: { capital: "capex" } }] } as never, data, "CRWV", "2026-06-30");
  assert.ok(asked.errors.some(e => e.startsWith("ORCL is comparable only through Cloud infrastructure (basis unit)")), JSON.stringify(asked));
  assert.ok(asked.dropped.includes("ORCL"));
  const cut = peersFor(publication, new Set(["ORCL"]))!;
  assert.deepEqual(cut.pairs!.map(p => p.right), ["ORCL|CloudInfrastructure"]);
  assert.deepEqual(cut.units!.map(u => u.ticker).sort(), ["CRWV", "ORCL"]);
});

test("the event graph: business links lead to tags, tags to the peers projection, without a loop", () => {
  assert.deepEqual(validateRegistry(), []);
  assert.deepEqual(TASKS["library-links"].emits, ["library.links.published"]);
  assert.deepEqual(SUBSCRIPTIONS["library.links.published"]?.map(s => s.task), ["business-tags"]);
  assert.deepEqual(SUBSCRIPTIONS["business.tags.published"]?.map(s => s.task), ["peers"]);
  assert.equal(TASKS["business-tags"].scope, "data");
});

/** D1 over node:sqlite with every migration applied, reporting changes. */
function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8").replace(/--> statement-breakpoint/g, ""));
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values as never[]).changes) } }),
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values as never[]) as T[] }),
    first: async <T>() => (sqlite.prepare(sql).get(...values as never[]) ?? null) as T | null,
  });
  return { prepare: (sql: string) => statement(sql), batch: async (list: Array<{ run(): Promise<unknown> }>) => { const out = []; for (const s of list) out.push(await s.run()); return out; } } as unknown as D1Database;
}

/** Embeds by vocabulary: each known word is one dimension, so cosine counts shared words. */
const WORDS = ["gpu", "capacity", "leasing", "rental", "ai", "labs", "general", "purpose", "infrastructure", "debt", "fleet", "enterprises"];
const vectorOf = (text: string) => { const words = text.toLowerCase().split(/[^a-z]+/); const v = WORDS.map(w => words.includes(w) ? 1 : 0); const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
function fakeIndex(): TagIndex & { stored: Map<string, { values: number[]; namespace?: string }> } {
  const stored = new Map<string, { values: number[]; namespace?: string }>();
  return {
    stored,
    async upsert(vectors) { for (const v of vectors) stored.set(v.id, { values: v.values, namespace: v.namespace }); return {}; },
    async deleteByIds(ids) { for (const id of ids) stored.delete(id); return {}; },
    async query(vector, options) {
      const matches = [...stored].filter(([, v]) => !options.namespace || v.namespace === options.namespace).map(([id, v]) => ({ id, score: v.values.reduce((s, x, i) => s + x * vector[i]!, 0) }));
      return { matches: matches.sort((a, b) => b.score - a.score).slice(0, options.topK) };
    },
  };
}

test("writing and matching: units and reviewed tags land in D1, vectors per sector and facet, pairs both ways; a rejected tag stays out", async () => {
  const db = database(), index = fakeIndex();
  const env = { DB: db, TAGS_INDEX: index, PEER_TAG_THRESHOLDS: '{"same":0.9,"near":0.6}', AI: { run: async (_m: string, input: { text: string[] }) => ({ data: input.text.map(vectorOf) }) } } as unknown as SecPipelineEnv;
  const at = "2026-10-18T00:00:00.000Z";
  const insertLink = (ticker: string, key: string, name: string, node: string | null, category: string) => db.prepare("INSERT INTO sec_business_links (ticker, business_key, name, flow_node_id, section_ids, industry_category, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'verified', ?)").bind(ticker, key, name, node, '["s1"]', category, at).run();
  await insertLink("CRWV", "CRWV:platform", "CoreWeave Cloud Platform", null, "cloud_infrastructure");
  await insertLink("NBIS", "NBIS:cloud", "Nebius AI cloud", null, "cloud_infrastructure");
  const draft = (ticker: string, label: string, facet: "offering" | "customers" | "cost", definition: string) => {
    const unitKey = `${ticker}|${COMPANY_TOTAL}`;
    return { tagId: tagIdOf(unitKey, "cloud_infrastructure", facet, label), unitKey, sector: "cloud_infrastructure" as const, facet, label, labelZh: label, definition, passageIds: ["p1"] };
  };
  await writeTags(db, "NBIS", {}, [draft("NBIS", "GPU capacity rental", "offering", "GPU capacity rental"), draft("NBIS", "AI labs", "customers", "AI labs")], "fp-n", at);
  await writeTags(db, "CRWV", {}, [draft("CRWV", "GPU capacity leasing", "offering", "GPU capacity leasing"), draft("CRWV", "AI labs", "customers", "AI labs"), draft("CRWV", "debt fleet", "cost", "debt fleet")], "fp-c", at);
  const { syncVectors } = await import("../src/business-tags/match.ts");
  await syncVectors(env, "NBIS", []);
  await syncVectors(env, "CRWV", []);
  assert.equal(index.stored.size, 5);
  assert.ok([...index.stored.values()].every(v => v.namespace?.startsWith("cloud_infrastructure.")));
  const matched = await matchCompany(env, "CRWV", new Date(at));
  assert.equal(matched.pairs, 1);
  const row = await db.prepare("SELECT * FROM sec_peer_pairs").first<{ tier: string; left_ticker: string; sectors: string }>();
  assert.equal(row!.left_ticker, "CRWV");
  const facets = JSON.parse(row!.sectors).cloud_infrastructure;
  assert.equal(facets.customers.value, "same", "identical customer tags");
  assert.equal(facets.offering.value, "partial", "two of three words shared");
  assert.equal(facets.cost.value, "unknown", "NBIS has no cost tag");
  assert.equal(row!.tier, "partial");
  assert.ok(await db.prepare("SELECT 1 FROM pipeline_outbox WHERE type = 'business.tags.published' AND ticker = 'CRWV'").first());
  // An admin rejects CRWV's customer tag: its vector leaves the index and the pair is matched again without it.
  const customers = draft("CRWV", "AI labs", "customers", "AI labs").tagId;
  assert.equal(await setTagStatus(env, "CRWV", customers, "rejected"), true);
  assert.equal(index.stored.has(customers), false);
  assert.equal(JSON.parse((await db.prepare("SELECT sectors FROM sec_peer_pairs").first<{ sectors: string }>())!.sectors).cloud_infrastructure.customers.value, "unknown");
  // A later run that writes the same tag keeps it rejected.
  const again = await writeTags(db, "CRWV", {}, [draft("CRWV", "GPU capacity leasing", "offering", "GPU capacity leasing"), draft("CRWV", "AI labs", "customers", "AI labs")], "fp-c2", at);
  assert.equal((await db.prepare("SELECT status FROM sec_business_tags WHERE tag_id = ?").bind(customers).first<{ status: string }>())!.status, "rejected");
  assert.ok(again.removed.includes(customers) && again.removed.includes(draft("CRWV", "debt fleet", "cost", "debt fleet").tagId), "the rejected tag's and the dropped tag's vectors are to leave the index");
});
