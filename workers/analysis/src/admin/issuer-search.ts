import type { SecReader } from '../financial-data/provider.ts';
import { D1SecRepository } from '../sec/d1.ts';
import type { IssuerSuggestion } from '../../../../shared/analysis-contract/business-map-admin.ts';

/** One issuer of EDGAR's exchange directory, kept as a tuple: the directory holds ten thousand of them. */
export type IssuerEntry = [ticker: string, name: string, exchange: string];
const CACHE_KEY = 'admin:issuer-directory:v1';
const DIRECTORY_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
const FRESH_MS = 24 * 3600_000;
/** The directory parsed once per isolate; D1 holds it across isolates. */
let memory: { fetchedAt: string; entries: IssuerEntry[] } | null = null;

export function parseIssuerDirectory(raw: unknown): IssuerEntry[] {
  const directory = raw as { fields?: unknown; data?: unknown };
  if (!Array.isArray(directory.fields) || !Array.isArray(directory.data)) throw new Error('Invalid SEC issuer directory');
  const ticker = directory.fields.indexOf('ticker'), name = directory.fields.indexOf('name'), exchange = directory.fields.indexOf('exchange');
  if (ticker < 0 || name < 0) throw new Error('Invalid SEC issuer directory');
  const entries: IssuerEntry[] = [];
  for (const row of directory.data as unknown[][]) {
    const symbol = String(row[ticker] ?? '').trim().toUpperCase().replaceAll('-', '.');
    if (!symbol) continue;
    entries.push([symbol, String(row[name] ?? '').trim(), exchange < 0 ? '' : String(row[exchange] ?? '').trim()]);
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
