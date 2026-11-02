import type { SecReader } from '../financial-data/provider.ts';
import { D1SecRepository } from '../sec/d1.ts';
import type { IssuerSuggestion } from '../../../../shared/analysis-contract/business-map-admin.ts';
import { canonicalTicker, TICKER_PATTERN } from '../../../../shared/analysis-runtime/financial-data/policy.ts';

/**
 * EDGAR's exchange directory: every listed symbol with its issuer's name, exchange and CIK. It is the one source for
 * which company a ticker names, what the company is called, and which of its share classes the data is kept under,
 * so no company is listed in code. SEC discovery and the admin's issuer search read it from SEC at most once a day;
 * everything else reads the stored copy and never reaches SEC.
 */
export type IssuerEntry = [ticker: string, name: string, exchange: string, cik: string];
const CACHE_KEY = 'catalog:issuer-directory:v2';
const DIRECTORY_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
const FRESH_MS = 24 * 3600_000;
/** The directory parsed once per isolate; D1 holds it across isolates. */
let memory: { fetchedAt: string; entries: IssuerEntry[] } | null = null;

export function parseIssuerDirectory(raw: unknown): IssuerEntry[] {
  const directory = raw as { fields?: unknown; data?: unknown };
  if (!Array.isArray(directory.fields) || !Array.isArray(directory.data)) throw new Error('Invalid SEC issuer directory');
  const ticker = directory.fields.indexOf('ticker'), name = directory.fields.indexOf('name'), exchange = directory.fields.indexOf('exchange'), cik = directory.fields.indexOf('cik');
  if (ticker < 0 || name < 0) throw new Error('Invalid SEC issuer directory');
  const entries: IssuerEntry[] = [];
  for (const row of directory.data as unknown[][]) {
    const symbol = canonicalTicker(String(row[ticker] ?? ''));
    if (!symbol) continue;
    const id = cik < 0 ? '' : String(row[cik] ?? '').trim();
    entries.push([symbol, String(row[name] ?? '').trim(), exchange < 0 ? '' : String(row[exchange] ?? '').trim(), /^\d{1,10}$/.test(id) && Number(id) > 0 ? id.padStart(10, '0') : '']);
  }
  return entries;
}

/**
 * The exchange directory, read from SEC at most once a day and kept in `sec_cache`; when SEC cannot be read, the last
 * copy serves however old it is, and only a first read with no copy at all fails.
 */
export async function issuerDirectory(db: D1Database, reader: SecReader, now = new Date()): Promise<IssuerEntry[]> {
  const fresh = (fetchedAt: string) => now.getTime() - Date.parse(fetchedAt) < FRESH_MS;
  if (memory && fresh(memory.fetchedAt)) return memory.entries;
  const repository = new D1SecRepository(db);
  const stored = await repository.getCache<IssuerEntry[]>(CACHE_KEY).catch(() => null);
  if (stored && fresh(stored.fetchedAt)) { memory = { fetchedAt: stored.fetchedAt, entries: stored.payload }; return stored.payload; }
  try {
    const entries = parseIssuerDirectory(await (await reader.read(DIRECTORY_URL)).json());
    const fetchedAt = now.toISOString();
    await repository.setCache(CACHE_KEY, entries, fetchedAt).catch(() => undefined);
    memory = { fetchedAt, entries };
    return entries;
  } catch (error) {
    if (stored) return stored.payload;
    if (memory) return memory.entries;
    throw error;
  }
}

/** The stored directory without reaching SEC: this isolate's copy while fresh, else D1's; empty before SEC was first read. */
/** Where a stored directory is read from: the database, or a repository over it. */
export type CacheSource = D1Database | Pick<D1SecRepository, 'getCache'>;
const cacheOf = (source: CacheSource) => 'getCache' in source ? source : new D1SecRepository(source);

export async function storedIssuerDirectory(db: CacheSource, now = new Date()): Promise<IssuerEntry[]> {
  if (memory && now.getTime() - Date.parse(memory.fetchedAt) < FRESH_MS) return memory.entries;
  const stored = await cacheOf(db).getCache<IssuerEntry[]>(CACHE_KEY).catch(() => null);
  if (stored && (!memory || stored.fetchedAt > memory.fetchedAt)) memory = { fetchedAt: stored.fetchedAt, entries: stored.payload };
  return memory?.entries ?? [];
}

type DirectoryIndex = { byTicker: Map<string, IssuerEntry>; primary: Map<string, string> };
const indexes = new WeakMap<IssuerEntry[], DirectoryIndex>();
/** Each symbol's entry, and each issuer's first-listed symbol: EDGAR lists an issuer's primary class first. */
function indexOf(entries: IssuerEntry[]): DirectoryIndex {
  let index = indexes.get(entries);
  if (index) return index;
  index = { byTicker: new Map(), primary: new Map() };
  for (const entry of entries) {
    if (!index.byTicker.has(entry[0])) index.byTicker.set(entry[0], entry);
    if (entry[3] && !index.primary.has(entry[3])) index.primary.set(entry[3], entry[0]);
  }
  indexes.set(entries, index);
  return index;
}

/** The directory's entry for a ticker, or null when EDGAR lists no issuer under it (or the directory was never read). */
function listedIssuer(entries: IssuerEntry[], ticker: string): IssuerEntry | null {
  return indexOf(entries).byTicker.get(canonicalTicker(ticker)) ?? null;
}

/**
 * The ticker a company's data is kept under: a second share class (GOOG beside GOOGL, BRK.A beside BRK.B) reads as the
 * class EDGAR lists first for the same issuer. A ticker the directory does not know stays as it is.
 */
export function primaryTicker(entries: IssuerEntry[], ticker: string): string {
  const normalized = canonicalTicker(ticker), entry = indexOf(entries).byTicker.get(normalized);
  return entry?.[3] ? indexOf(entries).primary.get(entry[3]) ?? normalized : normalized;
}

/**
 * Nasdaq Trader's symbol directory: every US-listed symbol with its listing title as the company writes it
 * ("Microsoft Corporation - Common Stock", where EDGAR keeps "MICROSOFT CORP") and whether it is an ETF. It names
 * companies for readers and prompts; EDGAR's directory stays the source of which issuer a ticker is.
 */
export type ListingEntry = [symbol: string, title: string, etf: boolean];
const LISTINGS_KEY = 'catalog:listings:v1';
const LISTINGS_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt';
let listingMemory: { fetchedAt: string; entries: ListingEntry[] } | null = null;

export function parseListings(text: string): ListingEntry[] {
  const [header, ...rows] = text.split(/\r?\n/);
  const fields = (header ?? '').split('|');
  const symbol = fields.indexOf('Symbol'), title = fields.indexOf('Security Name'), etf = fields.indexOf('ETF'), testIssue = fields.indexOf('Test Issue');
  if (symbol < 0 || title < 0 || etf < 0) throw new Error('Invalid listing directory');
  const entries: ListingEntry[] = [];
  for (const row of rows) {
    const cells = row.split('|');
    const ticker = canonicalTicker(cells[symbol] ?? ''), name = (cells[title] ?? '').trim();
    if (!TICKER_PATTERN.test(ticker) || !name || cells[testIssue] === 'Y') continue;
    entries.push([ticker, name, cells[etf] === 'Y']);
  }
  if (entries.length < 1000) throw new Error('Invalid listing directory');
  return entries;
}

/** Reads the listing directory again when the stored copy is a day old; a failed read keeps the stored copy. */
export async function refreshListings(db: D1Database, fetcher: typeof fetch = fetch, now = new Date()): Promise<void> {
  if (listingMemory && now.getTime() - Date.parse(listingMemory.fetchedAt) < FRESH_MS) return;
  const repository = new D1SecRepository(db);
  const stored = await repository.getCache<ListingEntry[]>(LISTINGS_KEY).catch(() => null);
  if (stored && now.getTime() - Date.parse(stored.fetchedAt) < FRESH_MS) return;
  const response = await fetcher(LISTINGS_URL, { headers: { accept: 'text/plain' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`LISTINGS_UNAVAILABLE_${response.status}`);
  const entries = parseListings(await response.text()), fetchedAt = now.toISOString();
  await repository.setCache(LISTINGS_KEY, entries, fetchedAt);
  listingMemory = { fetchedAt, entries };
}

async function storedListings(db: CacheSource, now = new Date()): Promise<ListingEntry[]> {
  if (listingMemory && now.getTime() - Date.parse(listingMemory.fetchedAt) < FRESH_MS) return listingMemory.entries;
  const stored = await cacheOf(db).getCache<ListingEntry[]>(LISTINGS_KEY).catch(() => null);
  if (stored && (!listingMemory || stored.fetchedAt > listingMemory.fetchedAt)) listingMemory = { fetchedAt: stored.fetchedAt, entries: stored.payload };
  return listingMemory?.entries ?? [];
}
const listingIndexes = new WeakMap<ListingEntry[], Map<string, ListingEntry>>();
function listing(entries: ListingEntry[], ticker: string): ListingEntry | null {
  let index = listingIndexes.get(entries);
  if (!index) { index = new Map(entries.map(e => [e[0], e])); listingIndexes.set(entries, index); }
  return index.get(canonicalTicker(ticker)) ?? null;
}

/** A listing title without its share-class wording: "Alphabet Inc. - Class A Common Stock" reads "Alphabet Inc.". */
export function issuerFromTitle(title: string): string {
  return title.replace(/\s+-\s+.*$/, '').replace(/\s+(?:New\s+)?(?:Class\s+[A-Z]\s+)?(?:Common Stock|Capital Stock|Ordinary Shares|American Depositary Shares?|Depositary Shares?)\b.*$/i, '').trim() || title.trim();
}

export type Security = { name: string; etf: boolean };
/**
 * What tickers are listed as, read once for many lookups: the company's name (listing title first, EDGAR's name after)
 * and whether it is an ETF; null when neither directory lists the ticker.
 */
export async function securities(db: CacheSource): Promise<(ticker: string) => Security | null> {
  const [listings, issuers] = await Promise.all([storedListings(db).catch(() => []), storedIssuerDirectory(db).catch(() => [])]);
  return ticker => {
    const listed = listing(listings, ticker), issuer = listedIssuer(issuers, ticker);
    if (listed) return { name: issuerFromTitle(listed[1]), etf: listed[2] };
    return issuer?.[1] ? { name: issuer[1], etf: false } : null;
  };
}

/** The company's name for readers and prompts, or null; callers fall back to the ticker. */
export async function companyName(db: CacheSource, ticker: string): Promise<string | null> {
  return (await securities(db))(ticker)?.name ?? null;
}

/**
 * The issuers a typed fragment names, best first: the ticker itself, then tickers and names starting with it, then
 * names with a later word starting with it, then names containing it, then tickers containing it. A name's start
 * ranks with a ticker prefix because the directory holds ten thousand issuers: "app" must still reach Apple past
 * AppLovin and AppFolio. Ties go to the shorter ticker, so a common prefix lists the plain share class before its
 * units and warrants.
 */
export function searchIssuers(entries: IssuerEntry[], query: string, limit = 10): IssuerSuggestion[] {
  const text = query.trim().toUpperCase().replaceAll('-', '.');
  if (!text) return [];
  const words = new RegExp(`(^|[^A-Z0-9])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const ranked: Array<{ rank: number; entry: IssuerEntry }> = [];
  for (const entry of entries) {
    const [ticker, name] = entry, upper = name.toUpperCase();
    const rank = ticker === text ? 0 : ticker.startsWith(text) || upper.startsWith(text) ? 1 : words.test(upper) ? 2 : upper.includes(text) ? 3 : ticker.includes(text) ? 4 : -1;
    if (rank >= 0) ranked.push({ rank, entry });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.entry[0].length - b.entry[0].length || a.entry[0].localeCompare(b.entry[0]));
  return ranked.slice(0, limit).map(({ entry: [ticker, name, exchange] }) => ({ ticker, name, exchange }));
}
