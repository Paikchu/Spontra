import type { SecMarketSnapshot } from "../../../../shared/analysis-contract/sec-reader.ts";
import type { SecHistorySnapshot } from "./analysis.ts";
import type { SecFiling } from "./sec.ts";
import { readYahooChart, yahooChartUrl, yahooSymbol, type YahooChart } from "../market/yahoo.ts";

/** Freeze completed daily closes in the analysis context; never fetch live prices in the report UI. */
export async function fetchSecMarketSnapshot(filing: SecFiling, history: SecHistorySnapshot, fetcher: typeof fetch = fetch, now = new Date()): Promise<SecMarketSnapshot> {
  const release = filing.earningsGroup?.earningsDate ?? filing.filingDate;
  const url = yahooChartUrl(yahooSymbol(filing.ticker), {
    period1: String(Math.floor(Date.parse(`${release}T00:00:00Z`) / 1000) - 14 * 86400),
    period2: String(Math.floor(now.getTime() / 1000)),
    interval: "1d",
  });
  const unavailable: SecMarketSnapshot = { status: "unavailable", asOf: now.toISOString(), source: "Yahoo Finance", sourceUrl: url.href,
    limitations: ["No verifiable historical closing price was obtained, so this report does not judge whether the current price is attractive."] };
  const chart = await readYahooChart(url, fetcher, now);
  return (chart && marketSnapshot(chart, filing, history, now)) ?? unavailable;
}

function marketSnapshot(chart: YahooChart, filing: SecFiling, history: SecHistorySnapshot, now: Date): SecMarketSnapshot | undefined {
  if (chart.symbol !== yahooSymbol(filing.ticker) || !chart.currency || !/^[A-Z]{3}$/.test(chart.currency)) return;
  const { points } = chart, currency = chart.currency;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: chart.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const latest = points.at(-1);
  if (!latest) return;
  const snapshot: SecMarketSnapshot = { status: "available", asOf: now.toISOString(), source: "Yahoo Finance", sourceUrl: chart.url,
    currency, price: latest.close, priceDate: latest.date,
    limitations: ["Uses the closing price of the last completed trading day, frozen when the report was generated; a price change is not proof that the filing caused it, and it is not total return.", "The latest actual shares outstanding and total debt are not verified, so market capitalization and EV/EBITDA are not calculated."] };
  const release = filing.earningsGroup?.earningsDate ?? filing.filingDate;
  const before = points.filter((p) => p.date < release).at(-1);
  const after = points.filter((p) => p.date > release).slice(0, 3);
  if (before && after.length && Date.parse(release) - Date.parse(before.date) <= 7 * 86400000) {
    snapshot.reaction = { from: before.date, to: after.at(-1)!.date, sessions: after.length, changePercent: (after.at(-1)!.close / before.close - 1) * 100 };
  } else snapshot.limitations.push("Not enough full trading days have passed since the release to show the event-window move.");
  // EPS must be a comparable four-quarter series; do not annualize one unusually strong quarter.
  const epsSeries = history.series.find((s) => s.seriesId === "diluted_eps");
  const quarters = [...(epsSeries?.quarters ?? [])].filter((p) => p.endDate <= filing.reportDate && p.sourceFiledAt.slice(0, 10) <= filing.filingDate)
    .sort((a, b) => b.endDate.localeCompare(a.endDate)).filter((p, i, all) => all.findIndex((other) => other.endDate === p.endDate) === i).slice(0, 4);
  const comparable = quarters.length === 4 && quarters[0].endDate === filing.reportDate && quarters.every((p, i) =>
    p.qualityStatus === "validated_xbrl" && p.currency === currency && p.unit === quarters[0].unit && /^-?\d+(\.\d+)?$/.test(p.value)
    && (!i || (Date.parse(quarters[i - 1].endDate) - Date.parse(p.endDate)) / 86400000 >= 70
      && (Date.parse(quarters[i - 1].endDate) - Date.parse(p.endDate)) / 86400000 <= 110));
  const annual = /^10-K/.test(filing.form) ? epsSeries?.annual.find((p) => p.endDate === filing.reportDate
    && p.sourceFiledAt.slice(0, 10) <= filing.filingDate && p.currency === currency && p.qualityStatus === "validated_xbrl"
    && /^-?\d+(\.\d+)?$/.test(p.value)) : undefined;
  const eps = annual ? Number(annual.value) : comparable ? quarters.reduce((n, p) => n + Number(p.value), 0) : 0;
  // Foreign issuers may report ordinary-share EPS against a differently sized ADS/ADR.
  if (eps > 0 && !/^20-F|^6-K/.test(filing.form) && chart.instrumentType === "EQUITY") {
    snapshot.trailingEPS = eps; snapshot.trailingPE = latest.close / eps; snapshot.earningsPeriodEnd = filing.reportDate;
  } else snapshot.limitations.push("P/E is not shown: four comparable quarters of diluted EPS are missing, the per-share basis does not align, or earnings are not positive.");
  if (Date.parse(today) - Date.parse(latest.date) > 7 * 86400000) snapshot.limitations.push("The latest close is more than seven days old and cannot be treated as the current price.");
  return snapshot;
}
