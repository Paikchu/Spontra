/** Companies the homepage digest confirmed. A ticker outside this list is not opened. */
export type CatalogCompany = {
  ticker: string;
  name: string;
  nameZh: string | null;
  aliases: string[];
};

export type CatalogStatus = "loading" | "ready" | "error";

export type SearchRow =
  | { kind: "company"; ticker: string; name: string; nameZh: string | null; group: "recent" | "popular" | "match" }
  | { kind: "uncovered"; ticker: string }
  | { kind: "status"; status: "loading" | "invalid" | "empty" };

const TICKER = /^[A-Z][A-Z0-9.-]{0,11}$/;
const VALID = /^[\p{Script=Han}A-Za-z0-9 .&'-]+$/u;
const MAX = 8;

/** Only a confirmed company row may open a page. An uncovered row, a note, or nothing does not. */
export function tickerToOpen(row: SearchRow | undefined): string | null {
  return row?.kind === "company" ? row.ticker : null;
}

function companyRow(company: CatalogCompany, group: "recent" | "popular" | "match"): SearchRow {
  return { kind: "company", ticker: company.ticker, name: company.name, nameZh: company.nameZh, group };
}

function includes(value: string, query: string, queryUpper: string): boolean {
  return value.toUpperCase().includes(queryUpper) || value.includes(query);
}

function rank(company: CatalogCompany, query: string, queryUpper: string): number | null {
  const ticker = company.ticker.toUpperCase();
  if (ticker === queryUpper) return 0;
  if (queryUpper.length > 0 && ticker.startsWith(queryUpper)) return 1;
  const fields = [company.name, company.nameZh ?? "", ...company.aliases];
  if (query.length > 0 && fields.some(field => field && includes(field, query, queryUpper))) return 2;
  return null;
}

/**
 * Local filter over the covered catalog. While the catalog is still loading, a typed ticker is not
 * marked uncovered and is not opened. A failed catalog still refuses any ticker it has not confirmed.
 */
export function searchRows(raw: string, catalog: CatalogCompany[], recent: string[], popular: string[], status: CatalogStatus): SearchRow[] {
  const query = raw.trim();
  const queryUpper = query.toUpperCase();
  if (query && !VALID.test(query)) return [{ kind: "status", status: "invalid" }];

  const byTicker = new Map(catalog.map(company => [company.ticker, company]));
  const recentTickers = recent.filter(ticker => TICKER.test(ticker)).slice(0, 5);

  if (!query) {
    const recentCompanies = recentTickers
      .filter(ticker => status !== "ready" || byTicker.has(ticker))
      .map(ticker => byTicker.get(ticker) ?? { ticker, name: ticker, nameZh: null, aliases: [] });
    const rows: SearchRow[] = recentCompanies.map(company => companyRow(company, "recent"));
    if (status === "ready") {
      for (const ticker of popular) {
        if (rows.length >= 10) break;
        const company = byTicker.get(ticker);
        if (!company || rows.some(row => row.kind === "company" && row.ticker === company.ticker)) continue;
        rows.push(companyRow(company, "popular"));
      }
    }
    return rows;
  }

  if (status !== "ready") {
    const hits = recentTickers
      .filter(ticker => ticker.startsWith(queryUpper))
      .map(ticker => byTicker.get(ticker) ?? { ticker, name: ticker, nameZh: null, aliases: [] });
    const rows: SearchRow[] = hits.map(company => companyRow(company, "recent"));
    if (status === "loading") return [...rows, { kind: "status", status: "loading" }];
    if (TICKER.test(queryUpper) && !hits.some(company => company.ticker === queryUpper)) rows.push({ kind: "uncovered", ticker: queryUpper });
    else if (!rows.length) rows.push({ kind: "status", status: "empty" });
    return rows;
  }

  const ranked = catalog
    .map(company => ({ company, rank: rank(company, query, queryUpper) }))
    .filter((item): item is { company: CatalogCompany; rank: number } => item.rank != null)
    .sort((a, b) => a.rank - b.rank || a.company.ticker.localeCompare(b.company.ticker));
  const rows: SearchRow[] = ranked.slice(0, MAX).map(item => companyRow(item.company, "match"));
  const exact = ranked.some(item => item.company.ticker.toUpperCase() === queryUpper);
  if (TICKER.test(queryUpper) && !exact) rows.push({ kind: "uncovered", ticker: queryUpper });
  else if (!rows.length) rows.push({ kind: "status", status: "empty" });
  return rows;
}
