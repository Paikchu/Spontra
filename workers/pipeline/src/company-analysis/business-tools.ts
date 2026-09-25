import type { BusinessDeepDive } from "../../../../shared/analysis-contract/company-analysis.ts";
import type { CompanyAnalysisD1Database } from "./repository.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { WebSearchService } from "../web-search/service.ts";

export type BusinessSource = BusinessDeepDive["sources"][number];
export type AvailableSecReport = { periodId: string; periodEnd: string; periodScope: string; reportVersion: string };
export type BusinessToolResult = { sourceId: string | null; observation: unknown };

export interface BusinessResearchTools {
  availableReports(): Promise<AvailableSecReport[]>;
  readSecReport(periodId: string): Promise<BusinessToolResult>;
  searchWeb(query: string): Promise<BusinessToolResult>;
  readWeb(url: string): Promise<BusinessToolResult>;
  sources(): BusinessSource[];
  restore(sources: BusinessSource[], result: BusinessToolResult): void;
}

/** SEC reports are already published and verified; the model never reads unpublished drafts. */
export function createBusinessResearchTools(input: {
  database: CompanyAnalysisD1Database;
  search: WebSearchService;
  ticker: string;
  reportDate: string;
  now: string;
}): BusinessResearchTools {
  const reports = new D1SecRepository(input.database);
  const sources = new Map<string, BusinessSource>();
  const searchHits = new Map<string, { id: string; snippet: string }>();
  const scope = { scope: `spontra:business:${input.ticker}`, maxAgeMs: 6 * 60 * 60_000 };
  let available: AvailableSecReport[] | null = null;
  const resultSources = () => [...sources.values()];
  return {
    async availableReports() {
      if (available) return available;
      const rows = await input.database.prepare(`
        SELECT r.period_id AS periodId, p.end_date AS periodEnd, p.period_scope AS periodScope, r.report_version AS reportVersion
        FROM sec_published_reports r JOIN sec_periods p ON r.period_id = p.period_id AND r.ticker = p.ticker
        WHERE r.ticker = ? AND p.end_date <= ? AND r.verification_status IN ('verified', 'partial')
        ORDER BY p.end_date DESC, r.generated_at DESC, r.rowid DESC LIMIT 16
      `).bind(input.ticker, input.reportDate).all<AvailableSecReport>();
      const byPeriod = new Map<string, AvailableSecReport>();
      for (const row of rows.results) if (!byPeriod.has(row.periodId)) byPeriod.set(row.periodId, row);
      available = [...byPeriod.values()].slice(0, 4);
      return available;
    },
    async readSecReport(periodId) {
      const frozen = (await this.availableReports()).find((report) => report.periodId === periodId);
      if (!frozen) {
        return { sourceId: null, observation: { error: "SEC report is not available for this company and period" } };
      }
      const report = await reports.getPublishedReport(input.ticker, periodId);
      if (report && report.reportVersion !== frozen.reportVersion) {
        throw new Error("SEC published report changed during the business analysis.");
      }
      // Earlier verified reports did not embed a publication snapshot. Resolve the filing from
      // its durable period membership instead of discarding otherwise useful SEC evidence.
      const linked = await input.database.prepare(`
        SELECT f.accession_number AS accessionNumber, f.form, f.filing_date AS filingDate,
          f.report_date AS reportDate, f.index_url AS indexUrl
        FROM sec_filing_periods m JOIN sec_filings f ON f.filing_id = m.filing_id
        WHERE m.period_id = ? AND f.ticker = ? AND f.form IN ('10-K', '10-Q', '20-F', '10-K/A', '10-Q/A', '20-F/A')
        ORDER BY m.role = 'primary' DESC, f.filing_date DESC LIMIT 1
      `).bind(periodId, input.ticker).first<{ accessionNumber: string; form: string; filingDate: string; reportDate: string; indexUrl: string }>();
      const filing = report?.publication?.filing ?? linked;
      if (!report || !filing || !isSecUrl(filing.indexUrl)) {
        return { sourceId: null, observation: { error: "SEC published report has no verified filing URL" } };
      }
      const id = `sec-${filing.accessionNumber}`;
      sources.set(id, {
        id, title: `${input.ticker} ${filing.form}（${filing.reportDate || filing.filingDate}）`,
        url: filing.indexUrl, kind: "sec", publishedAt: isoDate(filing.filingDate), retrievedAt: input.now,
      });
      return { sourceId: id, observation: {
        sourceId: id, periodEnd: filing.reportDate, form: filing.form, headline: report.headline,
        metrics: report.keyMetrics.slice(0, 20).map((metric) => ({
          key: metric.metricKey, value: metric.currentValue, unit: metric.unit,
          currency: metric.currency, status: metric.status,
        })),
        sections: report.reader?.sections.slice(0, 10).map((section) => ({
          title: section.title, paragraphs: section.paragraphs.slice(0, 3).map((paragraph) => paragraph.slice(0, 1_800)),
          takeaway: section.takeaway,
        })) ?? [],
        guidance: report.changes.guidance.slice(0, 5), risks: report.changes.risks.slice(0, 5),
        limitations: report.dataQuality.warnings.slice(0, 5),
      } };
    },
    async searchWeb(query) {
      const clean = query.trim().slice(0, 300);
      if (clean.length < 3) return { sourceId: null, observation: { error: "Search query is too short" } };
      const result = await input.search.search({ query: clean, maxResults: 5, depth: "advanced" }, scope);
      const hits = result.data.results.filter((hit) => isHttps(hit.url)).slice(0, 5).map((hit) => {
        let existing = searchHits.get(hit.url);
        if (!existing && searchHits.size < 20) {
          existing = { id: `web-${searchHits.size + 1}`, snippet: hit.snippet.slice(0, 1_500) };
          searchHits.set(hit.url, existing);
        }
        if (!existing) return null;
        sources.set(existing.id, {
          id: existing.id, title: hit.title.slice(0, 240) || clean,
          url: hit.url, kind: "web", publishedAt: isoDate(hit.publishedAt), retrievedAt: result.fetchedAt,
        });
        return { sourceId: existing.id, title: hit.title, url: hit.url, snippet: existing.snippet, publishedAt: hit.publishedAt };
      }).filter((hit) => hit !== null);
      return { sourceId: null, observation: { hits } };
    },
    async readWeb(url) {
      // The model may only open a URL actually discovered by this run, never an arbitrary address.
      const hit = searchHits.get(url);
      if (!hit) return { sourceId: null, observation: { error: "URL was not returned by search" } };
      const result = await input.search.fetchContent({ url, depth: "advanced" }, { ...scope, maxAgeMs: 24 * 60 * 60_000 });
      const source = sources.get(hit.id);
      if (source) sources.set(hit.id, { ...source, retrievedAt: result.fetchedAt });
      return { sourceId: hit.id, observation: { sourceId: hit.id, url, text: result.data.text.slice(0, 14_000), completeness: result.data.completeness } };
    },
    sources: resultSources,
    restore(snapshot, result) {
      // A Workflow can replay a completed tool step without invoking its callback. Restore both
      // citation provenance and discovered URLs before the next model/tool turn.
      for (const source of snapshot) sources.set(source.id, source);
      const observation = result.observation as { hits?: Array<{ url: string; sourceId: string; snippet: string }> };
      for (const hit of observation.hits ?? []) searchHits.set(hit.url, { id: hit.sourceId, snippet: hit.snippet });
    },
  };
}

function isHttps(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
}

function isSecUrl(value: string): boolean {
  if (!isHttps(value)) return false;
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === "sec.gov" || hostname.endsWith(".sec.gov");
}

function isoDate(value: string | null): string | null {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
