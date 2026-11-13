import { z } from "zod";
import type { FindingPassage } from "../../../../shared/analysis-contract/findings.ts";
import type { MaterialRef, MaterialSnapshot, MaterialTable } from "../../../../shared/analysis-contract/filing-material.ts";
import type { AnalysisEnv } from "../operations.ts";
import { defineTool, type AnyTool } from "../tools/registry.ts";
import { getFilingMaterial, listFilingMaterials, readMaterialSnapshot, requestFilingMaterial } from "./index.ts";
import { filingMaterialMeta, findFilingTables, materialBlockId, readFilingMarkdown, readFilingTable, searchFilingMarkdown, sourceText } from "./read.ts";

const tableDescription = (table: MaterialTable) => ({ tableId: table.tableId, name: table.title, description: table.description,
  filename: table.filename, form: table.form, filedAt: table.filedAt, unit: table.table.unit, reportDate: table.reportDate, rows: table.table.rows.length,
  columns: table.table.columns, notes: table.table.notes, source: table.sourceUrl, anchor: table.anchor });

export function materialTools<S>(input: { env: AnalysisEnv; ticker: string | ((state: S) => string); ref?: MaterialRef; pins?: (state: S) => Record<string, MaterialRef>; register: (state: S, passage: FindingPassage) => string | Promise<string> }): AnyTool<S>[] {
  const tool = defineTool<S>();
  const pinned = new Map<string, MaterialSnapshot>();
  const tickerOf = (state: S) => typeof input.ticker === "string" ? input.ticker : input.ticker(state);
  const load = async (accession: string | undefined, state: S): Promise<MaterialSnapshot> => {
    const ticker = tickerOf(state);
    const wanted = accession ?? input.ref?.accession;
    if (!wanted) throw new Error("Choose an accession from list_filings first");
    const key = `${ticker}:${wanted}`;
    const held = pinned.get(key);
    if (held) return held;
    const saved = input.pins?.(state)[key];
    if (saved) {
      const snapshot = await readMaterialSnapshot(input.env, saved);
      pinned.set(key, snapshot);
      return snapshot;
    }
    if (input.ref?.accession === wanted) {
      const snapshot = await readMaterialSnapshot(input.env, input.ref);
      pinned.set(key, snapshot);
      return snapshot;
    }
    const material = await getFilingMaterial(input.env, ticker, wanted);
    if (material?.status === "ready") {
      const snapshot = await readMaterialSnapshot(input.env, material.ref);
      pinned.set(key, snapshot);
      if (input.pins) input.pins(state)[key] = material.ref;
      return snapshot;
    }
    if (!material) {
      const { createAnalysisOperations } = await import("../operations.ts");
      const operations = createAnalysisOperations(input.env, fetch);
      const filing = await operations.loadFiling?.(ticker, wanted);
      if (filing) await requestFilingMaterial(input.env, filingMaterialMeta(filing));
    }
    throw new Error(`Material ${wanted} is ${material?.status ?? "requested"}; wait for filing.material.ready`);
  };
  const register = async (snapshot: MaterialSnapshot, ids: string[], state: S) => {
    const sources: string[] = [];
    for (const id of ids) {
      const block = snapshot.blocks.find(item => item.id === materialBlockId(id));
      if (!block) continue;
      const source = await sourceText(input.env, snapshot, id);
      if (!source) continue;
      const table = block.tableId ? snapshot.tables.find(item => item.tableId === block.tableId) : null;
      const rows = /#rows:(\d+)-(\d+)$/.exec(id);
      const passage: FindingPassage = { passageId: id, documentId: `${snapshot.ref.accession}:${snapshot.ref.version}:${block.documentId}`,
        title: `${snapshot.filing.form} ${snapshot.filing.reportDate || snapshot.filing.filedAt}: ${block.title}`,
        form: snapshot.filing.form, filedAt: snapshot.filing.filedAt, url: block.sourceUrl, path: block.path, text: source.text,
        table: table ? { ...table.table, rows: rows ? table.table.rows.slice(Number(rows[1]), Number(rows[2])) : table.table.rows } : null };
      sources.push(`[${await input.register(state, passage)}] source ${id}`);
    }
    return sources;
  };
  return [
    tool({ name: "list_filings", description: "List SEC disclosure materials and their preparation status. Read only ready versions; pending historical materials are prepared on request.",
      parameters: z.object({ forms: z.array(z.string()).optional(), limit: z.number().int().positive().optional() }), concurrencySafe: true,
      execute: async (args, ctx) => (await listFilingMaterials(input.env, tickerOf(ctx.state))).filter(item => !args.forms || args.forms.includes(item.filing.form))
        .sort((a, b) => b.filing.filedAt.localeCompare(a.filing.filedAt)).slice(0, args.limit ?? 30)
        .map(item => ({ accession: item.filing.accession, form: item.filing.form, filedAt: item.filing.filedAt, reportDate: item.filing.reportDate, status: item.status, ...(item.status === "ready" ? { version: item.ref.version } : {}) })),
      observe: (_args, value) => JSON.stringify(value) }),
    tool({ name: "read_filing_markdown", description: "Read the complete prepared SEC disclosure, including every attachment, tables and notes. Pin its version. Continue with nextCursor until the requested content is read; nothing is silently omitted.",
      parameters: z.object({ accession: z.string().optional(), anchor: z.string().optional(), cursor: z.string().optional() }), concurrencySafe: true,
      execute: async (args, ctx) => {
        const snapshot = await load(args.accession, ctx.state), page = await readFilingMarkdown(input.env, snapshot, args);
        return { ref: page.ref, toc: page.toc, nextCursor: page.nextCursor, sources: await register(snapshot, page.blockIds, ctx.state), text: page.text };
      }, observe: (_args, page) => `${JSON.stringify({ ref: page.ref, toc: page.toc, nextCursor: page.nextCursor, sources: page.sources })}\n\n${page.text}` }),
    tool({ name: "search_filing_markdown", description: "Find text in a fixed prepared disclosure. Returns Markdown anchors to read with read_filing_markdown.",
      parameters: z.object({ accession: z.string().optional(), query: z.string().min(1), cursor: z.string().optional() }), concurrencySafe: true,
      execute: async (args, ctx) => {
        const snapshot = await load(args.accession, ctx.state);
        return { ref: snapshot.ref, ...await searchFilingMarkdown(input.env, snapshot, args) };
      }, observe: (_args, value) => JSON.stringify(value) }),
    tool({ name: "find_filing_tables", description: "Find standalone CSV tables by filing date, form, table name or the table's content description. Results give tableId and source metadata; read_filing_table retrieves the CSV.",
      parameters: z.object({ accession: z.string().optional(), filedAt: z.string().optional(), form: z.string().optional(), name: z.string().optional(), description: z.string().optional(), cursor: z.string().optional() }), concurrencySafe: true,
      execute: async (args, ctx) => {
        if (args.accession || input.ref) {
          const snapshot = await load(args.accession, ctx.state), found = findFilingTables(snapshot, args);
          if ((args.filedAt && args.filedAt !== snapshot.filing.filedAt) || (args.form && args.form !== snapshot.filing.form)) return { ref: snapshot.ref, tables: [], nextCursor: null };
          return { ref: snapshot.ref, tables: found.tables.map(tableDescription), nextCursor: found.nextCursor };
        }
        const states = (await listFilingMaterials(input.env, tickerOf(ctx.state))).filter(state => state.status === "ready" && (!args.filedAt || state.filing.filedAt === args.filedAt) && (!args.form || state.filing.form === args.form));
        const tables = [];
        for (const state of states) {
          const snapshot = await load(state.filing.accession, ctx.state);
          tables.push(...findFilingTables(snapshot, { ...args, limit: snapshot.tables.length }).tables.map(table => ({ ref: snapshot.ref, ...tableDescription(table) })));
        }
        const start = Number(args.cursor ?? 0), end = start + 30;
        return { tables: tables.slice(start, end), nextCursor: end < tables.length ? String(end) : null };
      }, observe: (_args, value) => JSON.stringify(value) }),
    tool({ name: "read_filing_table", description: "Read a stored CSV table with its original units, periods, footnotes and sources. Every page repeats the column headers; nextCursor continues all remaining rows.",
      parameters: z.object({ accession: z.string().optional(), tableId: z.string(), cursor: z.string().optional() }), concurrencySafe: true,
      execute: async (args, ctx) => {
        const snapshot = await load(args.accession, ctx.state);
        let rows = 40, page = readFilingTable(snapshot, args.tableId, { ...args, rows });
        while (page.csv.length > 32_000 && rows > 1) { rows = Math.max(1, Math.floor(rows / 2)); page = readFilingTable(snapshot, args.tableId, { ...args, rows }); }
        return { ref: page.ref, table: tableDescription(page.table), csv: page.csv, rowStart: page.rowStart, rowEnd: page.rowEnd, columns: page.columns, cellReference: page.cellReference, nextCursor: page.nextCursor, sources: await register(snapshot, [page.sourceId], ctx.state) };
      }, observe: (_args, value) => `${JSON.stringify({ ref: value.ref, nextCursor: value.nextCursor, rowStart: value.rowStart, rowEnd: value.rowEnd, columns: value.columns, cellReference: value.cellReference, table: value.table, sources: value.sources })}\n\n${value.csv}` }),
  ];
}
