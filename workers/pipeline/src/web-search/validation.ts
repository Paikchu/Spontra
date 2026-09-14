import { WebSearchError, type ContentRequest, type SearchRequest } from "./types.ts";
const invalid = () => { throw new WebSearchError("invalid_request"); };
export function publicUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  // No arbitrary direct fetch: this URL is only submitted to the provider's fixed HTTPS API.
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !url.hostname.includes(".") || /[:\[\]]/.test(url.hostname) ||
      /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) return invalid();
  url.hash = "";
  return url.href;
}
function domains(values: string[] = []): string[] {
  if (!Array.isArray(values) || values.length > 100) return invalid();
  return [...new Set(values.map(value => {
    if (typeof value !== "string") return invalid();
    const domain = value.trim().toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) return invalid();
    publicUrl(`https://${domain}`);
    return domain;
  }))].sort();
}
export function normalizeSearch(input: SearchRequest): SearchRequest {
  if (!input || typeof input.query !== "string") return invalid();
  const query = input.query.trim(); // Preserve internal whitespace/case: search operators can be sensitive.
  const maxResults = input.maxResults ?? 5;
  const depth = input.depth ?? "basic";
  const topic = input.topic ?? "general";
  if (!query || query.length > 400 || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20 ||
      !["basic", "advanced"].includes(depth) || !["general", "news"].includes(topic)) return invalid();
  for (const date of [input.startDate, input.endDate]) {
    if (date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) return invalid();
  }
  if (input.startDate && input.endDate && input.startDate > input.endDate) return invalid();
  return { query, maxResults, depth, topic, includeDomains: domains(input.includeDomains),
    excludeDomains: domains(input.excludeDomains), startDate: input.startDate, endDate: input.endDate };
}
export function normalizeContent(input: ContentRequest): ContentRequest {
  if (!input || typeof input.url !== "string" || input.url.length > 4096 ||
    !["basic", "advanced"].includes(input.depth ?? "basic")) return invalid();
  return { url: publicUrl(input.url), depth: input.depth ?? "basic" };
}
export async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("");
}
