import { SEC_DOCUMENT_MAX_BYTES } from "../../../../shared/analysis-runtime/financial-data/limits.ts";
import type { SecReader } from "../financial-data/provider.ts";

/**
 * The one place Spontra Analysis talks to EDGAR (docs/sec-archive.md). Every request carries the SEC contact
 * user-agent, is paced, and may only go to EDGAR's two hosts. The module exports no raw reader: documents leave here
 * only through `archivingReader` (which stores what it downloads) and listings only through `edgarListings`.
 */
const HOSTS = new Set(["www.sec.gov", "data.sec.gov"]);
const DIRECTORY_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const COMPANY_FACTS_MAX_BYTES = 20_000_000;

export type GatewayOptions = { fetcher?: typeof fetch; delayMs?: number };

/** A paced EDGAR request: 403/429 is `SEC_ACCESS_PAUSED` (a wait, not a failure), any other error `SEC_SOURCE_UNAVAILABLE`. */
export function pacedEdgarRequest(userAgent: string, options: GatewayOptions = {}): (url: string, accept?: string, timeoutMs?: number) => Promise<Response> {
  if (!userAgent.trim()) throw new Error("SEC contact user-agent is required");
  const fetcher = options.fetcher ?? fetch, delayMs = options.delayMs ?? 500;
  let next = 0;
  return async (url, accept = "application/json,text/html", timeoutMs = 25_000) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !HOSTS.has(parsed.hostname)) throw new Error("Non-SEC source denied");
    const wait = Math.max(0, next - Date.now());
    next = Math.max(next, Date.now()) + delayMs;
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    const response = await fetcher(url, { headers: { "user-agent": userAgent, accept }, signal: AbortSignal.timeout(timeoutMs) });
    if ([403, 429].includes(response.status)) throw new Error("SEC_ACCESS_PAUSED");
    if (!response.ok) throw new Error("SEC_SOURCE_UNAVAILABLE");
    return response;
  };
}

/**
 * EDGAR's listings: what exists, never a filing's text. The issuer directory, a company's submission list and its
 * continuation pages, its XBRL Company Facts, a filing's index page and an ownership form's XML.
 */
export type EdgarListings = {
  issuerDirectory(): Promise<unknown>;
  /** The submission list, or one of its continuation pages (`CIK##########-submissions-001.json`). */
  submissions(cik: string, page?: string): Promise<unknown>;
  companyFacts(cik: string): Promise<unknown>;
  /** The filing index page (`<accession>-index.htm`) as HTML. */
  filingIndex(cikNumber: number, accession: string): Promise<string>;
  /** A Form 3/4/5 XML document, by the URL the submission list names. */
  ownershipXml(url: string): Promise<string>;
};

export function edgarListingsFor(userAgent: string, options: GatewayOptions = {}): EdgarListings {
  return listingsFrom(pacedEdgarRequest(userAgent, options));
}

function listingsFrom(request: ReturnType<typeof pacedEdgarRequest>): EdgarListings {
  const submissions = (cik: string, page?: string) => {
    const padded = String(cik).replace(/\D/g, "").padStart(10, "0");
    if (page !== undefined && !new RegExp(`^CIK${padded}-submissions-\\d{3}\\.json$`).test(page)) throw new Error("Invalid submissions page");
    return request(`https://data.sec.gov/submissions/${page ?? `CIK${padded}.json`}`).then(r => r.json());
  };
  return {
    issuerDirectory: () => request(DIRECTORY_URL).then(r => r.json()),
    submissions,
    companyFacts: async (cik) => {
      const padded = String(cik).replace(/\D/g, "").padStart(10, "0");
      const response = await request(`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`, "application/json", 30_000);
      if (Number(response.headers.get("content-length") ?? 0) > COMPANY_FACTS_MAX_BYTES) throw new Error("SEC Company Facts payload exceeds 20 MB");
      return response.json();
    },
    filingIndex: (cikNumber, accession) => request(`${archiveRoot(cikNumber, accession)}/${accession}-index.htm`, "text/html").then(r => r.text()),
    ownershipXml: async (url) => {
      if (!/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/[A-Za-z0-9_.-]+\.xml$/.test(url)) throw new Error("Non-SEC source denied");
      return (await request(url, "application/xml,text/xml")).text();
    },
  };
}

/** A filing's folder on EDGAR. */
export const archiveRoot = (cikNumber: number, accession: string) => `https://www.sec.gov/Archives/edgar/data/${cikNumber}/${accession.replaceAll("-", "")}`;

/**
 * The document side of the gateway: a `SecReader` whose `read` downloads filing documents, bounded to the largest
 * document the archive accepts. Only `archive.ts` builds one, and only inside a reader that archives what it reads.
 */
export function edgarDocumentReader(userAgent: string, options: GatewayOptions = {}): SecReader {
  // One pacer for documents and listings alike: SEC's fair-access limit is per client, not per kind of request.
  const request = pacedEdgarRequest(userAgent, options);
  const listings = listingsFrom(request);
  return {
    read: async (url) => {
      const response = await request(url, "text/html,application/xhtml+xml,text/plain,*/*");
      if (Number(response.headers.get("content-length")) > SEC_DOCUMENT_MAX_BYTES) throw new Error("SEC_DOCUMENT_TOO_LARGE");
      return response;
    },
    submissions: listings.submissions,
    issuerDirectory: listings.issuerDirectory,
  };
}
