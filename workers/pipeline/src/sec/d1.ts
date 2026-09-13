import { earningsKey } from "./earnings.ts";
import type { SecEarningsGroup } from "../../../../shared/analysis-contract/report.ts";
import { SecAnalysisJobRepository } from "./d1-jobs.ts";
import { loadReportContinuity } from "./continuity.ts";
import { SecMemoryRepository } from "./d1-memory.ts";
import { parseJson, hashJson, type D1Like } from "./d1-support.ts";
export { SEC_ANALYSIS_JOB_LEASE_MS } from "./d1-jobs.ts";
export type { SecAnalysisJobUpdate, SecAnalysisJobStatus } from "./d1-jobs.ts";
export type { SecMemoryJobClaim, SecMemoryExtractionPayload, SecMemoryCommitResult } from "./d1-memory.ts";

import type { SecFiling, SecFilingSummary, SecFilingWithSummary } from "./sec.ts";
import {
  buildPeriodIdentity,
  SEC_ANALYSIS_PROMPT_VERSION,
  type CompanyMemoryItem,
  type FilingBlock,
  type HistoricalObservation,
  type PublishedSecReport,
  type SecHistorySnapshot,
} from "./analysis.ts";
import { buildCompanyMemorySummary } from "./memory.ts";
import type { SecAnalysisArtifact, SecAnalysisContext, SecCacheRecord, SecRepository } from "./types.ts";
import { decodePageCursor, encodePageCursor } from "./config.ts";

export type PublicFilingPage = {
  filings: SecFilingWithSummary[];
  nextCursor: string | null;
};

type PublicFilingRow = {
  filingId: string;
  ticker: string;
  accessionNumber: string;
  cik: string;
  form: string;
  filingDate: string;
  reportDate: string;
  documentUrl: string;
  indexUrl: string;
  companyName?: string | null;
  sortDate?: string;
};

export class D1SecRepository implements SecRepository {
  private readonly database: D1Like;
  private readonly jobs: SecAnalysisJobRepository;
  private readonly memory: SecMemoryRepository;

  constructor(database: D1Like) {
    this.database = database;
    this.jobs = new SecAnalysisJobRepository(database);
    this.memory = new SecMemoryRepository(database);
  }

  async getCache<T>(key: string): Promise<SecCacheRecord<T> | null> {
    const row = await this.database.prepare(`
      SELECT payload, fetched_at AS fetchedAt
      FROM sec_cache
      WHERE cache_key = ?
    `).bind(key).first<{ payload: string; fetchedAt: string }>();
    if (!row) return null;
    try {
      return { payload: JSON.parse(row.payload) as T, fetchedAt: row.fetchedAt };
    } catch {
      return null;
    }
  }

  async setCache<T>(key: string, payload: T, fetchedAt: string): Promise<void> {
    await this.database.prepare(`
      INSERT INTO sec_cache (cache_key, payload, fetched_at)
      VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        payload = excluded.payload,
        fetched_at = excluded.fetched_at
    `).bind(key, JSON.stringify(payload), fetchedAt).run();
  }

  async getSummary(ticker: string, accessionNumber: string): Promise<SecFilingSummary | null> {
    const row = await this.database.prepare(`
      SELECT payload
      FROM sec_filing_summaries
      WHERE ticker = ? AND accession_number = ?
    `).bind(ticker, accessionNumber).first<{ payload: string }>();
    if (!row) return null;
    try {
      return JSON.parse(row.payload) as SecFilingSummary;
    } catch {
      return null;
    }
  }

  async setSummary(filing: Pick<SecFiling, "ticker" | "accessionNumber" | "form">, summary: SecFilingSummary): Promise<void> {
    if (summary.ticker !== filing.ticker || summary.accessionNumber !== filing.accessionNumber || summary.form !== filing.form) {
      throw new Error("SEC summary does not match the filing it is being published against");
    }
    await this.database.prepare(`
      INSERT INTO sec_filing_summaries (ticker, accession_number, generated_at, payload)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ticker, accession_number) DO UPDATE SET
        generated_at = excluded.generated_at,
        payload = excluded.payload
    `).bind(summary.ticker, summary.accessionNumber, summary.generatedAt, JSON.stringify(summary)).run();
  }

  async upsertFilingIndex(filing: SecFiling): Promise<void> {
    await this.database.prepare(`
      INSERT INTO sec_filings (
        filing_id, ticker, accession_number, cik, form, filing_date, report_date,
        document_url, index_url, parser_version, ingest_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sec-structure.v1', 'indexed')
      ON CONFLICT(filing_id) DO UPDATE SET
        ticker = excluded.ticker, accession_number = excluded.accession_number,
        cik = excluded.cik, form = excluded.form, filing_date = excluded.filing_date,
        report_date = excluded.report_date, document_url = excluded.document_url,
        index_url = excluded.index_url, ingest_status = CASE
          WHEN sec_filings.ingest_status = 'analyzed' THEN sec_filings.ingest_status
          ELSE excluded.ingest_status END
    `).bind(
      filing.accessionNumber, filing.ticker, filing.accessionNumber, filing.cik,
      filing.form, filing.filingDate, filing.reportDate, filing.documentUrl, filing.indexUrl,
    ).run();
  }

  /** Durable membership in the existing JSON store; no new database migration. */
  async saveEarningsGroups(filings: SecFiling[]): Promise<void> {
    for (const filing of filings) await this.upsertFilingIndex(filing);
    const statements = filings.filter((filing) => filing.earningsGroup).map((filing) => {
      const group = filing.earningsGroup!;
      const payload = JSON.stringify(group);
      // An older discovery must not regress any member to a smaller source set.
      const anchor = [...group.sources].sort((a, b) => a.filingDate.localeCompare(b.filingDate) || a.accessionNumber.localeCompare(b.accessionNumber))[0];
      return this.database.prepare(`
        INSERT INTO sec_cache (cache_key, payload, fetched_at)
        SELECT ?, ?, ? WHERE NOT EXISTS (
          SELECT 1 FROM sec_cache previous, json_each(previous.payload, '$.sources') old_source
          WHERE previous.cache_key = ? AND NOT EXISTS (
            SELECT 1 FROM json_each(?, '$.sources') new_source
            WHERE json_extract(new_source.value, '$.accessionNumber') = json_extract(old_source.value, '$.accessionNumber')
          )
        )
        ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
      `).bind(earningsKey(filing.ticker, filing.accessionNumber), payload, new Date().toISOString(), earningsKey(filing.ticker, anchor.accessionNumber), payload);
    });
    if (statements.length) {
      if (!this.database.batch) throw new Error("Earnings grouping requires atomic D1 batch");
      await this.database.batch(statements);
    }
  }

  upsertAnalysisJob(...args: Parameters<SecAnalysisJobRepository["upsertAnalysisJob"]>) {
    return this.jobs.upsertAnalysisJob(...args);
  }

  getAnalysisJobStatus(...args: Parameters<SecAnalysisJobRepository["getAnalysisJobStatus"]>) {
    return this.jobs.getAnalysisJobStatus(...args);
  }

  getLatestAnalysisJobStatus(...args: Parameters<SecAnalysisJobRepository["getLatestAnalysisJobStatus"]>) {
    return this.jobs.getLatestAnalysisJobStatus(...args);
  }

  getLatestAnalysisJobSummary(...args: Parameters<SecAnalysisJobRepository["getLatestAnalysisJobSummary"]>) {
    return this.jobs.getLatestAnalysisJobSummary(...args);
  }

  /**
   * A storage failure used to be caught here and returned as `null`, which every caller then
   * rendered as "this filing has no analysis". A D1 outage therefore looked exactly like a filing
   * nobody had analysed yet — an infrastructure failure served as an empty success. The error now
   * propagates so the read router can answer 503, which is the only answer that is true.
   */
  async getPublishedReport(ticker: string, periodId: string): Promise<PublishedSecReport | null> {
    const row = await this.database.prepare(`
      SELECT payload
      FROM sec_published_reports
      WHERE ticker = ? AND period_id = ?
        AND verification_status IN ('verified', 'partial')
      ORDER BY generated_at DESC, rowid DESC
      LIMIT 1
    `).bind(ticker, periodId).first<{ payload: string }>();
    return row ? parseJson<PublishedSecReport>(row.payload) : null;
  }

  async getReportSnapshot(ticker: string, accession: string, reportDate: string, reportVersion: string): Promise<SecFilingWithSummary | null> {
    const row = await this.database.prepare(`
      SELECT payload FROM sec_published_reports
      WHERE ticker = ? AND report_version = ?
        AND verification_status IN ('verified', 'partial')
      LIMIT 1
    `).bind(ticker, reportVersion).first<{ payload: string }>();
    const report = row ? parseJson<PublishedSecReport>(row.payload) : null;
    const snapshot = report?.publication;
    if (!report || !snapshot || snapshot.filing.ticker !== ticker
      || snapshot.filing.accessionNumber !== accession
      || (snapshot.filing.reportDate || snapshot.filing.filingDate) !== reportDate) return null;
    return { ...snapshot.filing, summary: snapshot.summary, analysis: report };
  }

  async listPublicFilings(rawTicker: string, rawCursor: string | null, rawLimit = 20): Promise<PublicFilingPage> {
    const ticker = rawTicker.trim().toUpperCase();
    const limit = Math.min(50, Math.max(1, Math.trunc(rawLimit) || 20));
    const cursor = decodePageCursor(rawCursor);
    const where = cursor
      ? "WHERE ticker = ? AND (sort_date < ? OR (sort_date = ? AND accession_number < ?))"
      : "WHERE ticker = ?";
    const values = cursor
      ? [ticker, cursor.filingDate, cursor.filingDate, cursor.accessionNumber, limit + 1]
      : [ticker, limit + 1];
    const rows = await this.database.prepare(`
      WITH grouped AS (
        SELECT f.*, COALESCE(json_extract(g.payload, '$.earningsDate'), f.filing_date) AS sort_date
        FROM sec_filings f LEFT JOIN sec_cache g ON g.cache_key = 'sec:earnings:' || f.ticker || ':' || f.accession_number
        WHERE g.cache_key IS NULL OR json_extract(g.payload, '$.canonicalAccession') = f.accession_number
      )
      SELECT filing_id AS filingId, ticker, accession_number AS accessionNumber, cik, form,
        filing_date AS filingDate, report_date AS reportDate, document_url AS documentUrl,
        index_url AS indexUrl, sort_date AS sortDate
      FROM grouped ${where}
      ORDER BY sort_date DESC, accession_number DESC LIMIT ?
    `).bind(...values).all<PublicFilingRow>();
    const hasMore = rows.results.length > limit;
    const pageRows = rows.results.slice(0, limit);
    const filings = await Promise.all(pageRows.map((row) => this.hydratePublicFiling(row)));
    const last = pageRows.at(-1);
    return {
      filings,
      nextCursor: hasMore && last ? encodePageCursor({ filingDate: last.sortDate ?? last.filingDate, accessionNumber: last.accessionNumber }) : null,
    };
  }

  /** Counted on its own so paging pays for it once, on the first page, instead of on every page. */
  async countPublicFilings(rawTicker: string): Promise<number> {
    const row = await this.database.prepare(`SELECT COUNT(*) AS count FROM sec_filings f
      LEFT JOIN sec_cache g ON g.cache_key = 'sec:earnings:' || f.ticker || ':' || f.accession_number
      WHERE f.ticker = ? AND (g.cache_key IS NULL OR json_extract(g.payload, '$.canonicalAccession') = f.accession_number)`)
      .bind(rawTicker.trim().toUpperCase()).first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  async getPublicFiling(rawTicker: string, rawAccession: string): Promise<SecFilingWithSummary | null> {
    const group = await this.getCache<SecEarningsGroup>(earningsKey(rawTicker.trim().toUpperCase(), rawAccession));
    const accession = group?.payload.canonicalAccession ?? rawAccession;
    const row = await this.database.prepare(`
      SELECT filing_id AS filingId, ticker, accession_number AS accessionNumber, cik, form,
        filing_date AS filingDate, report_date AS reportDate, document_url AS documentUrl,
        index_url AS indexUrl
      FROM sec_filings
      WHERE ticker = ? AND accession_number = ?
      LIMIT 1
    `).bind(rawTicker.trim().toUpperCase(), accession).first<PublicFilingRow>();
    return row ? this.hydratePublicFiling(row) : null;
  }

  private async hydratePublicFiling(row: PublicFilingRow): Promise<SecFilingWithSummary> {
    const filing: SecFiling = {
      ticker: row.ticker,
      cik: row.cik,
      cikNumber: Number(row.cik.replace(/\D/g, "")) || 0,
      companyName: row.companyName ?? row.ticker,
      form: row.form,
      filingDate: row.filingDate,
      reportDate: row.reportDate,
      accessionNumber: row.accessionNumber,
      primaryDocument: row.documentUrl.split("/").at(-1) ?? "",
      description: row.form,
      items: "",
      documentUrl: row.documentUrl,
      indexUrl: row.indexUrl,
    };
    const group = await this.getCache<SecEarningsGroup>(earningsKey(row.ticker, row.accessionNumber));
    if (group) filing.earningsGroup = group.payload;
    let summary = await this.getSummary(row.ticker, row.accessionNumber);
    if (!summary && group) {
      for (const source of group.payload.sources) {
        summary = await this.getSummary(row.ticker, source.accessionNumber);
        if (summary) break;
      }
    }
    const period = await this.database.prepare(`
      SELECT period_id AS periodId FROM sec_filing_periods WHERE filing_id = ? ORDER BY role = 'primary' DESC LIMIT 1
    `).bind(row.filingId).first<{ periodId: string }>();
    const reportPeriodId = period?.periodId ?? (group && /^(10-K|10-Q|20-F)/.test(row.form)
      ? buildPeriodIdentity(row.ticker, row.form, group.payload.periodEnd).periodId : null);
    const analysis = reportPeriodId ? await this.getPublishedReport(row.ticker, reportPeriodId) : null;
    return { ...filing, summary, analysis };
  }

  async getAnalysisContext(filing: SecFiling): Promise<SecAnalysisContext> {
    const { periodId, periodScope } = buildPeriodIdentity(filing.ticker, filing.form, filing.reportDate);
    const qoqPeriodId = periodScope === "quarter"
      ? (await this.database.prepare(`
        SELECT period_id AS periodId
        FROM sec_periods
        WHERE ticker = ? AND period_scope = 'quarter' AND end_date < ?
        ORDER BY end_date DESC
        LIMIT 1
      `).bind(filing.ticker, filing.reportDate).first<{ periodId: string }>())?.periodId ?? null
      : null;
    const yoyPeriodId = await this.findYearAgoPeriod(filing.ticker, filing.reportDate, periodScope);
    const activeMemoryRows = await this.database.prepare(`
      SELECT memory_id AS memoryId, module_key AS moduleKey, topic_key AS topicKey, statement,
        memory_type AS memoryType, materiality_score AS materialityScore,
        confidence, first_seen_period AS firstSeenPeriod,
        last_confirmed_period AS lastConfirmedPeriod, status, evidence_ids AS evidenceIds,
        kind, horizon, next_test AS nextTest, falsifier, due_period AS duePeriod,
        source_job_ids AS sourceJobIds
      FROM sec_memory_items
      WHERE ticker = ? AND (status IN ('active', 'provisional') OR (status = 'stale' AND due_period IS NOT NULL))
      ORDER BY CASE WHEN due_period IS NOT NULL THEN 0 ELSE 1 END, materiality_score DESC
      LIMIT 20
    `).bind(filing.ticker).all<{
      moduleKey: string;
      topicKey: string;
      statement: string;
      memoryId: string;
      memoryType: "guidance" | "risk" | "commitment" | "definition" | "driver" | "one_off";
      materialityScore: number;
      confidence: "high" | "medium" | "low";
      firstSeenPeriod: string;
      lastConfirmedPeriod: string;
      status: string;
      evidenceIds: string;
      kind: "fact" | "judgment";
      horizon: string | null;
      nextTest: string | null;
      falsifier: string | null;
      duePeriod: string | null;
      sourceJobIds: string;
    }>();
    const thread = await this.database.prepare(`
      SELECT summary FROM sec_company_memory_threads WHERE ticker = ?
    `).bind(filing.ticker).first<{ summary: string }>();
    const historyRows = await this.database.prepare(`
      SELECT fact_id AS observationId, series_id AS seriesId, metric_key AS metricKey,
        value_decimal AS value, unit, currency, basis, observation_start AS startDate,
        observation_end AS endDate, source_accession AS sourceAccession,
        source_filed_at AS sourceFiledAt, source_version AS sourceVersion,
        xbrl_concept AS xbrlConcept, derivation_formula AS derivationFormula,
        dimensions
      FROM sec_facts
      WHERE filing_id IN (SELECT filing_id FROM sec_filings WHERE ticker = ?)
        AND quality_status = 'validated_xbrl'
        AND source_version != 'legacy_unvalidated'
      ORDER BY observation_end DESC, source_filed_at DESC
    `).bind(filing.ticker).all<{
      observationId: string; seriesId: HistoricalObservation["seriesId"]; metricKey: string; value: string; unit: string; currency: string;
      basis: "gaap" | "derived"; startDate: string | null; endDate: string; sourceAccession: string; sourceFiledAt: string; sourceVersion: string;
      xbrlConcept: string; derivationFormula: string; dimensions: string;
    }>();
    const history = historyFromRows(historyRows.results);
    const memoryItems: CompanyMemoryItem[] = activeMemoryRows.results.map((row) => ({
      memoryId: row.memoryId,
      ticker: filing.ticker,
      kind: row.kind,
      topicKey: row.topicKey,
      statement: row.statement,
      status: row.status as CompanyMemoryItem["status"],
      materialityScore: row.materialityScore,
      confidence: row.confidence,
      evidenceIds: parseJson<string[]>(row.evidenceIds) ?? [],
      firstSeenPeriod: row.firstSeenPeriod,
      lastConfirmedPeriod: row.lastConfirmedPeriod,
      horizon: row.horizon ?? undefined,
      nextTest: row.nextTest ?? undefined,
      falsifier: row.falsifier ?? undefined,
      duePeriod: row.duePeriod ?? undefined,
      sourceJobIds: parseJson<string[]>(row.sourceJobIds) ?? [],
    }));
    return {
      currentPeriodId: periodId,
      reportContinuity: await loadReportContinuity(this.database, filing),
      qoqPeriodId,
      yoyPeriodId,
      history,
      companyMemorySummary: (thread?.summary ?? buildCompanyMemorySummary(memoryItems)).slice(0, 2_500),
      memoryItems,
    };
  }

  async saveHistory(filing: SecFiling, history: SecHistorySnapshot): Promise<void> {
    await this.database.prepare(`
      INSERT INTO sec_filings (
        filing_id, ticker, accession_number, cik, form, filing_date, report_date,
        document_url, index_url, parser_version, ingest_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sec-structure.v1', 'history_loaded')
      ON CONFLICT(filing_id) DO UPDATE SET ticker = excluded.ticker, ingest_status = excluded.ingest_status
    `).bind(
      filing.accessionNumber, filing.ticker, filing.accessionNumber, filing.cik, filing.form,
      filing.filingDate, filing.reportDate, filing.documentUrl, filing.indexUrl,
    ).run();
    for (const series of history.series) {
      for (const observation of [...series.quarters, ...series.annual]) await this.saveHistoricalObservation(filing, observation);
    }
  }

  async saveFilingBlocks(filing: SecFiling, blocks: FilingBlock[]): Promise<void> {
    if (!this.database.batch) throw new Error("D1 batch is required for SEC evidence writes");
    await this.upsertAnalyzedFiling(filing);
    if (!blocks.length) return;
    const statements = blocks.flatMap((block) => [
      this.database.prepare(`
        INSERT INTO sec_filing_blocks (
          block_id, filing_id, ordinal, heading, heading_path, element_type,
          preview, body, token_count, numeric_density, table_count, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(filing_id, ordinal) DO UPDATE SET
          block_id = excluded.block_id,
          heading = excluded.heading, heading_path = excluded.heading_path,
          element_type = excluded.element_type,
          preview = excluded.preview, body = excluded.body,
          token_count = excluded.token_count, numeric_density = excluded.numeric_density,
          table_count = excluded.table_count, content_hash = excluded.content_hash
      `).bind(
        block.blockId,
        filing.accessionNumber,
        block.ordinal,
        block.heading,
        block.headingPath,
        block.elementType,
        block.preview,
        block.body,
        block.tokenCount,
        block.numericDensity,
        block.tableCount,
        block.contentHash,
      ),
      this.database.prepare(`
        INSERT INTO sec_evidence (evidence_id, filing_id, block_id, locator, excerpt, source_rank, excerpt_hash)
        VALUES (?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(evidence_id) DO UPDATE SET excerpt = excluded.excerpt, excerpt_hash = excluded.excerpt_hash
      `).bind(`ev:${block.blockId}`, filing.accessionNumber, block.blockId, `block:${block.ordinal}`, block.body.slice(0, 900), block.contentHash),
    ]);
    await this.database.batch(statements);
  }

  private async upsertAnalyzedFiling(filing: SecFiling): Promise<void> {
    await this.database.prepare(`
      INSERT INTO sec_filings (
        filing_id, ticker, accession_number, cik, form, filing_date, report_date,
        document_url, index_url, parser_version, ingest_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'analyzed')
      ON CONFLICT(filing_id) DO UPDATE SET
        form = excluded.form,
        filing_date = excluded.filing_date,
        report_date = excluded.report_date,
        document_url = excluded.document_url,
        index_url = excluded.index_url,
        parser_version = excluded.parser_version,
        ingest_status = excluded.ingest_status
    `).bind(
      filing.accessionNumber,
      filing.ticker,
      filing.accessionNumber,
      filing.cik,
      filing.form,
      filing.filingDate,
      filing.reportDate,
      filing.documentUrl,
      filing.indexUrl,
      "sec-structure.v1",
    ).run();
  }

  async saveAnalysis(artifact: SecAnalysisArtifact, includePublication = true): Promise<void> {
    const filing = artifact.filing;
    await this.upsertAnalyzedFiling(filing);

    const qoqPeriodId = artifact.comparisons.find((comparison) => comparison.comparisonType === "qoq")?.priorPeriodId ?? null;
    const yoyPeriodId = artifact.comparisons.find((comparison) => comparison.comparisonType === "yoy")?.priorPeriodId ?? null;
    await this.database.prepare(`
      INSERT INTO sec_periods (
        period_id, ticker, fiscal_year, fiscal_quarter, period_scope,
        end_date, qoq_period_id, yoy_period_id
      ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT(period_id) DO UPDATE SET
        qoq_period_id = excluded.qoq_period_id,
        yoy_period_id = excluded.yoy_period_id
    `).bind(artifact.periodId, filing.ticker, artifact.periodScope, filing.reportDate, qoqPeriodId, yoyPeriodId).run();
    await this.database.prepare(`
      INSERT OR IGNORE INTO sec_filing_periods (filing_id, period_id, role)
      VALUES (?, ?, ?)
    `).bind(filing.accessionNumber, artifact.periodId, "primary").run();

    for (const comparison of artifact.comparisons) {
      const comparisonId = `${comparison.currentPeriodId}:${comparison.priorPeriodId}:${comparison.comparisonType}`;
      await this.database.prepare(`
        INSERT INTO sec_comparisons (
          comparison_id, ticker, current_period_id, prior_period_id,
          comparison_type, comparability, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(comparison_id) DO UPDATE SET
          comparability = excluded.comparability, payload = excluded.payload
      `).bind(comparisonId, filing.ticker, comparison.currentPeriodId, comparison.priorPeriodId, comparison.comparisonType, comparison.comparability, JSON.stringify(comparison)).run();
    }

    if (includePublication && artifact.report.dataQuality.verificationStatus !== "failed") {
      await this.database.prepare(`
        INSERT INTO sec_published_reports (ticker, period_id, report_version, payload, verification_status)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(ticker, period_id, report_version) DO NOTHING
      `).bind(filing.ticker, artifact.periodId, artifact.report.reportVersion, JSON.stringify(artifact.report), artifact.report.dataQuality.verificationStatus).run();
    }

    const runTime = new Date().toISOString();
    const stages = [
      ...(artifact.brief ? [{ stage: "brief", input: artifact.brief, status: artifact.brief.missingSeriesIds.length ? "partial" : "complete", outputR2Key: artifact.artifactKeys?.brief }] : []),
      ...(artifact.artifactKeys?.plan ? [{ stage: "manager-plan", input: artifact.artifactKeys.plan, status: "complete", outputR2Key: artifact.artifactKeys.plan }] : []),
      ...(artifact.artifactKeys?.nodes ? [{ stage: "nodes", input: artifact.artifactKeys.nodes, status: artifact.managerReview?.status ?? "complete", outputR2Key: artifact.artifactKeys.nodes }] : []),
      ...(artifact.managerReview ? [{ stage: "manager-review", input: artifact.managerReview, status: artifact.managerReview.status, outputR2Key: artifact.artifactKeys?.["manager-review"] }] : []),
      { stage: "summary", input: artifact.report, status: artifact.report.dataQuality.verificationStatus, outputR2Key: artifact.artifactKeys?.synthesis },
    ];
    for (const stage of stages) {
      const runId = `${filing.accessionNumber}:${stage.stage}:${hashJson(stage.input)}`;
      const round = Number(stage.stage.match(/round[-:]?(\d+)/)?.[1] ?? 0);
      await this.database.prepare(`
        INSERT OR IGNORE INTO sec_analysis_runs (
          run_id, ticker, filing_id, stage, input_hash,
          model_version, prompt_version, status, token_usage, started_at, completed_at,
          output_r2_key, round, stop_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)
      `).bind(
        runId,
        filing.ticker,
        filing.accessionNumber,
        stage.stage,
        hashJson(stage.input),
        "runtime-model",
        SEC_ANALYSIS_PROMPT_VERSION,
        stage.status,
        runTime,
        runTime,
        stage.outputR2Key ?? null,
        round,
        artifact.managerReview?.stopReason ?? null,
      ).run();
    }
  }

  async commitFinalPublication(artifact: SecAnalysisArtifact, summary: SecFilingSummary): Promise<string> {
    if (artifact.report.dataQuality.verificationStatus === "failed") throw new Error("Failed SEC analysis cannot be published");
    if (summary.ticker !== artifact.filing.ticker || summary.accessionNumber !== artifact.filing.accessionNumber) {
      throw new Error("SEC summary does not match the filing it is being published against");
    }
    if (!this.database.batch) throw new Error("D1 batch is required for atomic SEC publication");
    const memoryJobId = `${artifact.filing.ticker}:${artifact.periodId}:${artifact.report.reportVersion}:memory`;
    const sourceR2Key = artifact.artifactKeys?.synthesis;
    if (!sourceR2Key) throw new Error("SEC publication is missing its R2 memory source");
    const statements = [
      this.database.prepare(`
        INSERT INTO sec_published_reports (ticker, period_id, report_version, payload, verification_status)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(ticker, period_id, report_version) DO NOTHING
      `).bind(artifact.filing.ticker, artifact.periodId, artifact.report.reportVersion, JSON.stringify(artifact.report), artifact.report.dataQuality.verificationStatus),
      this.database.prepare(`
        INSERT INTO sec_filing_summaries (ticker, accession_number, generated_at, payload)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(ticker, accession_number) DO UPDATE SET generated_at = excluded.generated_at, payload = excluded.payload
      `).bind(summary.ticker, summary.accessionNumber, summary.generatedAt, JSON.stringify(summary)),
      this.database.prepare(`
        INSERT INTO sec_memory_jobs (job_id, ticker, filing_id, period_id, status, source_r2_key, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(job_id) DO NOTHING
      `).bind(memoryJobId, artifact.filing.ticker, artifact.filing.accessionNumber, artifact.periodId, sourceR2Key),
    ];
    await this.database.batch(statements);
    return memoryJobId;
  }

  claimMemoryJob(...args: Parameters<SecMemoryRepository["claimMemoryJob"]>) {
    return this.memory.claimMemoryJob(...args);
  }

  commitMemoryJob(...args: Parameters<SecMemoryRepository["commitMemoryJob"]>) {
    return this.memory.commitMemoryJob(...args);
  }

  private async saveHistoricalObservation(filing: SecFiling, observation: HistoricalObservation): Promise<void> {
    const periodId = `${filing.ticker}:${observation.endDate}:${observation.periodScope}`;
    const dimensions = {
      ticker: filing.ticker,
      periodScope: observation.periodScope,
      startDate: observation.startDate ?? "",
      endDate: observation.endDate,
      unit: observation.unit,
      currency: observation.currency ?? "",
    };
    const dimensionsHash = hashJson(dimensions);
    await this.database.prepare(`
      INSERT INTO sec_periods (period_id, ticker, fiscal_year, fiscal_quarter, period_scope, start_date, end_date, duration_days)
      VALUES (?, ?, NULL, NULL, ?, ?, ?, NULL)
      ON CONFLICT(period_id) DO UPDATE SET start_date = excluded.start_date, end_date = excluded.end_date
    `).bind(periodId, filing.ticker, observation.periodScope, observation.startDate ?? null, observation.endDate).run();
    await this.database.prepare(`
      INSERT INTO sec_facts (
        fact_id, filing_id, period_id, metric_key, series_id, dimensions_hash, dimensions,
        value_decimal, raw_value, unit, currency, basis, evidence_label, xbrl_concept,
        context_ref, derivation_formula, evidence_id, quality_status, observation_start,
        observation_end, source_filed_at, source_accession, source_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fact_source_reported', ?, '', ?, ?, 'validated_xbrl', ?, ?, ?, ?, ?)
      ON CONFLICT(period_id, series_id, dimensions_hash, basis) DO UPDATE SET
        filing_id = excluded.filing_id,
        value_decimal = excluded.value_decimal,
        raw_value = excluded.raw_value,
        unit = excluded.unit,
        currency = excluded.currency,
        xbrl_concept = excluded.xbrl_concept,
        derivation_formula = excluded.derivation_formula,
        evidence_id = excluded.evidence_id,
        quality_status = excluded.quality_status,
        observation_start = excluded.observation_start,
        observation_end = excluded.observation_end,
        source_filed_at = excluded.source_filed_at,
        source_accession = excluded.source_accession,
        source_version = excluded.source_version
      WHERE excluded.source_filed_at >= sec_facts.source_filed_at
    `).bind(
      observation.observationId,
      filing.accessionNumber,
      periodId,
      observation.metricKey,
      observation.seriesId,
      dimensionsHash,
      JSON.stringify(dimensions),
      observation.value,
      observation.value,
      observation.unit,
      observation.currency ?? "",
      observation.basis,
      observation.xbrlConcept ?? "",
      observation.derivationFormula ?? "",
      `xbrl:${observation.sourceAccession}:${observation.xbrlConcept ?? observation.seriesId}`,
      observation.startDate ?? null,
      observation.endDate,
      observation.sourceFiledAt,
      observation.sourceAccession,
      observation.sourceVersion,
    ).run();
  }

  private async findYearAgoPeriod(ticker: string, reportDate: string, periodScope: string): Promise<string | null> {
    if (periodScope === "annual") {
      return (await this.database.prepare(`
        SELECT period_id AS periodId FROM sec_periods
        WHERE ticker = ? AND period_scope = 'annual' AND end_date < ?
        ORDER BY end_date DESC LIMIT 1
      `).bind(ticker, reportDate).first<{ periodId: string }>())?.periodId ?? null;
    }
    return (await this.database.prepare(`
      SELECT period_id AS periodId FROM sec_periods
      WHERE ticker = ? AND period_scope = 'quarter'
        AND end_date <= date(?, '-300 day')
        AND end_date >= date(?, '-450 day')
      ORDER BY end_date DESC LIMIT 1
    `).bind(ticker, reportDate, reportDate).first<{ periodId: string }>())?.periodId ?? null;
  }

}

function historyFromRows(rows: Array<{
  observationId: string; seriesId: HistoricalObservation["seriesId"]; metricKey: string; value: string; unit: string; currency: string;
  basis: "gaap" | "derived"; startDate: string | null; endDate: string; sourceAccession: string; sourceFiledAt: string; sourceVersion: string;
  xbrlConcept: string; derivationFormula: string; dimensions: string;
}>): SecHistorySnapshot {
  const observations: HistoricalObservation[] = rows.flatMap((row) => {
    const dimensions = parseJson<{ periodScope?: "quarter" | "annual" }>(row.dimensions);
    const periodScope = dimensions?.periodScope;
    if (periodScope !== "quarter" && periodScope !== "annual") return [];
    return [{
      observationId: row.observationId,
      seriesId: row.seriesId,
      metricKey: row.metricKey,
      value: row.value,
      unit: row.unit,
      currency: row.currency || undefined,
      basis: row.basis,
      periodScope,
      startDate: row.startDate ?? undefined,
      endDate: row.endDate,
      sourceAccession: row.sourceAccession,
      sourceFiledAt: row.sourceFiledAt,
      sourceVersion: row.sourceVersion,
      qualityStatus: "validated_xbrl",
      xbrlConcept: row.xbrlConcept || undefined,
      derivationFormula: row.derivationFormula || undefined,
    }];
  });
  return {
    registryVersion: observations[0]?.sourceVersion ?? "sec-canonical-series.v1",
    series: [...new Set(observations.map((item) => item.seriesId))].map((seriesId) => ({
      seriesId,
      quarters: observations.filter((item) => item.seriesId === seriesId && item.periodScope === "quarter").slice(0, 8),
      annual: observations.filter((item) => item.seriesId === seriesId && item.periodScope === "annual").slice(0, 5),
    })),
  };
}
