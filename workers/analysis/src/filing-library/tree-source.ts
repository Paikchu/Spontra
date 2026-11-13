import { compactName } from "../../../../shared/analysis-runtime/business-tree.ts";
import type { MaterialRef, MaterialSnapshot, MaterialState } from "../../../../shared/analysis-contract/filing-material.ts";
import type { TreeFiling, TreeLibrary } from "../business-tree/agent.ts";
import { getFilingMaterial, listFilingMaterials, readMaterialSnapshot, requestFilingMaterial } from "../filing-material/index.ts";
import { filingMaterialMeta, readFilingMarkdown, searchFilingMarkdown } from "../filing-material/read.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { createAnalysisOperations, type AnalysisEnv } from "../operations.ts";

export function treeLibrary(env: AnalysisEnv, ticker: string, flowFilings: TreeFiling[], options: { headings?: boolean; pinKey?: string } = {}): TreeLibrary {
  const snapshots = new Map<string, MaterialSnapshot>();
  const load = async (state: MaterialState): Promise<MaterialSnapshot> => {
    if (state.status !== "ready") throw new Error(`FILING_MATERIAL_PENDING: ${state.filing.accession}`);
    const key = state.filing.documentUrl;
    const held = snapshots.get(key);
    if (held) return held;
    let ref = state.ref;
    if (options.pinKey) {
      const pinKey = `reader-pin:material:${ticker}:${options.pinKey}:${state.filing.accession}`;
      await env.DB!.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO NOTHING")
        .bind(pinKey, JSON.stringify(ref), new Date().toISOString()).run();
      const saved = await new D1SecRepository(env.DB!).getCache<MaterialRef>(pinKey);
      if (!saved) throw new Error(`MATERIAL_PIN_MISSING: ${state.filing.accession}`);
      ref = saved.payload;
    }
    const material = await readMaterialSnapshot(env, ref);
    snapshots.set(key, material);
    return material;
  };
  const ready = async (url: string) => {
    const held = snapshots.get(url);
    if (held) return held;
    const compact = /\/(\d{18})\//.exec(url)?.[1];
    if (!compact) return null;
    const accession = `${compact.slice(0, 10)}-${compact.slice(10, 12)}-${compact.slice(12)}`;
    const state = await getFilingMaterial(env, ticker, accession);
    if (state) return load(state);
    const filing = await createAnalysisOperations(env, fetch).loadFiling?.(ticker, accession);
    if (!filing) return null;
    await requestFilingMaterial(env, filingMaterialMeta(filing));
    throw new Error(`FILING_MATERIAL_PENDING: ${accession}`);
  };
  const annual = async () => {
    const found = (await listFilingMaterials(env, ticker)).filter(m => /^(?:10-K|20-F)(?:\/A)?$/.test(m.filing.form))
      .sort((a, b) => b.filing.filedAt.localeCompare(a.filing.filedAt))[0];
    if (found) return load(found);
    const discovered = await createAnalysisOperations(env, fetch).discover(ticker);
    const filing = discovered.filings.find(f => /^(?:10-K|20-F)$/.test(f.form));
    if (!filing) return null;
    await requestFilingMaterial(env, filingMaterialMeta(filing));
    throw new Error(`FILING_MATERIAL_PENDING: ${filing.accessionNumber}`);
  };
  const read = async (material: MaterialSnapshot, terms: string[], maxChars: number) => {
    const words = terms.map(word => word.toLowerCase());
    let anchor: string | undefined;
    for (const word of words) {
      const found = await searchFilingMarkdown(env, material, { query: word, limit: 1 });
      if (found.matches[0]) { anchor = found.matches[0].anchor; break; }
    }
    const page = await readFilingMarkdown(env, material, { ...(anchor ? { anchor } : {}), maxChars: Math.max(1000, maxChars) });
    return `${page.text}\n\nMaterial ${material.ref.accession} version ${material.ref.version}. ${page.nextCursor ? `More content remains at cursor ${page.nextCursor}; narrow the terms to read other parts.` : "End of material."}`;
  };
  return {
    async documents() {
      const latest = await annual();
      const materials = latest ? [latest] : [];
      for (const filing of flowFilings) { const material = await ready(filing.url); if (material && !materials.some(m => m.ref.accession === material.ref.accession)) materials.push(material); }
      return materials.map(material => ({ url: material.filing.documentUrl, title: `${material.filing.form} filed ${material.filing.filedAt}`, publishedAt: `${material.filing.filedAt.slice(0, 10)}T00:00:00.000Z` }));
    },
    async read(url, terms, maxChars) { const material = await ready(url); return material ? read(material, terms, maxChars) : null; },
    async businessSection(names, maxChars) {
      const material = await annual();
      if (!material) return null;
      const wanted = names.map(compactName).filter(name => name.length >= 3);
      const selected = material.blocks.find(b => wanted.some(name => compactName(b.path.join(" ")).includes(name)));
      return { url: material.filing.documentUrl, title: `${material.filing.form} annual report filed ${material.filing.filedAt}`,
        text: await read(material, selected ? [selected.title] : names, maxChars) };
    },
  };
}
