import { checkBlock, figureInText, quoteInText } from "../../../../shared/analysis-runtime/artifact/html.ts";
import { readPublishedDocument, readWorkState, recordCheck } from "../artifact/store.ts";
import { readMaterialSnapshot } from "../filing-material/index.ts";
import { sourceText } from "../filing-material/read.ts";
import type { AnalysisEnv } from "../operations.ts";
import { evaluate, namesIn } from "./facts.ts";
import type { FilingWork } from "./recipe.ts";

export type RecheckItem = { block: string; kind: "figure" | "quote"; ref: string; shown: string; status: "holds" | "differs" | "unreadable"; reason?: string };
export type RecheckResult = { version: number; checked: number; holds: number; differs: number; unreadable: number; items: RecheckItem[] };

export async function recheckFiling(env: AnalysisEnv, ticker: string, accession: string): Promise<RecheckResult | null> {
  const document = await readPublishedDocument(env, "filing-report", ticker, accession);
  if (!document) return null;
  const work = await readWorkState<FilingWork>(env, "filing-report", ticker, accession);
  const known = new Map(document.sources.map(s => [s.id, s]));
  const texts = new Map<string, { text: string; exact?: number } | null>();
  const refs = [work?.material, ...(work?.periodic?.materials ?? [])].filter((ref): ref is NonNullable<typeof ref> => !!ref);
  const snapshots = await Promise.all([...new Map(refs.map(ref => [`${ref.accession}:${ref.version}`, ref])).values()].map(ref => readMaterialSnapshot(env, ref)));
  const facts = new Map(snapshots.flatMap(material => material.facts.map(f => [f.factId, f.value] as const)));
  const recompute = (id: string, seen = new Set<string>()): number | undefined => {
    if (facts.has(id)) return facts.get(id);
    if (seen.has(id)) return undefined;
    const computed = work?.periodic?.computed[id];
    if (!computed) return undefined;
    const inputs: Record<string, number> = {};
    for (const name of namesIn(computed.formula)) { const value = recompute(name, new Set([...seen, id])); if (value === undefined) return undefined; inputs[name] = value; }
    return evaluate(computed.formula, inputs);
  };
  const read = async (id: string): Promise<{ text: string; exact?: number } | null> => {
    if (texts.has(id)) return texts.get(id)!;
    let found: { text: string; exact?: number } | null = null;
    const computed = work?.periodic?.computed?.[id];
    if (computed) {
      const value = recompute(id);
      found = value === undefined ? null : { text: `${computed.label}: ${value} ${computed.unit}`, exact: value };
    } else {
      let source: Awaited<ReturnType<typeof sourceText>> = null;
      for (const material of snapshots) { source = await sourceText(env, material, id); if (source) break; }
      if (source) found = { text: source.text, ...(source.exact === undefined ? {} : { exact: source.exact }) };
      else if (work?.periodic?.texts?.[id] !== undefined) found = { text: work.periodic.texts[id]! };
      else if (work?.web?.[id] !== undefined) found = { text: work.web[id]! };
    }
    texts.set(id, found);
    return found;
  };
  const items: RecheckItem[] = [];
  for (const block of document.blocks) {
    const check = checkBlock(block.html, { sourceUrl: ref => known.has(ref) ? known.get(ref)!.url : undefined, charts: new Set(document.charts.map(c => c.id)) });
    for (const claim of check.claims) {
      const ref = claim.kind === "figure" ? claim.ref : claim.source;
      const shown = claim.kind === "figure" ? claim.shown || String(claim.value) : claim.text.slice(0, 160);
      const source = await read(ref).catch(() => null);
      if (!source) { items.push({ block: block.id, kind: claim.kind, ref, shown, status: "unreadable", reason: "the source cannot be read back" }); continue; }
      const holds = claim.kind === "quote" ? quoteInText(claim.text, source.text) : figureInText(claim.value, source.exact !== undefined ? String(source.exact) : source.text);
      items.push({ block: block.id, kind: claim.kind, ref, shown, status: holds ? "holds" : "differs", ...(holds ? {} : { reason: claim.kind === "quote" ? "the words are not in the source" : `the source now reads ${source.exact !== undefined ? source.exact : "no such number"}` }) });
    }
  }
  const count = (status: RecheckItem["status"]) => items.filter(i => i.status === status).length;
  const result: RecheckResult = { version: document.version, checked: items.length, holds: count("holds"), differs: count("differs"), unreadable: count("unreadable"), items };
  await recordCheck(env, "filing-report", ticker, accession, document.version, "recheck", 0, { ...result, items: items.filter(i => i.status !== "holds") });
  return result;
}
