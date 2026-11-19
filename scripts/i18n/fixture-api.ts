/**
 * Serves the fixture company as the read API in the business site's dev server, so the pages can be opened in
 * either language with no network: BUSINESS_SITE_FIXTURES=1 npm run dev, then /companies/ACME?lang=zh-CN.
 * `POST /__fixture/publish` stands in for Spontra Analysis publishing: every revision moves, and the findings and events
 * each gain a row, so an open page's update notice and entrance can be seen.
 */
import type { Plugin } from "vite";
import type { HomeDigest } from "../../shared/analysis-contract/home.ts";
import type { DailyPriceBar, LiveMarketDaily } from "../../shared/analysis-contract/market-daily.ts";
import { calendarLabel, resolvePeriod } from "../../shared/analysis-runtime/fiscal-label.ts";
import { decodeCursor, historyFromEvents, historyLimit, INSIDER_NEW_DAYS, personsFromEvents } from "../../shared/analysis-runtime/insiders.ts";
import { readYahooDailyBars } from "../../workers/analysis/src/market/yahoo.ts";
import { capital, company, events, filings, findings, flow, TICKER, valuation } from "./fixture.ts";

function fixtureMarketDaily(): LiveMarketDaily {
  const targetClose = valuation.report?.quote?.price ?? 98;
  const endDate = new Date(`${valuation.report?.quote?.priceDate ?? "2026-08-11"}T00:00:00Z`);
  const dates: string[] = [];
  const cursor = new Date(endDate.getTime());
  while (dates.length < 126) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  dates.reverse();

  let seed = 421987;
  const rand = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const rawCloses: number[] = [];
  let level = targetClose * 0.84;
  for (let i = 0; i < dates.length; i++) {
    const t = i / (dates.length - 1);
    const wave = Math.sin(t * Math.PI * 2.4) * targetClose * 0.08 + Math.cos(t * Math.PI * 5.1) * targetClose * 0.03;
    const drift = (targetClose * (0.84 + 0.16 * t) + wave - level) * 0.16;
    const shock = (rand() - 0.5) * targetClose * 0.035;
    level = Math.max(targetClose * 0.55, level + drift + shock);
    rawCloses.push(level);
  }
  const scale = targetClose / rawCloses.at(-1)!;
  const bars: DailyPriceBar[] = [];
  let prevClose = Number((rawCloses[0]! * scale).toFixed(2));
  for (let i = 0; i < dates.length; i++) {
    const close = i === dates.length - 1 ? targetClose : Number((rawCloses[i]! * scale).toFixed(2));
    const open = i === 0 ? close : Number((prevClose + (rand() - 0.5) * targetClose * 0.012).toFixed(2));
    const spread = Math.max(Math.abs(close - open), targetClose * 0.008);
    const high = Number((Math.max(open, close) + spread * (0.35 + rand() * 0.65)).toFixed(2));
    const low = Number(Math.max(1, Math.min(open, close) - spread * (0.35 + rand() * 0.65)).toFixed(2));
    bars.push({ time: dates[i]!, open, high, low, close });
    prevClose = close;
  }
  return {
    schemaVersion: "market-daily.v1",
    ticker: TICKER,
    currency: valuation.report?.currency ?? "USD",
    livePrice: bars.at(-1)!.close,
    liveDate: bars.at(-1)!.time,
    previousClose: bars.at(-2)?.close ?? null,
    marketState: "regular",
    bars,
  };
}

let published = 0;
const revision = () => new Date(Date.UTC(2026, 7, 10) + published * 3_600_000).toISOString();

function resources(): Record<string, unknown> {
  const extra = findings.findings.find(f => f.id === "margin")!;
  const later = Array.from({ length: published }, (_, i) => ({
    finding: { ...extra, id: `margin-${i + 1}`, severity: 3, title: `Gross margin dips, round ${String.fromCharCode(65 + i)}` },
    event: { ...events.events.find(e => e.id === "e-exec")!, id: `e-exec-${i + 1}`, filedAt: `2026-08-${String(11 + i).padStart(2, "0")}`, eventDate: `2026-08-${String(11 + i).padStart(2, "0")}` },
  }));
  const rev = revision();
  return {
    "": company,
    "/revision": { schemaVersion: "revisions.v1", ticker: TICKER, revisions: { company: rev, capital: rev, findings: rev, fundamentals: rev, events: rev, filings: rev, valuation: rev } },
    "/capital": { status: "ready", capital },
    "/findings": { status: "ready", findings: { ...findings, findings: [...later.map(l => l.finding).reverse(), ...findings.findings] }, passages: [
      { passageId: "pfixturenote01", documentId: "d1", title: `${TICKER} 10-Q`, form: "10-Q", filedAt: "2026-08-05", url: "https://www.sec.gov/", path: ["MD&A", "Cash flows"], text: "Depreciation and amortization increased as new capacity was placed in service.", table: null },
      { passageId: "pfixturenote02", documentId: "d0", title: `${TICKER} 10-K`, form: "10-K", filedAt: "2026-02-20", url: "https://www.sec.gov/", path: ["MD&A", "Liquidity"], text: "We expect depreciation to rise as we place additional capacity in service.", table: null },
    ] },
    "/events": { status: "ready", events: { ...events, events: [...later.map(l => l.event).reverse(), ...events.events] } },
    "/insiders": { status: "ready", insiders: { schemaVersion: "insiders.v1", ticker: TICKER, source: "events", newDays: INSIDER_NEW_DAYS, asOf: rev, persons: personsFromEvents(events.events, new Date(rev)) } },
    "/filings": { status: "ready", filings },
    "/fundamentals": { status: "unavailable" },
    "/valuation": valuation,
  };
}

function homeDigest(): HomeDigest {
  const latest = flow.quarters.at(-1)!;
  const scale = latest.scale;
  const amount = (quarter: typeof latest) => {
    const value = Number(quarter.figures.revenue?.value);
    return Number.isFinite(value) ? String(Math.round(value * scale)) : "0";
  };
  const figure = (quarter: typeof latest, key: "cost" | "net") => {
    const value = Number(quarter.figures[key]?.value);
    return Number.isFinite(value) ? String(Math.round(value * scale)) : null;
  };
  const pct = (current: string, prior: string | null) => {
    const left = Number(current);
    const right = Number(prior);
    if (!prior || !Number.isFinite(right) || right === 0) return null;
    return Math.round(((left - right) / Math.abs(right)) * 1000) / 10;
  };
  const yearAgo = flow.quarters.find(quarter => quarter.periodEnd === "2025-06-30") ?? null;
  const previous = flow.quarters.at(-2) ?? null;
  const counts = { risk: 0, strength: 0, shift: 0, watch: 0 };
  for (const finding of findings.findings) counts[finding.kind] += 1;
  const period = resolvePeriod({ ticker: TICKER, periodEnd: latest.periodEnd, periodStart: latest.periodStart });
  return {
    schemaVersion: "home-digest.v1", status: "ready", generatedAt: "2026-08-10T00:00:00Z",
    coverage: { count: 1, lastUpdatedAt: "2026-08-10T00:00:00Z" }, popular: [TICKER],
    companies: [{
      ticker: TICKER, name: "Acme Corp", nameZh: null, aliases: ["CLOUD"], sector: null, status: "ready",
      latestPeriod: {
        periodEnd: latest.periodEnd, periodStart: latest.periodStart, fiscalLabel: calendarLabel(latest.periodEnd), calendarLabel: calendarLabel(latest.periodEnd),
        filedAt: latest.reportedAt ?? null, fiscalYear: period.fiscalYear, fiscalQuarter: period.fiscalQuarter,
        fiscalYearEndMonth: period.fiscalYearEndMonth, labelSource: period.labelSource,
      },
      revenue: { value: amount(latest), currency: latest.currency, yoyPct: pct(amount(latest), yearAgo ? amount(yearAgo) : null), qoqPct: pct(amount(latest), previous ? amount(previous) : null) },
      revenueReason: null,
      revenueTrend: flow.quarters.slice(-8).map(quarter => ({ periodEnd: quarter.periodEnd, value: amount(quarter) })),
      statement: { currency: latest.currency, revenue: amount(latest), cost: figure(latest, "cost"), net: figure(latest, "net") ?? amount(latest) },
      findingCounts: counts,
      topFindings: [...findings.findings].sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id)).slice(0, 2)
        .map(finding => ({ id: finding.id, kind: finding.kind, severity: finding.severity, title: finding.title, periodEnd: findings.periodEnd })),
    }],
  };
}

export function fixtureApi(): Plugin {
  return {
    name: "business-site-fixture-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/__fixture/publish" && req.method === "POST") {
          published++;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ published, revision: revision() }));
          return;
        }
        const path = req.url?.split("?")[0];
        // BUSINESS_SITE_STAGE=1 opens the rail's console against no agent, so its layout can be looked at; the socket never connects.
        if (process.env.BUSINESS_SITE_STAGE && path?.startsWith("/agents/")) {
          res.setHeader("content-type", "application/json");
          if (path === "/agents/status") { res.end(JSON.stringify({ open: true, reader: true })); return; }
          if (path === "/agents/identity") { res.statusCode = 204; res.end(); return; }
          if (path === "/agents/conversations") { res.end(JSON.stringify(req.method === "POST" ? { id: "0".repeat(32) } : { conversations: [] })); return; }
          res.statusCode = 404; res.end("{}"); return;
        }
        if (path === "/api/business/v1/telemetry") {
          if (req.method === "POST") { res.statusCode = 204; res.end(); return; }
          res.statusCode = req.method === "GET" ? 404 : 405;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: req.method === "GET" ? "Not found" : "Method not allowed" }));
          return;
        }
        if (path === "/api/business/v1/home") {
          res.statusCode = req.method === "GET" ? 200 : 405;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(req.method === "GET" ? homeDigest() : { error: "Method not allowed" }));
          return;
        }
        const marketDaily = req.url?.match(/^\/api\/business\/v1\/companies\/([^/?]+)\/market-daily(?:\?.*)?$/);
        if (marketDaily) {
          const requestedTicker = decodeURIComponent(marketDaily[1]!).toUpperCase();
          if (requestedTicker === TICKER) {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(fixtureMarketDaily()));
            return;
          }
          void readYahooDailyBars(requestedTicker).then(payload => {
            res.statusCode = payload ? 200 : 503;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(payload ?? { error: "market data unavailable" }));
          }).catch(() => {
            res.statusCode = 503;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "market data unavailable" }));
          });
          return;
        }
        const history = req.url?.match(/^\/api\/business\/v1\/companies\/([^/?]+)\/insiders\/([^/?]+)\/transactions(?:\?(.*))?$/);
        if (history) {
          const query = new URLSearchParams(history[3] ?? "");
          const page = history[1] === TICKER ? historyFromEvents(events.events, TICKER, decodeURIComponent(history[2]!), decodeCursor(query.get("cursor")) ?? null, historyLimit(query.get("limit")), new Date(revision())) : null;
          res.statusCode = page ? 200 : 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(page ? { schemaVersion: "insider-transactions-response.v1", status: "ready", transactions: page } : { error: "not in fixture" }));
          return;
        }
        const match = req.url?.match(/^\/api\/business\/v1\/companies\/([^/?]+)(\/[a-z]+)?(?:\?(.*))?$/);
        if (!match) return next();
        const query = new URLSearchParams(match[3] ?? "");
        const scope = query.get("scope");
        const parts = resources();
        const allResources = Object.entries(parts).filter(([path]) => path !== "/revision").map(([path, body]) => [path.slice(1) || "company", { status: 200, body }] as const);
        const scoped = scope === "primary"
          ? allResources.filter(([name]) => !["events", "filings"].includes(name))
          : scope === "stream"
            ? allResources.filter(([name]) => ["events", "filings"].includes(name))
            : allResources;
        const opening = {
          revisions: (parts["/revision"] as { revisions: unknown }).revisions,
          config: "11111-1",
          resources: Object.fromEntries(scoped),
        };
        const body = match[1] === TICKER ? match[2] === "/opening" ? opening : parts[match[2] ?? ""] : undefined;
        res.statusCode = body ? 200 : 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body ?? { error: "not in fixture" }));
      });
    },
  };
}
