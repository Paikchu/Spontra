import type { HomeCompany, HomeDigest, HomeFinding, HomeRevenue, HomeRevenueReason } from "../../../shared/analysis-contract/home.ts";
import type { FiscalLabelSource } from "../../../shared/analysis-contract/period.ts";
import { calendarLabel, resolvePeriod } from "../../../shared/analysis-runtime/fiscal-label.ts";
import { isLocale, type Locale } from "../../../shared/analysis-runtime/locale.ts";
import { TICKER_PATTERN } from "@/shared/analysis-runtime/financial-data/policy";

const DECIMAL = /^-?\d+(\.\d+)?$/;
const REASONS = new Set<HomeRevenueReason>(["NOT_DISCLOSED", "MISSING_TWO_QUARTERS"]);
const COMPANY_STATUS = new Set<HomeCompany["status"]>(["ready", "preparing", "partial"]);
const KINDS = new Set<HomeFinding["kind"]>(["risk", "strength", "shift", "watch"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function decimal(value: unknown): string | null {
  return typeof value === "string" && DECIMAL.test(value) ? value : null;
}

function finiteOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function finding(value: unknown): HomeFinding | null {
  const row = record(value);
  if (!row) return null;
  const id = text(row.id);
  const title = text(row.title);
  const periodEnd = text(row.periodEnd);
  const kind = row.kind;
  if (!id || !title || !periodEnd || typeof kind !== "string" || !KINDS.has(kind as HomeFinding["kind"])) return null;
  if (row.severity !== 1 && row.severity !== 2 && row.severity !== 3) return null;
  return { id, kind: kind as HomeFinding["kind"], severity: row.severity, title, periodEnd };
}

function revenue(value: unknown): HomeRevenue | null | undefined {
  if (value === null) return null;
  const row = record(value);
  if (!row) return undefined;
  const amount = decimal(row.value);
  const currency = text(row.currency);
  const yoyPct = finiteOrNull(row.yoyPct);
  const qoqPct = finiteOrNull(row.qoqPct);
  if (!amount || !currency || yoyPct === undefined || qoqPct === undefined) return undefined;
  return { value: amount, currency, yoyPct, qoqPct };
}

function company(value: unknown): HomeCompany | null {
  const row = record(value);
  if (!row) return null;
  const ticker = text(row.ticker);
  const name = text(row.name);
  const status = row.status;
  if (!ticker || !TICKER_PATTERN.test(ticker) || !name || typeof status !== "string" || !COMPANY_STATUS.has(status as HomeCompany["status"])) return null;
  if (!(row.nameZh === null || typeof row.nameZh === "string")) return null;
  if (!(row.sector === null || typeof row.sector === "string")) return null;
  if (!Array.isArray(row.aliases) || row.aliases.some(alias => typeof alias !== "string")) return null;
  if (!(row.revenueReason === null || (typeof row.revenueReason === "string" && REASONS.has(row.revenueReason as HomeRevenueReason)))) return null;
  const parsedRevenue = revenue(row.revenue);
  if (parsedRevenue === undefined) return null;
  let latestPeriod: HomeCompany["latestPeriod"] = null;
  if (row.latestPeriod !== null) {
    const period = record(row.latestPeriod);
    if (!period || !text(period.periodEnd) || !text(period.fiscalLabel) || !(period.filedAt === null || typeof period.filedAt === "string")) return null;
    const periodEnd = period.periodEnd as string;
    if (period.periodStart != null && typeof period.periodStart !== "string") return null;
    const source = period.labelSource;
    const labelSource: FiscalLabelSource | null = source === "xbrl" || source === "derived" || source === "unknown" ? source : null;
    const resolved = resolvePeriod({
      ticker,
      periodEnd,
      periodStart: typeof period.periodStart === "string" ? period.periodStart : null,
      fiscalYear: typeof period.fiscalYear === "number" ? period.fiscalYear : null,
      fiscalQuarter: typeof period.fiscalQuarter === "number" ? period.fiscalQuarter : null,
      fiscalYearEndMonth: typeof period.fiscalYearEndMonth === "number" ? period.fiscalYearEndMonth : null,
      labelSource,
    });
    const calendar = typeof period.calendarLabel === "string" && period.calendarLabel ? period.calendarLabel : calendarLabel(periodEnd);
    latestPeriod = {
      periodEnd, periodStart: resolved.periodStart, fiscalLabel: period.fiscalLabel as string, calendarLabel: calendar,
      filedAt: period.filedAt as string | null, fiscalYear: resolved.fiscalYear, fiscalQuarter: resolved.fiscalQuarter,
      fiscalYearEndMonth: resolved.fiscalYearEndMonth, labelSource: resolved.labelSource,
    };
  }
  if (!Array.isArray(row.revenueTrend)) return null;
  const revenueTrend: HomeCompany["revenueTrend"] = [];
  for (const point of row.revenueTrend) {
    const item = record(point);
    const periodEnd = item && text(item.periodEnd);
    const amount = item && decimal(item.value);
    if (!periodEnd || !amount) return null;
    revenueTrend.push({ periodEnd, value: amount });
  }
  let statement: HomeCompany["statement"] = null;
  if (row.statement != null) {
    const item = record(row.statement);
    const currency = item && text(item.currency), revenueAmount = item && decimal(item.revenue), net = item && decimal(item.net);
    const cost = item && item.cost != null ? decimal(item.cost) : null;
    if (currency && revenueAmount && net) statement = { currency, revenue: revenueAmount, cost, net };
  }
  const margin = record(row.operatingMargin);
  const marginPct = margin ? finiteOrNull(margin.pct) : undefined, yearAgoPct = margin ? finiteOrNull(margin.yearAgoPct) : undefined;
  const operatingMargin = marginPct != null && yearAgoPct !== undefined ? { pct: marginPct, yearAgoPct } : null;
  const counts = record(row.findingCounts);
  const count = (key: string) => counts && typeof counts[key] === "number" && Number.isInteger(counts[key]) && (counts[key] as number) >= 0 ? counts[key] as number : null;
  const risk = count("risk");
  const strength = count("strength");
  const shift = count("shift");
  const watch = count("watch");
  if (risk == null || strength == null || shift == null || watch == null) return null;
  if (!Array.isArray(row.topFindings) || row.topFindings.length > 2) return null;
  const topFindings: HomeFinding[] = [];
  for (const item of row.topFindings) {
    const parsed = finding(item);
    if (!parsed) return null;
    topFindings.push(parsed);
  }
  return {
    ticker, name, nameZh: row.nameZh, aliases: row.aliases as string[], sector: row.sector,
    status: status as HomeCompany["status"], latestPeriod, revenue: parsedRevenue,
    revenueReason: row.revenueReason as HomeRevenueReason | null, revenueTrend, statement, operatingMargin,
    findingCounts: { risk, strength, shift, watch }, topFindings,
  };
}

/** A digest the page can render. Anything else, including `unavailable`, is refused. */
export function parseHomeDigest(body: unknown): HomeDigest | null {
  const row = record(body);
  if (!row || row.schemaVersion !== "home-digest.v1") return null;
  if (row.status !== "ready" && row.status !== "partial") return null;
  if (typeof row.generatedAt !== "string") return null;
  const coverage = record(row.coverage);
  if (!coverage || typeof coverage.count !== "number" || !Number.isInteger(coverage.count) || coverage.count < 0) return null;
  if (!(coverage.lastUpdatedAt === null || typeof coverage.lastUpdatedAt === "string")) return null;
  if (!Array.isArray(row.companies) || !Array.isArray(row.popular)) return null;
  const companies: HomeCompany[] = [];
  for (const item of row.companies) {
    const parsed = company(item);
    if (!parsed) return null;
    companies.push(parsed);
  }
  if (coverage.count !== companies.length) return null;
  const have = new Set(companies.map(item => item.ticker));
  const popular: string[] = [];
  for (const item of row.popular) {
    if (typeof item !== "string" || !have.has(item) || popular.includes(item)) return null;
    popular.push(item);
  }
  return {
    schemaVersion: "home-digest.v1",
    status: row.status,
    generatedAt: row.generatedAt,
    coverage: { count: coverage.count, lastUpdatedAt: coverage.lastUpdatedAt },
    companies,
    popular,
  };
}

/** `?lang=` only. English needs no parameter. A stray or unknown parameter is refused. */
export function homeLocale(params: URLSearchParams): Locale | null | "reject" {
  for (const key of params.keys()) if (key !== "lang") return "reject";
  const lang = params.get("lang");
  if (lang == null) return null;
  if (!isLocale(lang)) return "reject";
  return lang === "en" ? null : lang;
}

export function unavailableHome(now = new Date().toISOString()) {
  return {
    schemaVersion: "home-digest.v1" as const,
    status: "unavailable" as const,
    generatedAt: now,
    coverage: { count: 0, lastUpdatedAt: null },
    companies: [] as HomeCompany[],
    popular: [] as string[],
  };
}
