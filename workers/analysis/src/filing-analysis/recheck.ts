import { checkBlock, figureInText, quoteInText } from "../../../../shared/analysis-runtime/artifact/html.ts";
import { readPublishedDocument, readWorkState, recordCheck, type ArtifactStoreEnv } from "../artifact/store.ts";
import { readFilingReadme } from "../filing-library/readme.ts";
import { librarySectionPassages } from "../filing-library/store.ts";
import { evaluate, factsById, factSourceText } from "./facts.ts";
import type { FilingWork } from "./recipe.ts";
import { sectionDocuments } from "./store.ts";

export type RecheckItem = { block: string; kind: "figure" | "quote"; ref: string; shown: string; status: "holds" | "differs" | "unreadable"; reason?: string };
export type RecheckResult = { version: number; checked: number; holds: number; differs: number; unreadable: number; items: RecheckItem[] };

/**
 * Reads a published filing report against its sources again, by code alone (docs/filing-analysis-optimization.md §4.6):
 * every figure and quotation is looked up where the report says it is from — a fact row, a paragraph, a section, a
 * figure computed from facts, a text the session read — as the library holds it now. A parser that changed what a
 * source says shows up here as a figure that differs; no model is called.
 */
export async function recheckFiling(env: ArtifactStoreEnv, ticker: string, accession: string): Promise<RecheckResult | null> {
  const db = env.DB!;
  const document = await readPublishedDocument(env, "filing-report", ticker, accession);
  if (!document) return null;
  const work = await readWorkState<FilingWork>(env, "filing-report", ticker, accession);
  const known = new Map(document.sources.map(s => [s.id, s]));
  const texts = new Map<string, { text: string; exact?: number } | null>();
  const sectionText = async (sectionId: string, ordinal?: number) => {
    const [pair] = await sectionDocuments(db, [sectionId]);
    if (!pair) return null;
    const passages = await librarySectionPassages(db, pair[1], [sectionId]);
    const kept = ordinal === undefined ? passages : passages.filter(p => p.ordinal === ordinal);
    return kept.length ? kept.map(p => p.text).join("\n\n") : null;
  };
  const read = async (id: string): Promise<{ text: string; exact?: number } | null> => {
    if (texts.has(id)) return texts.get(id)!;
    let found: { text: string; exact?: number } | null = null;
    const computed = work?.periodic?.computed?.[id];
    if (computed) {
      // A computed figure is worked out again from what its facts hold now.
      const names = Object.keys(computed.inputs);
      const facts = new Map((await factsById(db, names.filter(n => /^f[0-9a-f]{14}$/.test(n)))).map(f => [f.factId, f.value]));
      const inputs = Object.fromEntries(names.map(n => [n, facts.get(n) ?? computed.inputs[n]!]));
      try { const value = evaluate(computed.formula, inputs); found = { text: `${computed.label}: ${value} ${computed.unit}`, exact: value }; } catch { found = null; }
    } else if (/^f[0-9a-f]{14}$/.test(id)) {
      const [fact] = await factsById(db, [id]);
      found = fact ? { text: factSourceText(fact), exact: fact.value } : null;
    } else if (work?.periodic?.texts?.[id] !== undefined && !/#\d+$/.test(id)) found = { text: work.periodic.texts[id]! };
    else if (work?.data?.[id] !== undefined) found = { text: work.data[id]! };
    else if (work?.web?.[id] !== undefined) found = { text: work.web[id]! };
    else if (id === "readme" || id.startsWith("readme:")) {
      const target = id === "readme" ? accession : id.slice("readme:".length);
      const readme = /^\d{10}-\d{2}-\d{6}$/.test(target) ? await readFilingReadme(env, ticker, target) : null;
      found = readme ? { text: readme.markdown } : null;
    } else {
      const part = /^(.+)#(\d+)$/.exec(id);
      const text = part ? await sectionText(part[1]!, Number(part[2])) : await sectionText(id);
      found = text === null ? null : { text };
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
