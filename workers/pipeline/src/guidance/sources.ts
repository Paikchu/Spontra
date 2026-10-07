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

export class TranscriptQuotaError extends Error {}

/** Resolve only a release headline; forward guidance in the body is not the reported quarter. */
export function reportedTranscriptRef(materials: FoundMaterial[], date: string): TranscriptRef | null {
  const refs: TranscriptRef[] = [];
  const quarter = "(first|second|third|fourth|[1-4](?:st|nd|rd|th))\\s+quarter";
  const year = "(?:fiscal\\s+(?:year\\s+)?|FY\\s*)?(20\\d{2})";
  const patterns = [
    new RegExp(`${quarter}\\s+(?:of\\s+)?${year}`, "i"),
    new RegExp(`${year}\\s+${quarter}`, "i"),
    /\bQ([1-4])\s+(?:FY\s*|fiscal\s+(?:year\s+)?)?(20\d{2})\b/i,
    /\b(?:FY\s*)?(20\d{2})\s+Q([1-4])\b/i,
  ];
  for (const material of materials.filter(m => m.kind === "press_release")) {
    const headline = "text" in material ? material.text.split("\n").map(l => l.trim()).find(l => /(?:announces|reports).*results/i.test(l) && l.length <= 300) : null;
    for (const title of [material.title, ...(headline ? [headline] : [])]) {
      for (const [index, pattern] of patterns.entries()) {
        const match = pattern.exec(title);
        if (!match) continue;
        const fiscalYear = Number(match[index % 2 ? 1 : 2]);
        const label = match[index % 2 ? 2 : 1].toLowerCase();
        const q = ["first", "second", "third", "fourth"].indexOf(label) + 1 || Number(label[0]);
        refs.push({ fiscalYear, quarter: q as TranscriptRef["quarter"], date });
      }
    }
  }
  return refs.length && refs.every(r => r.fiscalYear === refs[0].fiscalYear && r.quarter === refs[0].quarter) ? refs[0] : null;
}

/** One request per fiscal quarter. The API supplies ordered speaker turns, but no call date. */
export class AlphaVantageTranscriptProvider {
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  constructor(apiKey: string, fetcher: typeof fetch = fetch) { this.apiKey = apiKey; this.fetcher = fetcher; }

  async fetch(ticker: string, ref: TranscriptRef): Promise<FoundMaterial | null> {
    const quarter = `${ref.fiscalYear}Q${ref.quarter}`;
    const citation = new URL("https://www.alphavantage.co/query");
    citation.search = new URLSearchParams({ function: "EARNINGS_CALL_TRANSCRIPT", symbol: ticker, quarter }).toString();
    const url = new URL(citation);
    url.searchParams.set("apikey", this.apiKey);
    let response: Response;
    try {
      const fetcher = this.fetcher; // Workers' global fetch requires an unbound call.
      response = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch {
      // Fetch errors can include the credential-bearing request URL.
      throw new Error("Alpha Vantage transcript request failed");
    }
    if ([401, 402, 403].includes(response.status)) throw new TranscriptAccessError(`Alpha Vantage HTTP ${response.status}`);
    if (response.status === 429) throw new TranscriptQuotaError("Alpha Vantage rate limit reached");
    if (!response.ok) throw new Error(`Alpha Vantage HTTP ${response.status}`);
    const data = await response.json() as {
      symbol?: string; quarter?: string; Information?: string; Note?: string; "Error Message"?: string;
      transcript?: Array<{ speaker?: string; title?: string; content?: string }>;
    };
    const message = data.Information ?? data.Note ?? data["Error Message"];
    if (message) {
      if (/rate|limit|frequency|requests? per|(?:api )?call volume/i.test(message)) throw new TranscriptQuotaError("Alpha Vantage rate limit reached");
      if (/api.?key|premium|subscription|entitlement/i.test(message)) {
        const reason = message.replaceAll(this.apiKey, '[redacted]').replace(/https?:\/\/\S+/g, '[url]').slice(0,180);
        throw new TranscriptAccessError(`Alpha Vantage transcript access denied: ${reason}`);
      }
      throw new Error("Alpha Vantage transcript response error");
    }
    if (data.symbol !== ticker || data.quarter !== quarter) throw new Error("Alpha Vantage transcript company or fiscal quarter mismatch");
    if (!data.transcript?.length) return null;
    const text = data.transcript.map(turn => {
      if (typeof turn.content !== "string" || !turn.content.trim()) throw new Error("Alpha Vantage transcript contains an empty turn");
      const speaker = [turn.speaker, turn.title].filter(Boolean).join(" — ");
      return `${speaker ? `${speaker}: ` : ""}${turn.content.trim()}`;
    }).join("\n\n");
    if (text.length < 2000) return null;
    return { kind: "transcript", sourceKind: "transcript_api", text,
      title: `${ticker} Q${ref.quarter} FY${ref.fiscalYear} earnings call transcript`,
      url: citation.toString(), publishedAt: ref.date };
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
