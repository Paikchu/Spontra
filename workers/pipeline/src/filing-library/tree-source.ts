import { compactName } from "../../../../shared/analysis-runtime/business-tree.ts";
import type { TreeFiling, TreeLibrary } from "../business-tree/agent.ts";
import { rankPassages } from "./tool.ts";
import { libraryOutline, librarySectionPassages } from "./store.ts";

const documentIdOf = async (url: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)))].map(n => n.toString(16).padStart(2, "0")).join("");

/** The business tree's view of the filing library: its filings, verbatim reads of them, and each business's own section of the annual report. */
export function treeLibrary(db: D1Database, ticker: string, flowFilings: TreeFiling[]): TreeLibrary {
  const annual = async () => db.prepare(`SELECT document_id, document_url, form, filed_at FROM sec_documents WHERE ticker = ? AND status = 'ready' AND doc_type = 'primary'
    AND form IN ('10-K', '20-F') ORDER BY filed_at DESC LIMIT 1`).bind(ticker).first<{ document_id: string; document_url: string; form: string; filed_at: string }>();
  const ready = async (url: string) => {
    const id = await documentIdOf(url);
    return (await db.prepare("SELECT document_id FROM sec_documents WHERE document_id = ? AND ticker = ? AND status = 'ready'").bind(id, ticker).first<{ document_id: string }>())?.document_id ?? null;
  };
  const annualTitle = (form: string, filed: string) => `Form ${form} annual report (filed ${filed})`;
  return {
    async documents() {
      const latest = await annual();
      const flow = [];
      for (const f of flowFilings) if (await ready(f.url)) flow.push({ url: f.url, title: f.title, publishedAt: f.publishedAt });
      return [...(latest ? [{ url: latest.document_url, title: annualTitle(latest.form, latest.filed_at), publishedAt: latest.filed_at ? `${latest.filed_at}T00:00:00.000Z` : null }] : []),
        ...flow.filter(f => f.url !== latest?.document_url).slice(0, 2)];
    },
    async read(url, terms, maxChars) {
      const id = await ready(url);
      if (!id) return null;
      const outline = await libraryOutline(db, id);
      const passages = await librarySectionPassages(db, id, outline.filter(s => s.role !== "boilerplate").map(s => s.sectionId));
      return rankPassages(passages, terms, maxChars).map(p => p.text).join("\n\n");
    },
    async businessSection(names, maxChars) {
      const latest = await annual();
      if (!latest) return null;
      const outline = (await libraryOutline(db, latest.document_id)).filter(s => s.canonical === "business");
      if (!outline.length) return null;
      const wanted = names.map(compactName).filter(n => n.length >= 3);
      // The business's own heading, the deepest one that names it; otherwise the business item ranked by the business's names.
      const match = outline.filter(s => wanted.some(n => compactName(s.title).includes(n))).sort((a, b) => a.depth - b.depth)[0];
      const scope = match ? outline.filter(s => JSON.stringify(s.path).startsWith(JSON.stringify(match.path).slice(0, -1))) : outline;
      const passages = await librarySectionPassages(db, latest.document_id, scope.map(s => s.sectionId));
      const kept = match && passages.reduce((n, p) => n + p.text.length, 0) <= maxChars ? passages : rankPassages(passages, names, maxChars);
      if (!kept.length) return null;
      return { url: latest.document_url, title: annualTitle(latest.form, latest.filed_at), text: kept.map(p => p.text).join("\n\n") };
    },
  };
}
