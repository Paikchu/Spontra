import { z } from "zod";
import type { FindingPassage } from "../../../../shared/analysis-contract/findings.ts";
import { renderTable } from "../analyst/agent.ts";
import { libraryPassages, listLibraryDocuments, readLibraryDocument } from "../filing-library/store.ts";
import { libraryFindAcross, libraryRead } from "../filing-library/tool.ts";
import type { AnalysisEnv } from "../operations.ts";
import { defineTool, type AnyTool } from "../tools/registry.ts";

/**
 * The SEC resource as a tool set every agent mounts (docs/sec-archive.md): the company's filings as the filing library
 * holds them in D1, split into verbatim passages. Three tools, one contract: `list_filings` says which filings exist,
 * `find_sections` finds the sections about a topic, `read_section` reads passages and registers each as a material a
 * quote may cite. Nothing here reaches EDGAR or the web; a filing the library does not hold is not readable.
 */
export type SecToolState = { used: { finds: number; reads: number } };
export type SecToolBudget = { finds: number; reads: number };
export type SecToolInput<S extends SecToolState> = {
  env: AnalysisEnv;
  ticker: string;
  budget: SecToolBudget;
  /** Registers a passage read as one of the run's materials and returns its id (`m3`). */
  register: (state: S, passage: FindingPassage) => string;
  /** What the run does once a budget is spent, named in the error the model reads. */
  spent: { finds: string; reads: string };
};

export function secFilingTools<S extends SecToolState>(input: SecToolInput<S>): AnyTool<S>[] {
  const tool = defineTool<S>();
  const { env, ticker, budget } = input;
  const db = env.DB!;
  return [
    tool({ name: "list_filings", description: "The company's filings the library holds, newest first: form, dates and documentId. forms narrows to some forms (10-K, 10-Q, 8-K, 20-F, 6-K).",
      parameters: z.object({ forms: z.array(z.string().max(8)).max(6).optional(), limit: z.number().int().min(1).max(40).optional() }), concurrencySafe: true,
      execute: async (args, ctx) => {
        const documents = await ctx.stage("list-filings", () => listLibraryDocuments(db, { ticker, forms: args.forms, limit: args.limit ?? 12 }));
        return documents.map(d => `${d.form} filed ${d.filedAt} for ${d.reportDate} · ${d.docType} · documentId ${d.documentId}`).join("\n") || "The library holds no filing of this company yet.";
      }, observe: (_a, v) => v }),
    tool({ name: "find_sections", description: "Find sections of the company's filings by topic, keywords or a question.", parameters: z.object({ topic: z.string().max(120).optional(), keywords: z.string().max(200).optional(), question: z.string().max(300).optional() }), concurrencySafe: true,
      execute: async (args, ctx) => {
        if (ctx.state.used.finds >= budget.finds) throw new Error(`no finds left; ${input.spent.finds}`);
        ctx.state.used.finds++;
        const found = await ctx.stage("find", () => libraryFindAcross(env, { tickers: [ticker], ...args, limit: 8 }));
        return found.found.map(s => `${s.form} ${s.filedAt} · documentId ${s.documentId} · sectionId ${s.sectionId} · ${s.path.join(" › ")}${s.gist ? ` · ${s.gist}` : ""}`).join("\n") || "No sections found; try other keywords.";
      }, observe: (_a, v) => v }),
    tool({ name: "read_section", description: "Read a section of a filing; previous: true reads the same section in the earlier filing. Each passage read becomes a material m<n> a quote may cite.", parameters: z.object({ documentId: z.string().max(80), sectionId: z.string().max(80).optional(), focus: z.array(z.string().max(60)).max(8).optional(), previous: z.boolean().optional() }),
      execute: async (args, ctx) => {
        if (ctx.state.used.reads >= budget.reads) throw new Error(`no reads left; ${input.spent.reads}`);
        ctx.state.used.reads++;
        const read = await ctx.stage("read", async () => {
          let target = args.documentId;
          if (args.previous) target = (await readLibraryDocument(db, args.documentId))?.previousDocumentId ?? args.documentId;
          const document = await readLibraryDocument(db, target);
          if (!document || document.ticker !== ticker) return null;
          const read = await libraryRead(db, { documentId: target, sectionId: args.sectionId, focus: args.focus, maxChars: 7000 });
          const full = await libraryPassages(db, read.passages.map(p => p.passageId));
          return { document, passages: read.passages.map(p => { const row = full.find(f => f.passageId === p.passageId); return { passageId: p.passageId, documentId: target, title: `${document.ticker} ${document.form} ${document.reportDate}`, form: document.form, filedAt: document.filedAt, url: document.documentUrl, path: p.path.split(" › "), text: p.text,
            table: row?.table ? { unit: row.table.unit, columns: row.table.columns, rows: row.table.rows.map(r => ({ label: r.label, cells: r.cells.map(c => ({ text: c.text, value: c.value })) })) } : null } satisfies FindingPassage; }), omitted: read.omitted };
        });
        if (!read) throw new Error(`no filing ${args.documentId} of ${ticker}`);
        return read.passages.map(p => { const id = input.register(ctx.state, p); return `[${id}] ${p.title} › ${p.path.join(" › ")}\n${p.table ? renderTable(p.table, args.focus ?? []) : p.text.slice(0, 2400)}`; }).join("\n\n") + (read.omitted ? `\n(${read.omitted} passages omitted; narrow with focus)` : "");
      }, observe: (_a, v) => v }),
  ];
}
