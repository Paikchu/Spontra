import { z } from "zod";
import type { CompanyResearchExposure, SourceSnapshot } from "../../../../shared/analysis-contract/public-research.ts";
import type { MaterialSnapshot } from "../../../../shared/analysis-contract/filing-material.ts";
import { INDUSTRY_CATEGORIES } from "../../../../shared/analysis-contract/business-classification.ts";
import { TAG_FACETS } from "../../../../shared/analysis-contract/business-tags.ts";
import { businessSourceKey } from "../../../../shared/analysis-runtime/business-classification.ts";
import { csvFromTable } from "../../../../shared/analysis-runtime/filing-material.ts";
import { sourceSnapshotSchema } from "../../../../shared/analysis-runtime/public-research-schema.ts";
import { materialDigest, readMaterialSnapshot } from "../filing-material/store.ts";
import { materialBlockId, sourceText } from "../filing-material/read.ts";
import { sha256 } from "../sha256.ts";
import type { PublicResearchEnv } from "./store.ts";

const referenceSchema = z.object({ ref: z.object({ ticker: z.string().min(1), accession: z.string().regex(/^\d{10}-\d{2}-\d{6}$/), version: z.string().min(1) }), sourceId: z.string().min(1) });
type TagRow = { tag_id: string; ticker: string; unit_key: string; sector: string; facet: string; label: string; label_zh: string; definition: string; sources: string; status: string; version: string };
export const stableResearchValue = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

/** Financial exposure and report routing stay independent of a tag's classification and evidence. */
export function exposureBusinessMeaning(exposure: CompanyResearchExposure): string {
  const { companyId, segmentId, industryId, relation, weight, weightBasis, validUntil } = exposure;
  return stableResearchValue({ companyId, segmentId, industryId, relation, weight, weightBasis, validUntil, regions: [...exposure.regions].sort() });
}

/** Read the existing authoritative tag and immutable prepared originals. Never prepare materials or call a model. */
export async function projectVerifiedBusinessTag(env: PublicResearchEnv, ticker: string, tagId: string) {
  if (!env.DB) throw new Error("Public research storage unavailable");
  const row = await env.DB.prepare("SELECT * FROM sec_business_tags WHERE tag_id=? AND ticker=?").bind(tagId, ticker).first<TagRow>();
  if (!row || row.status !== "verified") throw new Error("Business tag is missing or no longer verified");
  if (!Object.hasOwn(INDUSTRY_CATEGORIES, row.sector) || !(TAG_FACETS as readonly string[]).includes(row.facet) || !row.unit_key.startsWith(`${ticker}|`)) throw new Error("Business tag classification identity mismatch");
  const refs = z.array(referenceSchema).min(1).parse(JSON.parse(row.sources));
  if (refs.some(source => source.ref.ticker !== ticker) || new Set(refs.map(businessSourceKey)).size !== refs.length) throw new Error("Business tag source company or identity mismatch");
  const snapshots = new Map<string, MaterialSnapshot>(), checked = new Set<string>();
  // Older text-only store adapters remain supported for inline evidence; real R2 preserves binary byte ranges.
  const readEnv = { SEC_FILINGS: { get: async (key: string, options?: { range?: { offset: number; length: number } }) => {
    const object = await env.SEC_FILINGS.get(key, options);
    return object ? { text: () => object.text(), arrayBuffer: async () => {
      if (!object.arrayBuffer) throw new Error("Material byte-range storage unavailable");
      return object.arrayBuffer();
    } } : null;
  } } };
  const sources: SourceSnapshot[] = [], bindings: NonNullable<CompanyResearchExposure["tagBinding"]>["sources"] = [];
  for (const ref of refs) {
    const materialKey = stableResearchValue(ref.ref);
    let snapshot = snapshots.get(materialKey);
    if (!snapshot) { snapshot = await readMaterialSnapshot(env, ref.ref); snapshots.set(materialKey, snapshot); }
    if (snapshot.filing.ticker !== ticker || snapshot.filing.accession !== ref.ref.accession) throw new Error("Business tag material filing identity mismatch");
    const fact = snapshot.facts.find(item => item.factId === ref.sourceId);
    const block = snapshot.blocks.find(item => item.id === (fact?.passageId ?? materialBlockId(ref.sourceId)));
    const tableId = /^(.+)#(?:rows:|cell:)/.exec(ref.sourceId)?.[1] ?? ref.sourceId;
    const table = snapshot.tables.find(item => item.tableId === tableId);
    if (block && !checked.has(`${materialKey}:${block.id}`)) {
      if (block.range) {
        const object = block.storage === "markdown" ? await readEnv.SEC_FILINGS.get(snapshot.markdown.key, { range: { offset: block.range.offset, length: block.range.length } }) : null;
        const bytes = block.storage === "inline" ? new TextEncoder().encode(block.text) : object ? new Uint8Array(await object.arrayBuffer()) : null;
        if (!bytes || bytes.byteLength !== block.range.length || await materialDigest(bytes) !== block.range.sha256) throw new Error("Business tag original passage hash mismatch");
      }
      checked.add(`${materialKey}:${block.id}`);
    }
    if (table && !checked.has(`${materialKey}:${table.tableId}`)) {
      const original = await env.SEC_FILINGS.get(table.csvKey);
      if (!original || await original.text() !== table.csv || await sha256(table.csv) !== table.sha256 || csvFromTable(table.table) !== table.csv) throw new Error("Business tag original table hash mismatch");
      checked.add(`${materialKey}:${table.tableId}`);
    }
    const read = await sourceText(readEnv, snapshot, ref.sourceId);
    if (!read || !block && !table) throw new Error("Business tag original source unavailable");
    const excerpt = read.text.trim(), contentHash = await sha256(excerpt), filedAt = new Date(`${snapshot.filing.filedAt.slice(0, 10)}T00:00:00.000Z`).toISOString();
    const source = sourceSnapshotSchema.parse({ id: `tag-source-${(await sha256(businessSourceKey(ref))).slice(0, 24)}`, canonicalId: `${ticker}:${ref.ref.accession}`, uri: read.url,
      title: read.title, locator: ref.sourceId, excerpt, contentHash, revision: ref.ref.version, publishedAt: filedAt, availableAt: filedAt, collectedAt: snapshot.createdAt,
      observationPeriod: { start: snapshot.filing.reportDate || snapshot.filing.filedAt.slice(0, 10), end: snapshot.filing.reportDate || snapshot.filing.filedAt.slice(0, 10) }, usage: "public", authorization: "Public SEC filing; existing verified business tag" });
    if ([source.publishedAt, source.collectedAt].some(time => Date.parse(time) > Date.now())) throw new Error("Business tag source time is in the future");
    sources.push(source); bindings.push({ ref: ref.ref, sourceId: ref.sourceId, contentHash });
  }
  const fingerprint = await sha256(stableResearchValue({ tagId, ticker, unitKey: row.unit_key, sector: row.sector, facet: row.facet, label: row.label, definition: row.definition,
    sources: [...bindings].sort((a, b) => businessSourceKey(a).localeCompare(businessSourceKey(b))) }));
  return { tagId, unitKey: row.unit_key, sector: row.sector, facet: row.facet, label: row.label, labelZh: row.label_zh, definition: row.definition, algorithmVersion: row.version, fingerprint, sources, bindings };
}

/** A source-only attachment is compatible with its old frozen relation; the tag remains authoritative for that family. */
export async function resolveCompanyExposure(env: PublicResearchEnv, exposure: CompanyResearchExposure, family: CompanyResearchExposure[], at: string,
  projections = new Map<string, ReturnType<typeof projectVerifiedBusinessTag>>()) {
  const invalid = (reason: string) => ({ status: "review_required" as const, reason, exposure: null });
  if (exposure.status !== "verified" || exposure.validUntil && exposure.validUntil <= at || exposure.validFrom > at) return invalid("exposure_not_currently_verified");
  const latest = family.find(item => item.validFrom <= at);
  if (!latest || latest.status !== "verified" || latest.validUntil && latest.validUntil <= at || exposureBusinessMeaning(latest) !== exposureBusinessMeaning(exposure)) return invalid("business_exposure_changed");
  // A historical/legacy pin cannot bypass a tag rejection just by predating its source-only attachment.
  const bound = family.find(item => item.tagBinding && Date.parse(item.validFrom) <= Date.now());
  if (!bound?.tagBinding) return { status: "valid" as const, exposure };
  const binding = bound.tagBinding, key = `${exposure.companyId}:${binding.tagId}`;
  if (!projections.has(key)) projections.set(key, projectVerifiedBusinessTag(env, exposure.companyId, binding.tagId));
  try {
    const tag = await projections.get(key)!;
    if (tag.fingerprint !== binding.fingerprint || stableResearchValue([...tag.bindings].sort((a, b) => businessSourceKey(a).localeCompare(businessSourceKey(b)))) !== stableResearchValue([...binding.sources].sort((a, b) => businessSourceKey(a).localeCompare(businessSourceKey(b))))) return invalid("business_tag_semantics_or_evidence_changed");
    const pinnedBinding=exposure.tagBinding??family.find(item=>item.tagBinding?.baseVersion===exposure.version)?.tagBinding??family.filter(item=>item.tagBinding).at(-1)?.tagBinding;
    if (pinnedBinding && pinnedBinding.fingerprint !== tag.fingerprint) return invalid("frozen_business_tag_changed");
    if(tag.sources.some(source=>source.availableAt>at))return invalid("business_tag_source_after_cutoff");
    const {tagId,unitKey,sector,facet,label,labelZh,definition,algorithmVersion,fingerprint,sources}=tag;
    return { status: "valid" as const, exposure: { ...exposure, source: tag.sources[0]!, status: "verified" as const, businessTag: {tagId,unitKey,sector,facet,label,labelZh,definition,algorithmVersion,fingerprint,sources} } };
  } catch (error) { return invalid(error instanceof Error ? error.message : "business_tag_unavailable"); }
}
