import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export * from "./fundamentals-schema.ts";

export const secCache = sqliteTable("sec_cache", {
  cacheKey: text("cache_key").primaryKey(),
  payload: text("payload").notNull(),
  fetchedAt: text("fetched_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const secFilingSummaries = sqliteTable("sec_filing_summaries", {
  ticker: text("ticker").notNull(),
  accessionNumber: text("accession_number").notNull(),
  generatedAt: text("generated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  payload: text("payload").notNull(),
}, (table) => [
  primaryKey({ columns: [table.ticker, table.accessionNumber] }),
]);

export const secFilings = sqliteTable("sec_filings", {
  filingId: text("filing_id").primaryKey(),
  ticker: text("ticker").notNull(),
  accessionNumber: text("accession_number").notNull(),
  cik: text("cik").notNull(),
  form: text("form").notNull(),
  filingDate: text("filing_date").notNull(),
  reportDate: text("report_date").notNull(),
  documentUrl: text("document_url").notNull(),
  indexUrl: text("index_url").notNull(),
  contentHash: text("content_hash").notNull().default(""),
  parserVersion: text("parser_version").notNull().default("sec-structure.v1"),
  ingestStatus: text("ingest_status").notNull().default("indexed"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("sec_filings_ticker_accession_idx").on(table.ticker, table.accessionNumber)]);

export const secPeriods = sqliteTable("sec_periods", {
  periodId: text("period_id").primaryKey(),
  ticker: text("ticker").notNull(),
  fiscalYear: integer("fiscal_year"),
  fiscalQuarter: text("fiscal_quarter"),
  periodScope: text("period_scope").notNull(),
  startDate: text("start_date"),
  endDate: text("end_date").notNull(),
  durationDays: integer("duration_days"),
  qoqPeriodId: text("qoq_period_id"),
  yoyPeriodId: text("yoy_period_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("sec_periods_identity_idx").on(table.ticker, table.fiscalYear, table.fiscalQuarter, table.periodScope)]);

export const secFilingPeriods = sqliteTable("sec_filing_periods", {
  filingId: text("filing_id").notNull(),
  periodId: text("period_id").notNull(),
  role: text("role").notNull(),
}, (table) => [primaryKey({ columns: [table.filingId, table.periodId, table.role] })]);

export const secFilingBlocks = sqliteTable("sec_filing_blocks", {
  blockId: text("block_id").primaryKey(),
  filingId: text("filing_id").notNull(),
  parentBlockId: text("parent_block_id"),
  ordinal: integer("ordinal").notNull(),
  heading: text("heading").notNull(),
  headingPath: text("heading_path").notNull(),
  elementType: text("element_type").notNull(),
  preview: text("preview").notNull(),
  body: text("body").notNull(),
  tokenCount: integer("token_count").notNull(),
  numericDensity: integer("numeric_density").notNull(),
  tableCount: integer("table_count").notNull(),
  contentHash: text("content_hash").notNull(),
}, (table) => [uniqueIndex("sec_filing_blocks_filing_ordinal_idx").on(table.filingId, table.ordinal)]);

export const secEvidence = sqliteTable("sec_evidence", {
  evidenceId: text("evidence_id").primaryKey(),
  filingId: text("filing_id").notNull(),
  blockId: text("block_id").notNull(),
  locator: text("locator").notNull().default(""),
  excerpt: text("excerpt").notNull(),
  sourceRank: integer("source_rank").notNull().default(1),
  excerptHash: text("excerpt_hash").notNull(),
});

export const secFacts = sqliteTable("sec_facts", {
  factId: text("fact_id").primaryKey(),
  filingId: text("filing_id").notNull(),
  periodId: text("period_id").notNull(),
  metricKey: text("metric_key").notNull(),
  seriesId: text("series_id").notNull(),
  dimensionsHash: text("dimensions_hash").notNull().default(""),
  dimensions: text("dimensions").notNull().default("{}"),
  valueDecimal: text("value_decimal").notNull(),
  rawValue: text("raw_value").notNull().default(""),
  unit: text("unit").notNull(),
  currency: text("currency").notNull().default(""),
  basis: text("basis").notNull(),
  evidenceLabel: text("evidence_label").notNull(),
  xbrlConcept: text("xbrl_concept").notNull().default(""),
  contextRef: text("context_ref").notNull().default(""),
  derivationFormula: text("derivation_formula").notNull().default(""),
  evidenceId: text("evidence_id").notNull(),
  qualityStatus: text("quality_status").notNull().default("unverified"),
  observationStart: text("observation_start"),
  observationEnd: text("observation_end").notNull().default(""),
  sourceFiledAt: text("source_filed_at").notNull().default(""),
  sourceAccession: text("source_accession").notNull().default(""),
  sourceVersion: text("source_version").notNull().default("legacy_unvalidated"),
}, (table) => [uniqueIndex("sec_facts_period_series_idx").on(table.periodId, table.seriesId, table.dimensionsHash, table.basis)]);

export const secModuleSnapshots = sqliteTable("sec_module_snapshots", {
  snapshotId: text("snapshot_id").primaryKey(),
  ticker: text("ticker").notNull(),
  periodId: text("period_id").notNull(),
  filingId: text("filing_id").notNull(),
  moduleKey: text("module_key").notNull(),
  inputHash: text("input_hash").notNull(),
  schemaVersion: text("schema_version").notNull(),
  modelVersion: text("model_version").notNull(),
  promptVersion: text("prompt_version").notNull(),
  payload: text("payload").notNull(),
  evidenceCoverage: integer("evidence_coverage").notNull().default(0),
  verificationStatus: text("verification_status").notNull().default("pending"),
  generatedAt: text("generated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("sec_module_snapshots_identity_idx").on(table.periodId, table.moduleKey, table.inputHash)]);

export const secMemoryItems = sqliteTable("sec_memory_items", {
  memoryId: text("memory_id").primaryKey(),
  ticker: text("ticker").notNull(),
  moduleKey: text("module_key").notNull(),
  topicKey: text("topic_key").notNull(),
  memoryType: text("memory_type").notNull(),
  statement: text("statement").notNull(),
  normalizedValue: text("normalized_value").notNull().default("{}"),
  firstSeenPeriod: text("first_seen_period").notNull(),
  lastConfirmedPeriod: text("last_confirmed_period").notNull(),
  expectedResolutionPeriod: text("expected_resolution_period"),
  status: text("status").notNull().default("active"),
  materialityScore: integer("materiality_score").notNull().default(0),
  confidence: text("confidence").notNull().default("medium"),
  evidenceIds: text("evidence_ids").notNull().default("[]"),
  kind: text("kind").notNull().default("fact"),
  horizon: text("horizon"),
  nextTest: text("next_test"),
  falsifier: text("falsifier"),
  duePeriod: text("due_period"),
  sourceJobIds: text("source_job_ids").notNull().default("[]"),
  normalizedKey: text("normalized_key").notNull().default(""),
  version: integer("version").notNull().default(1),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("sec_memory_items_ticker_status_due_idx").on(table.ticker, table.status, table.duePeriod)]);

export const secMemoryEvents = sqliteTable("sec_memory_events", {
  eventId: text("event_id").primaryKey(),
  memoryId: text("memory_id").notNull(),
  ticker: text("ticker").notNull(),
  periodId: text("period_id").notNull(),
  eventType: text("event_type").notNull(),
  currentStatement: text("current_statement"),
  priorStatement: text("prior_statement"),
  evidenceIds: text("evidence_ids").notNull().default("[]"),
  jobId: text("job_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const secMemoryJobs = sqliteTable("sec_memory_jobs", {
  jobId: text("job_id").primaryKey(),
  ticker: text("ticker").notNull(),
  filingId: text("filing_id").notNull(),
  periodId: text("period_id").notNull(),
  status: text("status").notNull().default("pending"),
  sourceR2Key: text("source_r2_key").notNull(),
  ownerToken: text("owner_token"),
  leaseUntil: text("lease_until"),
  attempt: integer("attempt").notNull().default(0),
  error: text("error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
}, (table) => [index("sec_memory_jobs_status_created_idx").on(table.status, table.createdAt)]);

export const secMemoryExtractions = sqliteTable("sec_memory_extractions", {
  extractionId: text("extraction_id").primaryKey(),
  jobId: text("job_id").notNull(),
  ticker: text("ticker").notNull(),
  periodId: text("period_id").notNull(),
  payload: text("payload").notNull(),
  inputHash: text("input_hash").notNull(),
  schemaVersion: text("schema_version").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("sec_memory_extractions_job_idx").on(table.jobId)]);

export const secCompanyMemoryThreads = sqliteTable("sec_company_memory_threads", {
  ticker: text("ticker").primaryKey(),
  summary: text("summary").notNull().default(""),
  version: integer("version").notNull().default(0),
  leaseOwner: text("lease_owner"),
  leaseUntil: text("lease_until"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const secComparisons = sqliteTable("sec_comparisons", {
  comparisonId: text("comparison_id").primaryKey(),
  ticker: text("ticker").notNull(),
  currentPeriodId: text("current_period_id").notNull(),
  priorPeriodId: text("prior_period_id").notNull(),
  comparisonType: text("comparison_type").notNull(),
  comparability: text("comparability").notNull(),
  payload: text("payload").notNull(),
  generatedAt: text("generated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("sec_comparisons_identity_idx").on(table.currentPeriodId, table.priorPeriodId, table.comparisonType)]);

export const secAnalysisRuns = sqliteTable("sec_analysis_runs", {
  runId: text("run_id").primaryKey(),
  ticker: text("ticker").notNull(),
  filingId: text("filing_id").notNull(),
  stage: text("stage").notNull(),
  inputHash: text("input_hash").notNull(),
  modelVersion: text("model_version").notNull(),
  promptVersion: text("prompt_version").notNull(),
  status: text("status").notNull(),
  error: text("error"),
  tokenUsage: text("token_usage").notNull().default("{}"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  outputR2Key: text("output_r2_key"),
  round: integer("round").notNull().default(0),
  stopReason: text("stop_reason"),
});

export const secAnalysisJobs = sqliteTable("sec_analysis_jobs", {
  jobId: text("job_id").primaryKey(),
  ticker: text("ticker").notNull(),
  accessionNumber: text("accession_number").notNull(),
  analysisVersion: text("analysis_version").notNull(),
  status: text("status").notNull(),
  currentStage: text("current_stage").notNull(),
  attempt: integer("attempt").notNull().default(1),
  errorCode: text("error_code"),
  errorDetail: text("error_detail"),
  requestedBy: text("requested_by").notNull(),
  workflowInstanceId: text("workflow_instance_id").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
}, (table) => [index("sec_analysis_jobs_filing_version_idx").on(table.ticker, table.accessionNumber, table.analysisVersion)]);

export const companyAnalysisRuns = sqliteTable("company_analysis_runs", {
  analysisId: text("analysis_id").primaryKey(),
  workflowInstanceId: text("workflow_instance_id"),
  recoveryCount: integer("recovery_count").notNull().default(0),
  ticker: text("ticker").notNull(),
  triggerRef: text("trigger_ref").notNull(),
  periodId: text("period_id").notNull(),
  periodEnd: text("period_end"),
  reportLabel: text("report_label"),
  inputHash: text("input_hash"),
  memoryVersion: integer("memory_version").notNull(),
  fundamentalsDataVersion: text("fundamentals_data_version"),
  status: text("status").notNull(),
  coverageStatus: text("coverage_status"),
  overviewJson: text("overview_json"),
  modelVersion: text("model_version").notNull(),
  promptVersion: text("prompt_version").notNull(),
  errorCode: text("error_code"),
  errorDetail: text("error_detail"),
  generatedAt: text("generated_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("company_analysis_runs_trigger_idx").on(table.triggerRef),
  uniqueIndex("company_analysis_runs_input_idx").on(table.ticker, table.inputHash).where(sql`${table.inputHash} IS NOT NULL`),
  index("company_analysis_runs_latest_idx").on(table.ticker, table.status, table.generatedAt),
  index("company_analysis_runs_recovery_idx").on(table.status, table.updatedAt),
]);

export const secPublishedReports = sqliteTable("sec_published_reports", {
  ticker: text("ticker").notNull(),
  periodId: text("period_id").notNull(),
  reportVersion: text("report_version").notNull(),
  payload: text("payload").notNull(),
  verificationStatus: text("verification_status").notNull(),
  generatedAt: text("generated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [primaryKey({ columns: [table.ticker, table.periodId, table.reportVersion] })]);

/** Shared research evidence cache; bodies live under web-search/v1 in R2. */
export const webSearchCache = sqliteTable("web_search_cache", {
  cacheKey: text("cache_key").primaryKey().notNull(),
  objectKey: text("object_key"),
  leaseOwner: text("lease_owner"),
  leaseUntil: integer("lease_until").notNull().default(0),
});

/** Single-user research universe, synchronized from the portfolio service. */
export const researchState = sqliteTable("research_state", {
  key: text("key").primaryKey().notNull(),
  payload: text("payload").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const researchEvents = sqliteTable("research_events", {
  id: text("id").primaryKey().notNull(),
  ticker: text("ticker").notNull(),
  kind: text("kind").notNull(),
  payload: text("payload").notNull(),
  observedAt: text("observed_at").notNull(),
  sourceAt: text("source_at"),
});

/** A durable dispatch outbox: inserting an event never depends on Workflow availability. */
export const researchCases = sqliteTable("research_cases", {
  id: text("id").primaryKey().notNull(),
  eventId: text("event_id").notNull(),
  ticker: text("ticker").notNull(),
  status: text("status").notNull().default("pending"),
  workflowId: text("workflow_id").notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: text("next_attempt_at").notNull(),
  leaseOwner: text("lease_owner"),
  leaseUntil: text("lease_until"),
  errorCode: text("error_code"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, table => [
  uniqueIndex("research_cases_event_idx").on(table.eventId),
  index("research_cases_dispatch_idx").on(table.status, table.nextAttemptAt),
]);

export const researchReports = sqliteTable("research_reports", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  id: text("id").notNull(),
  caseId: text("case_id").notNull(),
  payload: text("payload").notNull(),
  generatedAt: text("generated_at").notNull(),
}, table => [
  uniqueIndex("research_reports_id_idx").on(table.id),
  uniqueIndex("research_reports_case_idx").on(table.caseId),
]);

export const researchFollowups = sqliteTable("research_followups", {
  id: text("id").primaryKey().notNull(),
  caseId: text("case_id").notNull(),
  ticker: text("ticker").notNull(),
  question: text("question").notNull(),
  query: text("query").notNull(),
  dueAt: text("due_at").notNull(),
  status: text("status").notNull().default("pending"),
}, table => [index("research_followups_due_idx").on(table.status, table.dueAt)]);

export const researchBudget = sqliteTable("research_budget", {
  day: text("day").primaryKey().notNull(),
  investigations: integer("investigations").notNull().default(0),
});
