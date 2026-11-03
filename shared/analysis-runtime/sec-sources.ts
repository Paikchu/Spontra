/**
 * Every SEC EDGAR address in one place: the hosts filings and data are read from, the files and APIs read there, and
 * the two questions asked of a stored address — is it an SEC source, and which issuer's archive is it in.
 */

/** The domain every SEC host sits under, as a search filter takes it. */
export const SEC_DOMAIN = "sec.gov";
const SEC_WWW = `https://www.${SEC_DOMAIN}`;
const SEC_DATA = `https://data.${SEC_DOMAIN}`;

/** EDGAR's directory of exchange-listed issuers: CIK, name, ticker and exchange per share class. */
export const SEC_EXCHANGE_DIRECTORY_URL = `${SEC_WWW}/files/company_tickers_exchange.json`;
/** EDGAR's directory of every issuer with a ticker, listed or not. */
export const SEC_TICKERS_URL = `${SEC_WWW}/files/company_tickers.json`;

const paddedCik = (cik: string | number) => String(cik).replace(/\D/g, "").padStart(10, "0");
/** An issuer's submissions (filing index and company facts such as its fiscal-year end). */
export const secSubmissionsUrl = (cik: string | number) => `${SEC_DATA}/submissions/CIK${paddedCik(cik)}.json`;
/** An older page of an issuer's submissions, named by the submissions file's `files[].name`. */
export const secSubmissionsPageUrl = (name: string) => `${SEC_DATA}/submissions/${name}`;
/** Every XBRL fact an issuer has filed. */
export const secCompanyFactsUrl = (cik: string | number) => `${SEC_DATA}/api/xbrl/companyfacts/CIK${paddedCik(cik)}.json`;
/** EDGAR full-text search for a query such as an accession number. */
export const edgarSearchUrl = (query: string) => `${SEC_WWW}/edgar/search/#/q=${encodeURIComponent(query)}`;

/** An accession's archive directory, without a trailing slash. CIKs in archive paths are unpadded. */
export function secArchiveRoot(cikNumber: number, accessionNumber: string): string {
  return `${SEC_WWW}/Archives/edgar/data/${cikNumber}/${accessionNumber.replaceAll("-", "")}`;
}

/** Join a primary document (including rendering subdirectories), accepting its accession prefix once. */
export function secArchiveDocumentUrl(archiveRoot: string, primaryDocument: string): string {
  const accession = /\/(\d+)$/.exec(archiveRoot)?.[1];
  const relative = accession && primaryDocument.startsWith(`${accession}/`)
    ? primaryDocument.slice(accession.length + 1) : primaryDocument;
  // Keep the caller's encoding and suffix intact; URL resolution would reinterpret relative paths.
  return `${archiveRoot}/${relative}`;
}

/** Split at the accession boundary, rather than guessing from the last one or two slashes. */
export function parseSecArchiveDocumentUrl(documentUrl: string): { archiveRoot: string; primaryDocument: string } {
  const match = /^(https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+)\/(.+)$/.exec(documentUrl);
  if (!match) throw new Error("Invalid SEC archive document URL");
  return { archiveRoot: match[1]!, primaryDocument: match[2]! };
}

function secHttps(value: string): URL | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && !url.port && (host === SEC_DOMAIN || host.endsWith(`.${SEC_DOMAIN}`)) ? url : null;
  } catch { return null; }
}

/** An https address on sec.gov or any of its hosts, with no credentials or port. */
export function isSecUrl(value: string): boolean {
  return secHttps(value) !== null;
}

/** The CIK whose EDGAR archive holds this document, or null for any other address. */
export function edgarArchiveCik(value: string): number | null {
  const url = secHttps(value);
  if (!url || ![SEC_DOMAIN, `www.${SEC_DOMAIN}`].includes(url.hostname.toLowerCase())) return null;
  const cik = /^\/Archives\/edgar\/data\/(\d{1,10})\//.exec(url.pathname)?.[1];
  return cik ? Number(cik) : null;
}
