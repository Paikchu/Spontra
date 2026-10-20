import { BUSINESS_TAGS_VERSION, buildUnits, PEER_MATCH_VERSION, type TagDraft } from "../../../../shared/analysis-runtime/business-tags.ts";
import { modelFor, reasoningFor } from "../ai-config.ts";
import type { AnalysisEnv } from "../operations.ts";
import { tagsCacheKey, tagsPlan } from "./input.ts";
import { matchCompany, matchingEnabled, syncVectors } from "./match.ts";
import { proposeTags, reviewTags } from "./model.ts";

export type BusinessTagsParams = { ticker: string; fingerprint: string };
type Step = { do<T>(name: string, callback: () => Promise<T>): Promise<T> };

/**
 * Writes the company's units and its reviewed tags. A tag an admin rejected stays rejected when the run writes it
 * again; any other tag of the company this run no longer has is removed. Returns the ids whose vectors must leave the index.
 */
export async function writeTags(db: D1Database, ticker: string, assignments: Record<string, string>, tags: TagDraft[], fingerprint: string, now: string): Promise<{ units: number; tags: number; kept: number; removed: string[] }> {
  const plan = await tagsPlan(db, ticker);
  if (!plan) return { units: 0, tags: 0, kept: 0, removed: [] };
  const { units } = buildUnits(ticker, plan.links, plan.nodes, assignments);
  const existing = new Map((await db.prepare("SELECT tag_id, status FROM sec_business_tags WHERE ticker = ?").bind(ticker).all<{ tag_id: string; status: string }>()).results.map(r => [r.tag_id, r.status]));
  const statements: D1PreparedStatement[] = [db.prepare("DELETE FROM sec_business_units WHERE ticker = ?").bind(ticker)];
  for (const u of units) {
    statements.push(db.prepare("INSERT INTO sec_business_units (unit_key, ticker, flow_node_id, name, link_keys, sectors, section_ids, fingerprint, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(u.unitKey, ticker, u.flowNodeId, u.name, JSON.stringify(u.linkKeys), JSON.stringify(u.sectors), JSON.stringify(u.sectionIds), fingerprint, BUSINESS_TAGS_VERSION, now));
  }
  const unitKeys = new Set(units.map(u => u.unitKey));
  const written = tags.filter(t => unitKeys.has(t.unitKey));
  for (const t of written) {
    statements.push(db.prepare(`INSERT INTO sec_business_tags (tag_id, ticker, unit_key, sector, facet, label, label_zh, definition, passage_ids, status, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tag_id) DO UPDATE SET label_zh = excluded.label_zh, definition = excluded.definition, passage_ids = excluded.passage_ids,
      version = excluded.version, updated_at = excluded.updated_at`)
      .bind(t.tagId, ticker, t.unitKey, t.sector, t.facet, t.label, t.labelZh, t.definition, JSON.stringify(t.passageIds), existing.get(t.tagId) === "rejected" ? "rejected" : "verified", BUSINESS_TAGS_VERSION, now));
  }
  const keep = new Set(written.map(t => t.tagId));
  const stale = [...existing].filter(([id, status]) => !keep.has(id) && status !== "rejected").map(([id]) => id);
  if (stale.length) statements.push(db.prepare("DELETE FROM sec_business_tags WHERE tag_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(stale)));
  statements.push(db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
    .bind(tagsCacheKey(ticker), JSON.stringify({ fingerprint, version: BUSINESS_TAGS_VERSION, matchVersion: PEER_MATCH_VERSION, at: now }), now));
  for (let i = 0; i < statements.length; i += 90) await db.batch(statements.slice(i, i + 90));
  return { units: units.length, tags: written.length, kept: written.filter(t => existing.get(t.tagId) !== "rejected").length, removed: [...stale, ...written.filter(t => existing.get(t.tagId) === "rejected").map(t => t.tagId)] };
}

/** Propose, review, write, index, match: each a durable step, so a replay calls no model again. */
export async function executeBusinessTagsWorkflow(params: BusinessTagsParams, step: Step, env: AnalysisEnv): Promise<Record<string, unknown>> {
  const now = await step.do("tags-time", async () => new Date().toISOString());
  const plan = await step.do("tags-plan", () => tagsPlan(env.DB!, params.ticker));
  if (!plan || plan.fingerprint !== params.fingerprint) return { status: "superseded" };
  const proposal = await step.do("tags-propose", () => proposeTags(env, plan));
  const supported = new Set(await step.do("tags-review", () => reviewTags(env, params.ticker, proposal.tags)));
  const reviewed = proposal.tags.filter(t => supported.has(t.tagId));
  const written = await step.do("tags-write", () => writeTags(env.DB!, params.ticker, proposal.assignments, reviewed, plan.fingerprint, now));
  const vectors = matchingEnabled(env) ? await step.do("tags-vectors", () => syncVectors(env, params.ticker, written.removed)) : null;
  const matched = await step.do("tags-match", () => matchCompany(env, params.ticker, new Date(now)));
  const summary = { status: "ready", ...written, removed: written.removed.length, proposed: proposal.tags.length, reviewedOut: proposal.tags.length - reviewed.length, vectors, matched, notes: proposal.notes.slice(0, 30),
    model: `${modelFor(env, "business-tags")} · ${reasoningFor(env, "business-tags")} + review ${modelFor(env, "business-tags-review")} · ${reasoningFor(env, "business-tags-review")}` };
  console.log(JSON.stringify({ event: "business-tags", ticker: params.ticker, ...summary }));
  return summary;
}
