import type { BusinessEvidence, BusinessSource } from "../classification-contract.ts";
import type { MaterialSnapshot } from "../../filing-material/contract.ts";
import { businessSourceKey } from "../classification-runtime.ts";
import { readMaterialSnapshot } from "../../filing-material";
import { materialBlockId, sourceText } from "../../filing-material/read.ts";
import type { AnalysisEnv } from "../../../operations.ts";

export async function readBusinessSources(env: AnalysisEnv, sources: BusinessSource[]): Promise<BusinessEvidence[]> {
  const snapshots = new Map<string, MaterialSnapshot>();
  const evidence: BusinessEvidence[] = [];
  for (const source of new Map(sources.map(source => [businessSourceKey(source), source])).values()) {
    const key = `${source.ref.ticker}:${source.ref.accession}:${source.ref.version}`;
    let snapshot = snapshots.get(key);
    if (!snapshot) { snapshot = await readMaterialSnapshot(env, source.ref); snapshots.set(key, snapshot); }
    const read = await sourceText(env, snapshot, source.sourceId);
    if (!read) throw new Error(`BUSINESS_SOURCE_MISSING:${businessSourceKey(source)}`);
    const block = snapshot.blocks.find(block => block.id === materialBlockId(source.sourceId));
    evidence.push({ id: businessSourceKey(source), source, title: read.title, path: block?.path ?? [], text: read.text, url: read.url });
  }
  return evidence;
}
