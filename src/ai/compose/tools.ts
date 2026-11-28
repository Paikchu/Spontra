import { nativeSearchSchema, datedHits } from "../web-search/native.ts";
import { z } from "zod";
import type { FindingPassage } from "../../lib/findings-contract.ts";
import { EXCLUDED_HOSTS, PAGE_CACHE_MS, WEB_SCOPE, hostOf, readWebPage } from "../web-search/read-page.ts";
import type { AnalysisEnv } from "../../operations.ts";
import { defineTool, type AnyTool } from "../tools/registry.ts";
import type { SearchHit } from "../web-search/types.ts";
import { researchSearch, researchSearchConfigured } from "../web-search/research-search.ts";

const untrusted = (host: string, text: string) => `<untrusted source="${host}">\n${text}\n</untrusted>`;

/** What the two web tools keep in a run's state. */
export type WebToolState = { hits: SearchHit[]; used: { searches: number; webReads: number } };

/** Web search and page reading; `register` records a page read and names it for the model. */
export function webTools<S extends WebToolState>(input: { env: AnalysisEnv; ticker: string; now: string; periodEnd: string; budget: { searches: number; webReads: number }; register: (state: S, passage: FindingPassage, publishedAt: string | null) => string }): AnyTool<S>[] {
  const { env, ticker, now, budget, register } = input;
  const tool = defineTool<S>();
  const search = researchSearchConfigured(env) ? researchSearch(env) : null;
  const yearBefore = input.periodEnd.replace(/^(\d{4})/, (_, y: string) => String(Number(y) - 1));
  return [
    tool({ name: "search", description: "Register native search results as source IDs for page reads.", parameters: nativeSearchSchema,
      nativeSearch: { remaining: state => budget.searches - state.used.searches, excluded: EXCLUDED_HOSTS },
      execute: async ({ query, hits, error }, ctx) => {
        ctx.state.used.searches++;
        if (error) return error;
        const found = datedHits(hits, yearBefore).slice(0, 6);
        for (const h of found) if (!ctx.state.hits.some(x => x.url === h.url)) ctx.state.hits.push(h);
        return found.map(h => `[h${ctx.state.hits.findIndex(x => x.url === h.url) + 1}] ${h.title.slice(0, 160)} (${hostOf(h.url)} · ${h.publishedAt?.slice(0, 10) ?? "undated"})\n${untrusted(hostOf(h.url), h.snippet.replace(/\s+/g, " ").slice(0, 300))}`).join("\n") || `Search "${query}" returned nothing.`;
      }, observe: (_a, v) => v }),
    tool({ name: "read_web", description: "Read one page from this run's search hits, by its hit id (h2). The page becomes a material a quote may cite.", parameters: z.object({ hit: z.string().regex(/^h\d{1,2}$/), focus: z.array(z.string().max(60)).max(8).optional() }),
      execute: async ({ hit, focus }, ctx) => {
        if (!search) throw new Error("web reading is not configured");
        if (ctx.state.used.webReads >= budget.webReads) throw new Error("no web reads left");
        const target = ctx.state.hits[Number(hit.slice(1)) - 1];
        if (!target) throw new Error("read_web needs a hit id from this run's searches");
        ctx.state.used.webReads++;
        const read = await ctx.stage("web", () => readWebPage(env, ticker, target, (focus ?? []).map(f => f.toLowerCase()), now, url => search.fetchContent({ url, depth: "advanced" }, { ...WEB_SCOPE(ticker), maxAgeMs: PAGE_CACHE_MS }).then(r => ({ text: r.data.text }))));
        if (!read) throw new Error(`${hostOf(target.url)} could not be read`);
        const id = register(ctx.state, read.passage, read.record.publishedAt);
        return `[${id}] ${read.record.title} (${hostOf(target.url)} · ${read.record.publishedAt ?? "undated"})\n${untrusted(hostOf(target.url), read.passage.text.slice(0, 3000))}`;
      }, observe: (_a, v) => v }),
  ];
}
