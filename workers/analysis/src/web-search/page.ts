import { extractText } from "unpdf";
import { WebSearchError, type ContentData, type ContentRequest, type SearchData, type SearchProvider, type SearchRequest } from "./types.ts";
import { normalizeContent, publicUrl } from "./validation.ts";

/** Workers AI document conversion (`env.AI.toMarkdown`); HTML and PDF convert without model tokens. */
export type MarkdownConverter = {
  toMarkdown(file: { name: string; blob: Blob }, options?: { conversionOptions?: { html?: { hostname?: string } } }):
    Promise<{ format: string; data?: string; error?: string } | Array<{ format: string; data?: string; error?: string }>>;
};
/** How one page read went, for the logs: read here, or handed to the fallback and why. */
export type PageReadRecord = { url: string; outcome: "direct" | "fallback"; reason?: string; status?: number; contentType?: string; characters?: number; durationMs: number };
export type DirectPageOptions = { fetcher?: typeof fetch; markdown?: MarkdownConverter; timeoutMs?: number; record?: (read: PageReadRecord) => void };

const MAX_BYTES = 8 * 1024 * 1024, MAX_REDIRECTS = 5, TIMEOUT_MS = 20_000;
/** Below this a page is a script shell, a cookie wall or an error page, not an article. */
const MIN_CHARACTERS = 500;
/** The page text kept per depth, in characters: about what the fallback's `max_content_tokens` allows. */
const KEEP_CHARACTERS = { basic: 40_000, advanced: 100_000 } as const;
const BLOCKED = /just a moment\.\.\.|enable javascript and cookies|attention required|access denied|verify you are (?:a )?human|captcha/i;
const ACCEPT = "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, application/pdf;q=0.8, text/plain;q=0.5";

/** Why a page could not be read here; the provider then asks its fallback. */
class Unreadable extends Error {
  readonly status?: number; readonly contentType?: string;
  constructor(reason: string, status?: number, contentType?: string) { super(reason); this.status = status; this.contentType = contentType; }
}

async function body(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) throw new Unreadable("too-large", response.status);
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel().catch(() => undefined); throw new Unreadable("too-large", response.status); }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { all.set(part, offset); offset += part.byteLength; }
  return all;
}

/**
 * Reads one public page in the Worker: redirects followed by hand so every hop passes the same public-URL check, Markdown
 * taken as served, HTML converted by Workers AI, a PDF's text extracted with unpdf. Throws `Unreadable` when the page
 * needs a browser or refuses the request.
 */
export async function readPageDirect(url: string, depth: "basic" | "advanced", options: DirectPageOptions): Promise<{ text: string; contentType: string; status: number }> {
  const fetcher = options.fetcher ?? fetch;
  let current = publicUrl(url), response: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    response = await fetcher(current, { redirect: "manual", headers: { accept: ACCEPT, "user-agent": "SpontraResearch/1.0" }, signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS) });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) break;
    await response.body?.cancel().catch(() => undefined);
    try { current = publicUrl(new URL(location, current).href); } catch { throw new Unreadable("redirect-not-public", response.status); }
    if (hop === MAX_REDIRECTS) throw new Unreadable("too-many-redirects", response.status);
  }
  if (!response) throw new Unreadable("no-response");
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Unreadable("http", response.status, contentType); }
  const bytes = await body(response);
  let text: string;
  if (contentType === "text/markdown" || contentType === "text/plain") text = new TextDecoder().decode(bytes);
  else if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    if (!options.markdown) throw new Unreadable("no-converter", response.status, contentType);
    const converted = await options.markdown.toMarkdown({ name: "page.html", blob: new Blob([bytes], { type: "text/html" }) }, { conversionOptions: { html: { hostname: current } } });
    const result = Array.isArray(converted) ? converted[0] : converted;
    if (!result || result.format !== "markdown" || !result.data) throw new Unreadable("conversion-failed", response.status, contentType);
    text = result.data;
  } else if (contentType === "application/pdf") {
    try { text = (await extractText(bytes, { mergePages: true })).text; } catch { throw new Unreadable("pdf-unreadable", response.status, contentType); }
  } else throw new Unreadable("unsupported-type", response.status, contentType);
  const trimmed = text.trim();
  if (trimmed.length < MIN_CHARACTERS) throw new Unreadable("too-short", response.status, contentType);
  if (trimmed.length < 4_000 && BLOCKED.test(trimmed)) throw new Unreadable("blocked", response.status, contentType);
  return { text: trimmed.slice(0, KEEP_CHARACTERS[depth]), contentType, status: response.status };
}

/**
 * Searches through `inner` and reads pages in the Worker, so a page's text never passes through a model; only a page
 * that cannot be read here (a block, a script-only page, an unsupported type) goes to `inner.fetchContent`. Page reads
 * carry their own cache version, so changing how pages are read leaves the search cache intact.
 */
export class DirectPageProvider implements SearchProvider {
  readonly id: string;
  readonly contentId: string;
  private readonly inner: SearchProvider;
  private readonly options: DirectPageOptions;
  constructor(inner: SearchProvider, options: DirectPageOptions) {
    this.inner = inner; this.options = options;
    this.id = inner.id;
    this.contentId = `direct-page:v1+${inner.contentId ?? inner.id}`;
  }
  search(request: SearchRequest): Promise<SearchData> { return this.inner.search(request); }
  async fetchContent(input: ContentRequest): Promise<ContentData> {
    const r = normalizeContent(input), started = Date.now();
    try {
      const page = await readPageDirect(r.url, r.depth ?? "basic", this.options);
      this.options.record?.({ url: r.url, outcome: "direct", status: page.status, contentType: page.contentType, characters: page.text.length, durationMs: Date.now() - started });
      return { kind: "content", url: r.url, text: page.text, format: "markdown", completeness: "unverified" };
    } catch (error) {
      if (error instanceof WebSearchError && error.code === "invalid_request") throw error;
      const reason = error instanceof Unreadable ? error.message : error instanceof Error && error.name === "TimeoutError" ? "timeout" : "transport";
      this.options.record?.({ url: r.url, outcome: "fallback", reason, ...(error instanceof Unreadable ? { status: error.status, contentType: error.contentType } : {}), durationMs: Date.now() - started });
      return this.inner.fetchContent(r);
    }
  }
}
