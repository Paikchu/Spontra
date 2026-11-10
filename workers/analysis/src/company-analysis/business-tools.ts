import type { NativeSearch } from "../web-search/native.ts";
import type { BusinessDeepDive } from "../../../../shared/analysis-contract/company-analysis.ts";
import type { CompanyAnalysisD1Database } from "./repository.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { WebSearchService } from "../web-search/service.ts";
import { isSecUrl } from "../../../../shared/analysis-runtime/sec-sources.ts";

export type BusinessSource = BusinessDeepDive["sources"][number];
/** `accession`: set for a report the filing path published (its version is the publication time); unset for a legacy structured report. */
export type AvailableSecReport = { periodId: string; periodEnd: string; periodScope: string; reportVersion: string; accession?: string };
export type BusinessToolResult = { sourceId: string | null; observation: unknown };

export interface BusinessResearchTools {
  availableReports(): Promise<AvailableSecReport[]>;
  readSecReport(periodId: string): Promise<BusinessToolResult>;
  registerSearch(batch: NativeSearch): BusinessToolResult;
  readWeb(url: string): Promise<BusinessToolResult>;
  sources(): BusinessSource[];
}

/** What the tools have found: the citable sources, the URLs searches returned, and the reports the run may read. */
export type ResearchMemory = { sources: Map<string, BusinessSource>; searchHits: Map<string, { id: string; snippet: string }>; available: AvailableSecReport[] | null };
export const researchMemory = (available: AvailableSecReport[] | null = null): ResearchMemory => ({ sources: new Map(), searchHits: new Map(), available });

/** SEC reports are already published and verified; the model never reads unpublished drafts. */
export function createBusinessResearchTools(input: {
  database: CompanyAnalysisD1Database;
  search: WebSearchService;
  ticker: string;
  reportDate: string;
  now: string;
}, memory: ResearchMemory = researchMemory()): BusinessResearchTools {
  const reports = new D1SecRepository(input.database);
  const { sources, searchHits } = memory;
  const scope = { scope: `spontra:business:${input.ticker}`, maxAgeMs: 6 * 60 * 60_000 };
  const resultSources = () => [...sources.values()];
  /** A report the filing path published: its headline and Markdown, cited as the filing it analyses. */
  const readFilingReport = async (frozen: AvailableSecReport, accession: string): Promise<BusinessToolResult> => {
    const summary = await reports.getSummary(input.ticker, accession);
    if (!summary?.report) return { sourceId: null, observation: { error: "SEC report is not available for this company and period" } };
    if (summary.generatedAt !== frozen.reportVersion) throw new Error("SEC published report changed during the business analysis.");
    const filing = await input.database.prepare("SELECT form, filing_date AS filingDate, report_date AS reportDate, index_url AS indexUrl FROM sec_filings WHERE ticker = ? AND accession_number = ? LIMIT 1")
      .bind(input.ticker, accession).first<{ form: string; filingDate: string; reportDate: string; indexUrl: string }>();
    if (!filing || !isSecUrl(filing.indexUrl)) return { sourceId: null, observation: { error: "SEC published report has no verified filing URL" } };
    const id = `sec-${accession}`;
    sources.set(id, {
      id, title: `${input.ticker} ${filing.form} (${filing.reportDate || filing.filingDate})`,
      url: filing.indexUrl, kind: "sec", publishedAt: isoDate(filing.filingDate), retrievedAt: input.now,
    });
    return { sourceId: id, observation: { sourceId: id, periodEnd: filing.reportDate, form: filing.form, headline: summary.headline, report: summary.report.slice(0, 24_000) } };
  };
  return {
    async availableReports() {
      if (memory.available) return memory.available;
      // The filing path's reports first: one per period, the newest publication. Legacy structured reports fill the periods it has not reached.
      const filed = await input.database.prepare(`
        SELECT m.period_id AS periodId, p.end_date AS periodEnd, p.period_scope AS periodScope, s.generated_at AS reportVersion, s.accession_number AS accession
        FROM sec_filing_summaries s
        JOIN sec_filing_periods m ON m.filing_id = s.accession_number AND m.role = 'primary'
        JOIN sec_periods p ON p.period_id = m.period_id AND p.ticker = s.ticker
        WHERE s.ticker = ? AND p.end_date <= ? AND json_extract(s.payload, '$.generatedBy') = 'pi' AND length(json_extract(s.payload, '$.report')) > 0
        ORDER BY p.end_date DESC, s.generated_at DESC LIMIT 16
      `).bind(input.ticker, input.reportDate).all<AvailableSecReport>();
      const rows = await input.database.prepare(`
        SELECT r.period_id AS periodId, p.end_date AS periodEnd, p.period_scope AS periodScope, r.report_version AS reportVersion
        FROM sec_published_reports r JOIN sec_periods p ON r.period_id = p.period_id AND r.ticker = p.ticker
        WHERE r.ticker = ? AND p.end_date <= ? AND r.verification_status IN ('verified', 'partial')
        ORDER BY p.end_date DESC, r.generated_at DESC, r.rowid DESC LIMIT 16
      `).bind(input.ticker, input.reportDate).all<AvailableSecReport>();
      const byPeriod = new Map<string, AvailableSecReport>();
      for (const row of filed.results) if (!byPeriod.has(row.periodId)) byPeriod.set(row.periodId, row);
      for (const row of rows.results) if (!byPeriod.has(row.periodId)) byPeriod.set(row.periodId, row);
      memory.available = [...byPeriod.values()].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).slice(0, 4);
      return memory.available;
    },
    async readSecReport(periodId) {
      const frozen = (await this.availableReports()).find((report) => report.periodId === periodId);
      if (!frozen) {
        return { sourceId: null, observation: { error: "SEC report is not available for this company and period" } };
      }
      if (frozen.accession) return readFilingReport(frozen, frozen.accession);
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
        id, title: `${input.ticker} ${filing.form} (${filing.reportDate || filing.filingDate})`,
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
    registerSearch(batch) {
      if (batch.error) return { sourceId: null, observation: { error: batch.error } };
      const hits = batch.hits.filter((hit) => isHttps(hit.url)).slice(0, 5).map((hit) => {
        let existing = searchHits.get(hit.url);
        if (!existing && searchHits.size < 20) {
          existing = { id: `web-${searchHits.size + 1}`, snippet: hit.snippet.slice(0, 1_500) };
          searchHits.set(hit.url, existing);
        }
        if (!existing) return null;
        sources.set(existing.id, {
          id: existing.id, title: hit.title.slice(0, 240) || batch.query,
          url: hit.url, kind: "web", publishedAt: isoDate(hit.publishedAt), retrievedAt: input.now,
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
  };
}

function isHttps(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
}

function isoDate(value: string | null): string | null {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
