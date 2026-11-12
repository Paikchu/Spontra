import { z } from "zod";
import type { FindingPassage } from "../../../../shared/analysis-contract/findings.ts";
import { listFilingReadmes, readFilingReadme, readmePage, resolveReadmeAccession } from "../filing-library/readme.ts";
import type { AnalysisEnv } from "../operations.ts";
import { defineTool, type AnyTool } from "../tools/registry.ts";

/**
 * The SEC resource as a tool set every agent mounts (docs/sec-archive.md). Two tools: `list_filings` says which
 * filings have a README, `read_filing` returns that README (the filing's own text with boilerplate removed and its
 * exhibits included) and registers it as one material a quote may cite. Nothing here reaches EDGAR or the web.
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
    tool({ name: "list_filings", description: "The company's filing READMEs, newest first: form, dates, accession and length. forms narrows to some forms (10-K, 10-Q, 8-K, 20-F, 6-K).",
      parameters: z.object({ forms: z.array(z.string().max(12)).max(8).optional(), limit: z.number().int().min(1).max(40).optional() }), concurrencySafe: true,
      execute: async (args, ctx) => {
        const filings = await ctx.stage("list-filings", () => listFilingReadmes(db, ticker, { forms: args.forms, limit: args.limit ?? 12 }));
        return filings.map(d => `${d.form} filed ${d.filedAt.slice(0, 10)} for ${d.reportDate} · accession ${d.accession} · ${d.chars} characters · ${d.passages} passages`).join("\n") || "No filing README is ready for this company yet.";
      }, observe: (_a, v) => v }),
    tool({ name: "read_filing", description: "Read one filing's README: boilerplate removed, this filing's exhibits included, each passage marked [p…], figures followed by their period. previous: true reads the earlier filing's README. offset continues a long README. The whole README becomes one material a quote may cite.",
      parameters: z.object({ accession: z.string().max(32).optional(), documentId: z.string().max(80).optional(), previous: z.boolean().optional(), offset: z.number().int().min(0).optional() }),
      execute: async (args, ctx) => {
        if (!args.accession && !args.documentId) throw new Error("name the filing by accession (list_filings) or documentId");
        if (ctx.state.used.reads >= budget.reads) throw new Error(`no reads left; ${input.spent.reads}`);
        ctx.state.used.reads++;
        const read = await ctx.stage("read", async () => {
          const accession = await resolveReadmeAccession(db, ticker, args);
          if (!accession) return { missing: args.previous ? "no earlier filing" : "no such filing" } as const;
          const readme = await readFilingReadme(env, ticker, accession);
          if (!readme) return { missing: "README not ready" } as const;
          const passage: FindingPassage = {
            passageId: `readme:${ticker}:${accession}`, documentId: accession, title: `${ticker} ${readme.form} ${readme.reportDate}`,
            form: readme.form, filedAt: readme.filedAt, url: "", path: ["README"], text: "", table: null,
          };
          return { readme, passage };
        });
        if ("missing" in read) throw new Error(`${read.missing} for ${ticker}`);
        const id = input.register(ctx.state, read.passage);
        const page = readmePage(read.readme.markdown, args.offset ?? 0);
        return `[${id}] ${read.passage.title}\n${page.text}`;
      }, observe: (_a, v) => v }),
  ];
}
