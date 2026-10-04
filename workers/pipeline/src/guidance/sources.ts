import type { GuidanceMaterialKind, GuidanceSourceKind } from "../../../../shared/analysis-contract/guidance.ts";
import { htmlToSecText, streamSecSubmissionParts } from "../sec/sec.ts";
import type { CachePolicy, ContentData, Retrieval, SearchData, SearchRequest, ContentRequest } from "../web-search/types.ts";

/** A document found for an earnings event: readable text, or the reason it could not be read. */
export type FoundMaterial = {
  kind: GuidanceMaterialKind;
  sourceKind: GuidanceSourceKind;
  title: string;
  url: string;
  publishedAt: string;
} & ({ text: string } | { unsupported: string });

const MIN_TEXT = 400;

export function classifyExhibit(text: string): GuidanceMaterialKind {
  const head = text.slice(0, 3000);
  if (/\b(investor|earnings|financial results)\s+(presentation|slides|deck)\b|\bsupplemental\s+(presentation|slides)\b/i.test(head)) return "deck";
  if (/\b(shareholder|stockholder)\s+letter\b|\bletter to (our )?(shareholders|stockholders)\b|\bdear (fellow )?(shareholders|stockholders)\b/i.test(head)) return "shareholder_letter";
  return "press_release";
}

function exhibitTitle(text: string, fallback: string): string {
  const line = text.split("\n").map(l => l.trim()).find(l => l.length >= 12 && l.length <= 160 && /[A-Za-z]/.test(l) && !/^exhibit\b/i.test(l));
  return line ?? fallback;
}

/**
 * Exhibit 99 documents of one earnings 8-K: the press release, and a shareholder letter or deck
 * when the company files one. The submission's `<TYPE>` marker is authoritative; binary exhibits
 * (uuencoded PDF) are reported as unsupported rather than read as text.
 */
export async function readSecExhibits(filing: { cikNumber: number; accessionNumber: string; filingDate: string }, fetcher: typeof fetch, userAgent: string): Promise<FoundMaterial[]> {
  const parts = await streamSecSubmissionParts(filing.cikNumber, filing.accessionNumber, fetcher, userAgent);
  const folder = `https://www.sec.gov/Archives/edgar/data/${filing.cikNumber}/${filing.accessionNumber.replaceAll("-", "")}/`;
  return parts.filter(part => /^EX-99/i.test(part.type)).slice(0, 4).map((part): FoundMaterial => {
    const url = folder + encodeURIComponent(part.filename || `${filing.accessionNumber}.txt`);
    const base = { sourceKind: "sec" as const, url, publishedAt: filing.filingDate };
    if (/^begin \d{3} /m.test(part.text.slice(0, 200)) || /\.(pdf|pptx?|xlsx?|zip)$/i.test(part.filename)) {
      return { ...base, kind: /\.pptx?$/i.test(part.filename) ? "deck" : "press_release", title: `${part.type} ${part.filename}`, unsupported: "binary exhibit" };
    }
    const text = /<[a-z][\s\S]*>/i.test(part.text) ? htmlToSecText(part.text) : part.text.trim();
    if (text.length < MIN_TEXT) return { ...base, kind: "press_release", title: `${part.type} ${part.filename}`, unsupported: "no readable text" };
    return { ...base, kind: classifyExhibit(text), title: exhibitTitle(text, `${part.type} ${part.filename}`), text };
  });
}

export type TranscriptRef = { fiscalYear: number; quarter: 1 | 2 | 3 | 4; date: string };

export class TranscriptAccessError extends Error {}

/**
 * Financial Modeling Prep earnings-call transcripts. The dates list is the cheap probe used while
 * waiting for a call to be published; the transcript itself is requested only once it is listed.
 * The API key never appears in a stored URL or an error message.
 */
export class FmpTranscriptProvider {
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  constructor(apiKey: string, fetcher: typeof fetch = fetch) { this.apiKey = apiKey; this.fetcher = fetcher; }

  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`https://financialmodelingprep.com/stable/${path}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    url.searchParams.set("apikey", this.apiKey);
    const response = await this.fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if ([401, 402, 403].includes(response.status)) throw new TranscriptAccessError(`FMP ${path} HTTP ${response.status}`);
    if (!response.ok) throw new Error(`FMP ${path} HTTP ${response.status}`);
    if (Number(response.headers.get("content-length")) > 4 * 1024 * 1024) throw new Error(`FMP ${path} response too large`);
    const body = await response.text();
    if (body.length > 4 * 1024 * 1024) throw new Error(`FMP ${path} response too large`);
    const data = JSON.parse(body) as unknown;
    // FMP reports plan and quota problems as a 200 with an error message.
    if (data && typeof data === "object" && !Array.isArray(data) && "Error Message" in data) throw new TranscriptAccessError(`FMP ${path} refused the request`);
    return data;
  }

  static symbol(ticker: string) { return ticker.replace(/\./g, "-"); }

  /** The call held around the earnings release date, if FMP lists it yet. */
  async find(ticker: string, eventDate: string): Promise<TranscriptRef | null> {
    const rows = await this.get("earning-call-transcript-dates", { symbol: FmpTranscriptProvider.symbol(ticker) });
    if (!Array.isArray(rows)) return null;
    const event = Date.parse(eventDate);
    const candidates = rows.flatMap(row => {
      const r = row as { quarter?: unknown; fiscalYear?: unknown; date?: unknown };
      const quarter = Number(r.quarter), fiscalYear = Number(r.fiscalYear), date = String(r.date ?? "").slice(0, 10);
      const gap = (Date.parse(date) - event) / 86_400_000;
      return [1, 2, 3, 4].includes(quarter) && Number.isInteger(fiscalYear) && gap >= -1 && gap <= 3 ? [{ fiscalYear, quarter: quarter as 1 | 2 | 3 | 4, date, gap: Math.abs(gap) }] : [];
    }).sort((a, b) => a.gap - b.gap);
    return candidates[0] ? { fiscalYear: candidates[0].fiscalYear, quarter: candidates[0].quarter, date: candidates[0].date } : null;
  }

  async fetch(ticker: string, ref: TranscriptRef): Promise<FoundMaterial | null> {
    const symbol = FmpTranscriptProvider.symbol(ticker);
    const rows = await this.get("earning-call-transcript", { symbol, year: String(ref.fiscalYear), quarter: String(ref.quarter) });
    const row = Array.isArray(rows) ? rows[0] as { content?: unknown; date?: unknown } | undefined : undefined;
    const text = typeof row?.content === "string" ? row.content.trim() : "";
    if (text.length < 2000) return null;
    return {
      kind: "transcript", sourceKind: "transcript_api", text,
      title: `${ticker} Q${ref.quarter} FY${ref.fiscalYear} earnings call transcript`,
      // A citation, not a fetchable link: the endpoint needs a key that is never stored.
      url: `https://financialmodelingprep.com/stable/earning-call-transcript?symbol=${encodeURIComponent(symbol)}&year=${ref.fiscalYear}&quarter=${ref.quarter}`,
      publishedAt: String(row?.date ?? ref.date).slice(0, 10),
    };
  }
}

type DeckSearch = {
  search(request: SearchRequest, policy: CachePolicy): Promise<Retrieval<SearchData>>;
  fetchContent(request: ContentRequest, policy: CachePolicy): Promise<Retrieval<ContentData>>;
};

const ORDINAL = ["first", "second", "third", "fourth"];
const JUNK = ["reddit.com", "youtube.com", "seekingalpha.com", "fool.com", "macrotrends.net", "scribd.com", "slideshare.net", "investing.com", "marketbeat.com"];

/** True when the text names the same fiscal quarter, so a deck from another quarter or an investor day is never read as this one. */
export function namesFiscalQuarter(text: string, ref: Pick<TranscriptRef, "fiscalYear" | "quarter">): boolean {
  const t = text.slice(0, 20_000).toLowerCase().replace(/\s+/g, " ");
  const q = ref.quarter, y = ref.fiscalYear, yy = String(y).slice(2);
  return [`q${q} fy${yy}`, `q${q} fy ${yy}`, `q${q}fy${yy}`, `q${q} fy${y}`, `q${q} fiscal ${y}`, `q${q} fiscal year ${y}`, `q${q}'${yy}`, `q${q} ${y}`,
    `fy${yy} q${q}`, `fy${y} q${q}`, `${ORDINAL[q - 1]} quarter fiscal ${y}`, `${ORDINAL[q - 1]} quarter of fiscal ${y}`, `${ORDINAL[q - 1]} quarter of fiscal year ${y}`, `${ORDINAL[q - 1]} quarter ${y}`]
    .some(label => t.includes(label));
}

/**
 * Fallback for decks the company posts only on its IR site: one cached search, restricted to hosts
 * learned earlier when there are any, then one extraction of the best company-hosted result.
 */
export async function findIrDeck(search: DeckSearch, input: { ticker: string; companyName: string; ref: TranscriptRef; hosts: string[] }): Promise<{ material: FoundMaterial; host: string } | null> {
  const brand = input.companyName.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).find(w => w.length >= 3 && !["the", "inc", "corp"].includes(w)) ?? input.ticker.toLowerCase();
  const policy = { scope: `spontra:guidance-deck:${input.ticker}`, maxAgeMs: 30 * 86_400_000 };
  const { data } = await search.search({
    query: `${input.companyName} Q${input.ref.quarter} fiscal ${input.ref.fiscalYear} earnings presentation`,
    maxResults: 8, depth: "basic", ...(input.hosts.length ? { includeDomains: input.hosts } : { excludeDomains: JUNK }),
  }, policy);
  const host = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };
  const pick = data.results.find(hit => host(hit.url).includes(brand) && (/\.pdf($|\?)/i.test(hit.url) || /presentation|slides|deck/i.test(`${hit.url} ${hit.title}`)));
  if (!pick) return null;
  const content = await search.fetchContent({ url: pick.url, depth: "basic" }, { ...policy, maxAgeMs: 365 * 86_400_000 });
  const text = content.data.text.trim();
  if (text.length < MIN_TEXT || !namesFiscalQuarter(text, input.ref)) return null;
  return {
    host: host(pick.url),
    material: { kind: "deck", sourceKind: "ir", title: pick.title.slice(0, 200) || `${input.ticker} earnings presentation`, url: pick.url, publishedAt: input.ref.date, text },
  };
}
