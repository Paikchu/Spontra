import { companyName } from "../catalog/security-directory.ts";
import { shownFilter, type FeatureDefaultsEnv } from "../admin/feature-settings.ts";
import { flowForIssuer } from "../financial-data/publication.ts";
import { historyForIssuer } from "../financial-data/history.ts";
import type { PublicBusinessFlow } from "../../../../shared/analysis-contract/business-flow.ts";
import type { FindingsPublication } from "../../../../shared/analysis-contract/findings.ts";
import type { HomeCompany, HomeDigest, HomeFinding, HomeRevenueReason } from "../../../../shared/analysis-contract/home.ts";
import type { RevenueHistory } from "../../../../shared/analysis-contract/revenue-history.ts";
import { checkCompleteFlow, newestPair } from "../../../../shared/analysis-runtime/financial-data/completeness.ts";
import { publicFlowSchema } from "../../../../shared/analysis-runtime/financial-data/schema.ts";
import { readHistory } from "../../../../shared/analysis-runtime/financial-data/history.ts";
import { canonicalTicker, dataTickers as listedDataTickers, TICKER_PATTERN } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import { readFindingsPublication } from "../../../../shared/analysis-runtime/findings.ts";
import type { Locale } from "../../../../shared/analysis-runtime/locale.ts";
import { calendarLabel } from "../../../../shared/analysis-runtime/fiscal-label.ts";
import { localize, type TranslationTable } from "../../../../shared/analysis-runtime/translation.ts";
import { fiscalFields, readFiscalFocus } from "./fiscal-periods.ts";

/**
 * Popular: the covered companies with findings, the freshest filing first, then the rest the same way.
 * 【假设】Chinese names, extra aliases and sectors are not in the filings. Leave a ticker out
 * and the page searches its English name only, and hides the sector filter while every sector is null.
 * `fiscalLabel` / `calendarLabel` stay the calendar quarter of the period end (2026-07-26 → "2026 Q3") for older clients.
 * `fiscalYear` / `fiscalQuarter` are the issuer's own quarter, from the fiscal-year-end month and any cached DEI focus.
 * 【假设】Amounts stay in the filing currency. No exchange rate is applied.
 */
export type HomeCatalogNote = { nameZh?: string; aliases?: string[]; sector?: string };
export const HOME_CATALOG_NOTES: Record<string, HomeCatalogNote> = {};

const MAX_COMPANIES = 40;
const NAME_STOP = new Set(["INC", "INCORPORATED", "CORPORATION", "CORP", "LTD", "LIMITED", "PLC", "GROUP", "COMPANY", "HOLDINGS", "THE", "AND", "CLASS", "COMMON", "STOCK", "SHARES", "NV", "SA", "AG", "CO"]);

export type HomeDigestEnv = FeatureDefaultsEnv & { SEC_DATA_TICKERS?: string };

type Point = { periodEnd: string; value: number; currency: string; filedAt: string | null };

/** Calendar quarter of a period end. Older clients still read this; the page labels the issuer quarter. */
export function fiscalLabel(periodEnd: string): string {
  return calendarLabel(periodEnd);
}

function baseDecimal(value: string, scale: number): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isFinite(scale) || scale <= 0) return null;
  const product = n * scale;
  if (!Number.isFinite(product)) return null;
  const rounded = Math.round(product * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function changePct(current: number, prior: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(prior) || prior === 0) return null;
  return Math.round(((current - prior) / Math.abs(prior)) * 1000) / 10;
}

function later(a: string | null, b: string | null): string | null {
  if (!a || !Number.isFinite(Date.parse(a))) return b && Number.isFinite(Date.parse(b)) ? b : null;
  if (!b || !Number.isFinite(Date.parse(b))) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function aliasesFrom(name: string, ticker: string, extra: string[]): string[] {
  const words = name.toUpperCase().split(/[^A-Z0-9]+/).filter(word => word.length >= 3 && !NAME_STOP.has(word));
  const out: string[] = [];
  for (const word of [...words, ...extra.map(alias => alias.trim().toUpperCase())]) {
    if (word && word !== ticker && word.length <= 40 && !out.includes(word)) out.push(word);
  }
  return out.slice(0, 12);
}

function jsonRow(payload: string): unknown {
  try { return JSON.parse(payload) as unknown; } catch { return null; }
}

function issuerName(payload: string | undefined): string | null {
  const parsed = payload ? jsonRow(payload) : null;
  const name = parsed && typeof parsed === "object" && "name" in parsed ? (parsed as { name?: unknown }).name : null;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function flowOf(payload: string, ticker: string, cik: string | null): PublicBusinessFlow | null {
  const parsed = publicFlowSchema.safeParse(jsonRow(payload));
  if (!parsed.success) return null;
  const candidate = checkCompleteFlow(parsed.data).complete ? parsed.data : newestPair(parsed.data);
  if (!checkCompleteFlow(candidate).complete) return null;
  if (candidate.ticker === ticker) return candidate;
  return cik ? flowForIssuer(candidate, cik, ticker) : null;
}

function historyOf(payload: string | undefined, ticker: string, cik: string | null): RevenueHistory | null {
  if (!payload) return null;
  const raw = jsonRow(payload);
  return readHistory(raw, ticker) ?? (cik ? historyForIssuer(raw, cik, ticker) : null);
}

/** Revenue, cost of revenue and net income of one quarter, as the home row draws them; null without revenue and net. */
function statementOf(quarter: PublicBusinessFlow["quarters"][number]): HomeCompany["statement"] {
  const figure = (key: "revenue" | "cost" | "net") => { const raw = quarter.figures[key]?.value; return raw == null ? null : baseDecimal(raw, quarter.scale); };
  const revenue = figure("revenue"), net = figure("net");
  if (revenue == null || net == null || !(Number(revenue) > 0)) return null;
  return { currency: quarter.currency, revenue, cost: figure("cost"), net };
}

type MarginRow = { ticker: string; periodEnd: string | null; currency: string | null; revenue: string | number | null; operating: string | number | null };
const marginPct = (row: Pick<MarginRow, "revenue" | "operating">) => {
  const revenue = Number(row.revenue), operating = Number(row.operating);
  return row.revenue != null && row.operating != null && Number.isFinite(revenue) && Number.isFinite(operating) && revenue > 0 ? Math.round(operating / revenue * 10_000) / 100 : null;
};

/** The latest quarter's operating margin and the year-ago quarter's (365 days back, 20 days either way), same currency. */
function operatingMarginOf(latest: PublicBusinessFlow["quarters"][number], rows: MarginRow[]): HomeCompany["operatingMargin"] {
  const pct = marginPct({ revenue: latest.figures.revenue?.value ?? null, operating: latest.figures.operating?.value ?? null });
  if (pct == null) return null;
  const target = Date.parse(latest.periodEnd) - 365 * 86_400_000;
  const yearAgo = rows.filter(row => row.periodEnd && row.currency === latest.currency && Math.abs(Date.parse(row.periodEnd) - target) <= 20 * 86_400_000 && marginPct(row) != null)
    .sort((a, b) => Math.abs(Date.parse(a.periodEnd!) - target) - Math.abs(Date.parse(b.periodEnd!) - target))[0];
  return { pct, yearAgoPct: yearAgo ? marginPct(yearAgo) : null };
}

function pointsOf(flow: PublicBusinessFlow | null, history: RevenueHistory | null): Point[] {
  const byEnd = new Map<string, Point>();
  for (const quarter of history?.quarters ?? []) {
    const value = baseDecimal(quarter.revenue, quarter.scale);
    if (value == null) continue;
    byEnd.set(quarter.periodEnd, { periodEnd: quarter.periodEnd, value: Number(value), currency: quarter.currency, filedAt: quarter.source.filedAt });
  }
  for (const quarter of flow?.quarters ?? []) {
    const raw = quarter.figures.revenue?.value;
    if (raw == null) continue;
    const value = baseDecimal(raw, quarter.scale);
    if (value == null) continue;
    byEnd.set(quarter.periodEnd, { periodEnd: quarter.periodEnd, value: Number(value), currency: quarter.currency, filedAt: quarter.reportedAt?.slice(0, 10) ?? byEnd.get(quarter.periodEnd)?.filedAt ?? null });
  }
  return [...byEnd.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

function prior(points: Point[], latest: Point, targetDays: number, slackDays: number): Point | null {
  const target = Date.parse(latest.periodEnd) - targetDays * 86_400_000;
  let best: Point | null = null;
  let bestDist = Infinity;
  for (const point of points) {
    if (point.periodEnd === latest.periodEnd || point.currency !== latest.currency) continue;
    const dist = Math.abs(Date.parse(point.periodEnd) - target);
    if (dist < bestDist) { best = point; bestDist = dist; }
  }
  return best && bestDist <= slackDays * 86_400_000 ? best : null;
}

function findingsOf(raw: unknown, ticker: string, table: TranslationTable | null): FindingsPublication | null {
  const publication = raw ? readFindingsPublication(raw, ticker) : null;
  return publication ? localize("findings", publication, table) : null;
}

function projectFindings(publication: FindingsPublication | null): { counts: HomeCompany["findingCounts"]; top: HomeFinding[] } {
  const counts = { risk: 0, strength: 0, shift: 0, watch: 0 };
  if (!publication) return { counts, top: [] };
  for (const finding of publication.findings) counts[finding.kind] += 1;
  const top = [...publication.findings]
    .sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id))
    .slice(0, 2)
    .map(finding => ({ id: finding.id, kind: finding.kind, severity: finding.severity, title: finding.title, periodEnd: publication.periodEnd }));
  return { counts, top };
}

function dataTickers(env: HomeDigestEnv, rows: Array<{ ticker: string; enabled: number }>): Set<string> {
  let enabled: Set<string>;
  try { enabled = listedDataTickers(env); }
  catch { enabled = new Set(); }
  for (const row of rows) {
    const ticker = canonicalTicker(row.ticker);
    if (!TICKER_PATTERN.test(ticker)) continue;
    if (row.enabled) enabled.add(ticker);
    else enabled.delete(ticker);
  }
  return enabled;
}

/**
 * Covered companies for the public homepage, from publications already stored.
 * Read-only: no model call, no SEC fetch, no write.
 */
export async function readHomeDigest(db: D1Database, env: HomeDigestEnv, locale: Locale | null, now = new Date(), notes: Record<string, HomeCatalogNote> = HOME_CATALOG_NOTES): Promise<HomeDigest> {
  const [publications, histories, findings, issuers, settings, translations, findingsShown, focus, reportFigures] = await Promise.all([
    db.prepare(`SELECT v.ticker ticker, v.cik cik, v.payload_json payload, v.published_at publishedAt
      FROM financial_complete_current c JOIN financial_complete_versions v ON v.version_id = c.version_id`).all<{ ticker: string; cik: string; payload: string; publishedAt: string }>(),
    db.prepare(`SELECT cache_key, payload FROM sec_cache WHERE cache_key >= 'sec:revenue-history:v1:' AND cache_key < 'sec:revenue-history:v1;'`).all<{ cache_key: string; payload: string }>(),
    db.prepare(`SELECT substr(cache_key, 13) ticker, payload FROM sec_cache WHERE cache_key >= 'findings:v2:' AND cache_key < 'findings:v2;'`).all<{ ticker: string; payload: string }>(),
    db.prepare(`SELECT substr(cache_key, 24) ticker, payload FROM sec_cache WHERE cache_key >= 'admin:financial-issuer:' AND cache_key < 'admin:financial-issuer;'`).all<{ ticker: string; payload: string }>(),
    db.prepare(`SELECT ticker, enabled FROM financial_company_settings`).all<{ ticker: string; enabled: number }>().catch(() => ({ results: [] as Array<{ ticker: string; enabled: number }> })),
    locale ? db.prepare(`SELECT cache_key, payload FROM sec_cache WHERE cache_key >= ? AND cache_key < ?`).bind(`i18n:v1:${locale}:findings:`, `i18n:v1:${locale}:findings;`).all<{ cache_key: string; payload: string }>() : Promise.resolve({ results: [] as Array<{ cache_key: string; payload: string }> }),
    shownFilter(db, env, "findings"),
    readFiscalFocus(db),
    // The older quarters assembled behind each publication, only the figures an operating margin needs.
    db.prepare(`SELECT substr(c.cache_key, 20) ticker, json_extract(q.value, '$.periodEnd') periodEnd, json_extract(q.value, '$.currency') currency,
        json_extract(q.value, '$.figures.revenue.value') revenue, json_extract(q.value, '$.figures.operating.value') operating
      FROM sec_cache c, json_each(c.payload, '$.reports.quarters') q
      WHERE c.cache_key >= 'sec:map-derived:v1:' AND c.cache_key < 'sec:map-derived:v1;' AND json_valid(c.payload)`)
      .all<MarginRow>().catch(() => ({ results: [] as MarginRow[] })),
  ]);
  const marginRows = new Map<string, MarginRow[]>();
  for (const row of reportFigures.results) { const ticker = canonicalTicker(row.ticker); marginRows.set(ticker, [...marginRows.get(ticker) ?? [], row]); }

  const historyByCik = new Map(histories.results.map(row => [row.cache_key.slice("sec:revenue-history:v1:".length), row.payload]));
  const findingsByTicker = new Map(findings.results.map(row => [canonicalTicker(row.ticker), jsonRow(row.payload)]));
  const issuerByTicker = new Map(issuers.results.map(row => [canonicalTicker(row.ticker), row.payload]));
  const translationPrefix = locale ? `i18n:v1:${locale}:findings:` : "";
  const translationByTicker = new Map<string, TranslationTable>();
  for (const row of translations.results) {
    const parsed = jsonRow(row.payload) as { strings?: unknown } | null;
    const strings = parsed?.strings;
    if (!strings || typeof strings !== "object") continue;
    const table: Record<string, string> = {};
    for (const [key, value] of Object.entries(strings)) if (typeof value === "string") table[key] = value;
    if (Object.keys(table).length) translationByTicker.set(canonicalTicker(row.cache_key.slice(translationPrefix.length)), table);
  }

  const enabled = dataTickers(env, settings.results);
  const seen = new Set<string>();
  let damaged = false;
  let lastUpdatedAt: string | null = null;
  const companies: HomeCompany[] = [];

  const consider = (ticker: string, cik: string | null, payload: string | null, publishedAt: string | null) => {
    const canonical = canonicalTicker(ticker);
    if (!TICKER_PATTERN.test(canonical) || seen.has(canonical)) return;
    seen.add(canonical);
    let flow: PublicBusinessFlow | null = null;
    if (payload) {
      flow = flowOf(payload, canonical, cik);
      if (!flow) damaged = true;
    }
    if (!flow && !enabled.has(canonical)) return;
    const history = historyOf(cik ? historyByCik.get(cik) : undefined, canonical, cik);
    const points = pointsOf(flow, history).filter((point, _, all) => !flow || point.currency === (all.at(-1)?.currency ?? point.currency));
    const latest = points.at(-1) ?? null;
    const flowLatest = flow ? [...flow.quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0] : null;
    const periodEnd = flowLatest?.periodEnd ?? latest?.periodEnd ?? null;
    const note = notes[canonical];
    const name = companyName(canonical) ?? issuerName(issuerByTicker.get(canonical)) ?? canonical;
    const shown = findingsShown(canonical);
    const publication = shown ? findingsOf(findingsByTicker.get(canonical), canonical, translationByTicker.get(canonical) ?? null) : null;
    const { counts, top } = projectFindings(publication);
    let revenueReason: HomeRevenueReason | null = null;
    let revenue: HomeCompany["revenue"] = null;
    if (latest && periodEnd) {
      const yoy = prior(points, latest, 365, 20);
      const qoq = prior(points, latest, 91, 25);
      revenue = { value: baseDecimal(String(latest.value), 1)!, currency: latest.currency, yoyPct: yoy ? changePct(latest.value, yoy.value) : null, qoqPct: qoq ? changePct(latest.value, qoq.value) : null };
      if (revenue.yoyPct == null) revenueReason = "MISSING_TWO_QUARTERS";
    } else if (flow) {
      revenueReason = "NOT_DISCLOSED";
    }
    const trend = points.slice(-8).map(point => ({ periodEnd: point.periodEnd, value: baseDecimal(String(point.value), 1)! }));
    const statement = flowLatest ? statementOf(flowLatest) : null;
    const operatingMargin = flowLatest ? operatingMarginOf(flowLatest, [...(marginRows.get(canonical) ?? []), ...(flow?.quarters ?? []).map(q => ({ ticker: canonical, periodEnd: q.periodEnd, currency: q.currency, revenue: q.figures.revenue?.value ?? null, operating: q.figures.operating?.value ?? null }))]) : null;
    lastUpdatedAt = later(lastUpdatedAt, later(publishedAt, history?.updatedAt ?? null));
    companies.push({
      ticker: canonical,
      name,
      nameZh: note?.nameZh?.trim() || null,
      aliases: aliasesFrom(name, canonical, note?.aliases ?? []),
      sector: note?.sector ?? null,
      status: flow ? (revenue ? "ready" : "partial") : "preparing",
      latestPeriod: periodEnd ? { periodEnd, periodStart: flowLatest?.periodStart ?? null, fiscalLabel: fiscalLabel(periodEnd), calendarLabel: fiscalLabel(periodEnd), filedAt: flowLatest?.reportedAt?.slice(0, 10) ?? latest?.filedAt ?? null, ...fiscalFields(canonical, periodEnd, focus) } : null,
      revenue,
      revenueReason,
      revenueTrend: trend,
      statement,
      operatingMargin,
      findingCounts: counts,
      topFindings: top,
    });
  };

  for (const row of publications.results) consider(row.ticker, row.cik, row.payload, row.publishedAt);
  for (const ticker of enabled) consider(ticker, null, null, null);

  companies.sort((a, b) => a.ticker.localeCompare(b.ticker));
  const capped = companies.slice(0, MAX_COMPANIES);
  if (capped.length < companies.length) damaged = true;
  const have = new Set(capped.map(company => company.ticker));
  const popular: string[] = [];
  const push = (ticker: string) => { if (have.has(ticker) && !popular.includes(ticker) && popular.length < 5) popular.push(ticker); };
  const fresh = [...capped].sort((a, b) => (b.latestPeriod?.filedAt ?? "").localeCompare(a.latestPeriod?.filedAt ?? "") || a.ticker.localeCompare(b.ticker));
  for (const company of fresh) if (Object.values(company.findingCounts).some(count => count > 0)) push(company.ticker);
  for (const company of fresh) push(company.ticker);

  return {
    schemaVersion: "home-digest.v1",
    status: damaged || capped.some(company => company.status === "partial") ? "partial" : "ready",
    generatedAt: now.toISOString(),
    coverage: { count: capped.length, lastUpdatedAt },
    companies: capped,
    popular,
  };
}
