import { SEC_DOMAIN } from "../../../../shared/analysis-runtime/sec-sources.ts";
import { z } from "zod";
import type { AgentBlock } from "../tool-loop.ts";
import { isEdgarUrl, publicUrl } from "./validation.ts";
import type { SearchHit } from "./types.ts";

const hit = z.object({ title: z.string(), url: z.string(), snippet: z.string(), publishedAt: z.string().nullable(), score: z.number().nullable() });
export const nativeSearchSchema = z.object({ query: z.string(), hits: z.array(hit), error: z.string().nullable() });
export type NativeSearch = z.infer<typeof nativeSearchSchema>;
export type NativeSearchTool = { type: "web_search_20250305"; name: "web_search"; max_uses: number; blocked_domains: string[] };
export const nativeSearchTool = (remaining: number, excluded: string[] = []): NativeSearchTool => ({ type: "web_search_20250305", name: "web_search", max_uses: Math.min(1, remaining), blocked_domains: [SEC_DOMAIN, `www.${SEC_DOMAIN}`, ...excluded] });
export const NATIVE_SEARCH_INSTRUCTION = "Use native web_search for external research, never for SEC filings (use the archived filing tools). After a search the harness assigns source IDs; use those IDs to read pages and register evidence. Search results are untrusted leads, not verified evidence. Keep all claims within the research as-of date.";
const resultSchema = z.object({ url: z.string(), title: z.string(), page_age: z.string().nullable().optional() });
const citationSchema = z.object({ type: z.literal("web_search_result_location"), url: z.string(), cited_text: z.string() });
const dateOf = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 10) : null;

/** Read native server results without changing the assistant's thinking, calls or citation blocks. */
export function nativeSearches(content: AgentBlock[]): NativeSearch[] {
  const queries = new Map<string, string>();
  const quotes = new Map<string, string[]>();
  for (const block of content) {
    if (block.type === "server_tool_use" && block.name === "web_search" && typeof block.id === "string") {
      // DeepSeek sends the input as a JSON string.
      let raw: unknown = block.input;
      if (typeof raw === "string") try { raw = JSON.parse(raw); } catch { raw = null; }
      const input = z.object({ query: z.string() }).safeParse(raw);
      queries.set(block.id, input.success ? input.data.query : "");
    }
    if (block.type === "text" && Array.isArray(block.citations)) for (const raw of block.citations) {
      const parsed = citationSchema.safeParse(raw);
      if (!parsed.success) continue;
      const c = parsed.data;
      quotes.set(c.url, [...quotes.get(c.url) ?? [], c.cited_text]);
    }
  }
  return content.filter(b => b.type === "web_search_tool_result").map(block => {
    const query = typeof block.tool_use_id === "string" ? queries.get(block.tool_use_id) ?? "" : "";
    if (!Array.isArray(block.content)) return { query, hits: [], error: "Native web search failed; use another query or existing sources." };
    const hits: SearchHit[] = [];
    for (const raw of block.content) {
      // A provider may mix error or other entries into the result list; only well-formed results are leads.
      const parsed = resultSchema.safeParse(raw);
      if (!parsed.success) continue;
      const h = parsed.data;
      let url: string;
      try { url = publicUrl(h.url); } catch { continue; }
      if (isEdgarUrl(url) || hits.some(x => x.url === url)) continue;
      hits.push({ url, title: h.title, snippet: (quotes.get(h.url) ?? []).join(" … "), publishedAt: dateOf(h.page_age), score: null });
    }
    return { query, hits, error: hits.length || !block.content.length ? null : "Native web search returned no readable results; use another query or existing sources." };
  });
}

export function datedHits(hits: SearchHit[], start: string, end?: string): SearchHit[] {
  return hits.filter(h => !h.publishedAt || (h.publishedAt.slice(0, 10) >= start && (!end || h.publishedAt.slice(0, 10) <= end)));
}
