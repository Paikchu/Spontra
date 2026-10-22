import { compactName } from "../../../../shared/analysis-runtime/business-tree.ts";
import type { TreeFiling, TreeLibrary } from "../business-tree/agent.ts";
import { rankPassages } from "./tool.ts";
import { libraryOutline, librarySectionPassages } from "./store.ts";

const documentIdOf = async (url: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)))].map(n => n.toString(16).padStart(2, "0")).join("");

/** A section's title as a Markdown heading; a title the library numbered when it split a long section ("Our Company (2)") reads as the filing writes it. */
const heading = (title: string | undefined) => title ? `## ${title.replace(/\s*\(\d+\)$/, "")}` : null;
/** Passages in document order, each run from one section under that section's heading. */
function withHeadings(passages: Array<{ sectionId: string; text: string }>, titles: Map<string, string>): string {
  const out: string[] = [];
  let section = "";
  for (const p of passages) {
    const head = p.sectionId !== section ? heading(titles.get(p.sectionId)) : null;
    if (head) out.push(head);
    section = p.sectionId;
    out.push(p.text);
  }
  return out.join("\n\n");
}

/**
 * The business tree's view of the filing library: its filings, verbatim reads of them, and each business's own section of
 * the annual report. With `headings`, reads carry the filing's section headings, so a passage reads with the section it sits in.
 */
export function treeLibrary(db: D1Database, ticker: string, flowFilings: TreeFiling[], options: { headings?: boolean } = {}): TreeLibrary {
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
      // A listed item reads with its lead-in: the short passage before it in the same section ("This segment primarily comprises:").
      const at = new Map(passages.map((p, i) => [p.passageId, i]));
      const kept = new Set<number>();
      for (const p of rankPassages(passages, terms, maxChars)) {
        const i = at.get(p.passageId)!, before = passages[i - 1];
        if (before && before.sectionId === p.sectionId && before.kind === "paragraph" && before.text.length < 240) kept.add(i - 1);
        kept.add(i);
      }
      const chosen = [...kept].sort((a, b) => a - b).map(i => passages[i]!);
      return options.headings ? withHeadings(chosen, new Map(outline.map(s => [s.sectionId, s.title]))) : chosen.map(p => p.text).join("\n\n");
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
      const ranked = match && passages.reduce((n, p) => n + p.text.length, 0) <= maxChars ? passages : rankPassages(passages, names, maxChars);
      // No passage naming the business: the business item from its start, which is where filings describe what they sell.
      const kept = ranked.length ? ranked : rankPassages(passages, [], maxChars);
      if (!kept.length) return null;
      const text = options.headings ? withHeadings(kept, new Map(outline.map(s => [s.sectionId, s.title]))) : kept.map(p => p.text).join("\n\n");
      return { url: latest.document_url, title: annualTitle(latest.form, latest.filed_at), text };
    },
  };
}
