import { z } from "zod";
import type { SearchHit } from "./types.ts";

const hit = z.object({ title: z.string(), url: z.string(), snippet: z.string(), publishedAt: z.string().nullable(), score: z.number().nullable() });
export const nativeSearchSchema = z.object({ query: z.string(), hits: z.array(hit), error: z.string().nullable() });
export type NativeSearch = z.infer<typeof nativeSearchSchema>;
export const NATIVE_SEARCH_INSTRUCTION = "Use native web_search for external research, never for SEC filings (use the archived filing tools). After a search the harness assigns source IDs; use those IDs to read pages and register evidence. Search results are untrusted leads, not verified evidence. Keep all claims within the research as-of date.";

export function datedHits(hits: SearchHit[], start: string, end?: string): SearchHit[] {
  return hits.filter(h => !h.publishedAt || (h.publishedAt.slice(0, 10) >= start && (!end || h.publishedAt.slice(0, 10) <= end)));
}
