import type { FilingImpactPublication } from "./filing-impact-contract.ts";
import { impactUnitIssue } from "../valuation/price-impact-runtime.ts";
import type { ArtifactStoreEnv, StoredArtifact } from "../publishing/artifact/store.ts";
import type { FilingSpec, FilingWork } from "./recipe.ts";
import type { MaterialSnapshot } from "../filing-material/contract.ts";
import type { FilingFactRow } from "./filing-content-contract.ts";
import { materialSnapshotKey } from "../filing-material/store.ts";
import { sha256 } from "../../lib/sha256.ts";
import { frozenPublicResearchSource, isPublicResearchSourceId } from "../public-research/company/context-tools.ts";

const pointerKey = (id: string, version: number, hash: string) => `filing-impact:${id}:v${version}:${hash}`;
type Pointer = { resultId: string; key: string };
const content = (publication: FilingImpactPublication) => JSON.stringify(publication, (key, value) => key === "resultId" ? undefined : value);

/** Only the actual successfully validated work supplied by the producer is eligible; never reads mutable work.json. */
export async function saveFilingImpact(env: ArtifactStoreEnv, input: { spec: FilingSpec; version: number; hash: string; work: FilingWork }): Promise<FilingImpactPublication | null> {
  const { spec, version, hash, work } = input;
  const p = work.periodic;
  if (!p?.investmentChains?.length) return null;
  const receipt = p.semanticAuditReceipt;
  if (!receipt?.complete || receipt.verdict !== "pass" || !receipt.digest || !receipt.key) throw new Error("A complete passing semantic receipt is required for filing impact publication");
  if (work.material.ticker !== spec.ticker || work.material.accession !== spec.filing.accessionNumber || work.material.version !== spec.material.version) throw new Error("Filing impact material mismatch");
  const id = `filing-report:${spec.ticker}:${spec.filing.accessionNumber}`;
  const row = await env.DB!.prepare("SELECT r2_key, created_at FROM analysis_artifact_versions WHERE artifact_id = ? AND version = ? AND hash = ?").bind(id, version, hash).first<{ r2_key: string; created_at: string }>();
  const object = row ? await env.SEC_FILINGS.get(row.r2_key) : null;
  if (!object) throw new Error("Filing impact source edition is unavailable");
  const stored = JSON.parse(await object.text()) as StoredArtifact;
  const doc = stored.document;
  if (doc.kind !== "filing-report" || doc.ticker !== spec.ticker || doc.subject !== spec.filing.accessionNumber || doc.version !== version || stored.hash !== hash || await sha256(`${stored.html}\n${stored.css}`) !== hash) throw new Error("Filing impact source edition mismatch");
  const refs = new Set(p.investmentChains.flatMap(chain => [...chain.sourceIds, ...chain.computationRefs]));
  const visit = (ref: string) => {
    const inputs = [...Object.keys(p.computed[ref]?.inputs ?? {}), ...(p.impactComputations?.[ref]?.provenance?.inputs ?? []).map(input => input.sourceId)];
    for (const input of inputs) if (!refs.has(input)) { refs.add(input); visit(input); }
  };
  for (const ref of refs) visit(ref);
  const unitIssue = impactUnitIssue(p.impactComputations, refs);
  if (unitIssue) throw new Error(unitIssue);
  const calculations = Object.fromEntries([...refs].filter(ref => p.impactComputations?.[ref]).map(ref => [ref, p.impactComputations![ref]!]));
  const arithmetic = Object.fromEntries([...refs].filter(ref => p.computed[ref]).map(ref => [ref, p.computed[ref]!]));
  const material = { ticker: work.material.ticker, accession: work.material.accession, version: work.material.version };
  const sourceMaterials = [...new Map([work.material, ...p.materials].map(ref => [`${ref.ticker}:${ref.accession}:${ref.version}`, { ticker: ref.ticker, accession: ref.accession, version: ref.version }])).values()];
  const frozenFacts = new Map<string, FilingFactRow & { sourceUrl: string | null }>();
  for (const ref of sourceMaterials) {
    const object = await env.SEC_FILINGS.get(materialSnapshotKey(ref));
    if (!object) throw new Error("Filing impact frozen material is unavailable");
    const snapshot = JSON.parse(await object.text()) as MaterialSnapshot;
    if (snapshot.ref.ticker !== ref.ticker || snapshot.ref.accession !== ref.accession || snapshot.ref.version !== ref.version) throw new Error("Filing impact frozen material identity mismatch");
    for (const fact of snapshot.facts) if (refs.has(fact.factId)) frozenFacts.set(fact.factId, { ...fact, sourceUrl: snapshot.blocks.find(block => block.id === fact.passageId)?.sourceUrl ?? snapshot.filing.documentUrl });
  }
  const sources = [...refs].map(ref => {
    const source = doc.sources.find(source => source.id === ref);
    const fact = p.facts[ref], original = frozenFacts.get(ref);
    const publicSource = isPublicResearchSourceId(ref) ? frozenPublicResearchSource(spec.publicResearch, ref, { source, researchContext: doc.researchContext }) : null;
    if (isPublicResearchSourceId(ref) && !publicSource) throw new Error(`Filing impact public source ${ref} does not match its frozen research ordinal and version`);
    return { id: ref, title: source?.title ?? original?.label ?? p.computed[ref]?.label ?? ref, url: source?.url ?? original?.sourceUrl ?? null, kind: source?.kind ?? "data" as const, text: publicSource?.text ?? p.texts[ref] ?? fact?.text ?? work.web[ref] ?? "", ...(original ? { value: original.value, unit: original.unit, shown: original.shown, periodStart: original.periodStart, periodEnd: original.periodEnd } : fact ? { value: fact.value, ...(fact.unit ? { unit: fact.unit } : {}) } : {}) };
  });
  const body: Omit<FilingImpactPublication, "resultId"> = {
    schemaVersion: "filing-impact.v1", artifact: { id, ticker: spec.ticker, accession: spec.filing.accessionNumber, version, hash },
    title: doc.blocks.find(block => block.id === "summary")?.title ?? doc.title, financialPeriodEnd: spec.filing.reportDate,
    sourcePublishedAt: spec.filing.filingDate, researchAsOf: spec.publicResearch?.asOf ?? row!.created_at, generatedAt: row!.created_at,
    inputFingerprint: await sha256(JSON.stringify({ material, sourceMaterials, researchContext: doc.researchContext ?? null, chains: p.investmentChains, calculations, arithmetic, sources, semanticDigest: receipt.digest })),
    material, sourceMaterials, validation: { kind: "technical", semanticDigest: receipt.digest, semanticReceipt: receipt.key },
    chains: p.investmentChains, calculations, arithmetic, sources,
    priceEffect: { quantificationStatus: "not_quantifiable", eventChange: null, referenceQuote: null, modelVersion: null,
      missingInputs: ["Matched before/after valuation models for this exact filing edition with controlled assumptions and attribution evidence", "Period-matched tax treatment, economic share count and valuation model linking the financial bridge to per-share value", "A frozen same-currency report reference price and quote date for any price comparison"] },
  };
  const resultId = `filing-impact:${await sha256(JSON.stringify(body))}`;
  const publication: FilingImpactPublication = { ...body, resultId };
  const key = `filing-impacts/${spec.ticker}/${spec.filing.accessionNumber}/v${version}/${resultId.slice("filing-impact:".length)}.json`;
  await env.SEC_FILINGS.put(key, JSON.stringify(publication), { httpMetadata: { contentType: "application/json" } });
  // The pointer is insert-only. Concurrent or repeated work can never replace an edition's frozen result.
  await env.DB!.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO NOTHING").bind(pointerKey(id, version, hash), JSON.stringify({ resultId, key } satisfies Pointer), row!.created_at).run();
  const saved = await readFilingImpact(env, id, version, hash);
  if (!saved || saved.resultId !== resultId) throw new Error("This filing edition already has a different immutable impact result");
  return saved;
}

/** Called only through an already-authorized artifact read; this does not grant draft access. */
export async function readFilingImpact(env: ArtifactStoreEnv, id: string, version: number, hash: string): Promise<FilingImpactPublication | null> {
  const row = await env.DB!.prepare("SELECT payload FROM sec_cache WHERE cache_key = ?").bind(pointerKey(id, version, hash)).first<{ payload: string }>();
  if (!row) return null;
  const pointer = JSON.parse(row.payload) as Pointer;
  const object = await env.SEC_FILINGS.get(pointer.key);
  if (!object) return null;
  const value = JSON.parse(await object.text()) as FilingImpactPublication;
  if (value.schemaVersion !== "filing-impact.v1" || value.artifact.id !== id || value.artifact.version !== version || value.artifact.hash !== hash || value.resultId !== pointer.resultId || `filing-impact:${await sha256(content(value))}` !== value.resultId) return null;
  return value;
}
