CREATE TABLE `sec_analysis_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`filing_id` text NOT NULL,
	`stage` text NOT NULL,
	`input_hash` text NOT NULL,
	`model_version` text NOT NULL,
	`prompt_version` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`token_usage` text DEFAULT '{}' NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `sec_comparisons` (
	`comparison_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`current_period_id` text NOT NULL,
	`prior_period_id` text NOT NULL,
	`comparison_type` text NOT NULL,
	`comparability` text NOT NULL,
	`payload` text NOT NULL,
	`generated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sec_comparisons_identity_idx` ON `sec_comparisons` (`current_period_id`,`prior_period_id`,`comparison_type`);--> statement-breakpoint
CREATE TABLE `sec_evidence` (
	`evidence_id` text PRIMARY KEY NOT NULL,
	`filing_id` text NOT NULL,
	`block_id` text NOT NULL,
	`locator` text DEFAULT '' NOT NULL,
	`excerpt` text NOT NULL,
	`source_rank` integer DEFAULT 1 NOT NULL,
	`excerpt_hash` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sec_facts` (
	`fact_id` text PRIMARY KEY NOT NULL,
	`filing_id` text NOT NULL,
	`period_id` text NOT NULL,
	`metric_key` text NOT NULL,
	`series_id` text NOT NULL,
	`dimensions_hash` text DEFAULT '' NOT NULL,
	`dimensions` text DEFAULT '{}' NOT NULL,
	`value_decimal` text NOT NULL,
	`raw_value` text DEFAULT '' NOT NULL,
	`unit` text NOT NULL,
	`currency` text DEFAULT '' NOT NULL,
	`basis` text NOT NULL,
	`evidence_label` text NOT NULL,
	`xbrl_concept` text DEFAULT '' NOT NULL,
	`context_ref` text DEFAULT '' NOT NULL,
	`derivation_formula` text DEFAULT '' NOT NULL,
	`evidence_id` text NOT NULL,
	`quality_status` text DEFAULT 'unverified' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sec_facts_period_series_idx` ON `sec_facts` (`period_id`,`series_id`,`dimensions_hash`,`basis`);--> statement-breakpoint
CREATE TABLE `sec_filing_blocks` (
	`block_id` text PRIMARY KEY NOT NULL,
	`filing_id` text NOT NULL,
	`parent_block_id` text,
	`ordinal` integer NOT NULL,
	`heading` text NOT NULL,
	`heading_path` text NOT NULL,
	`element_type` text NOT NULL,
	`preview` text NOT NULL,
	`body` text NOT NULL,
	`token_count` integer NOT NULL,
	`numeric_density` integer NOT NULL,
	`table_count` integer NOT NULL,
	`content_hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sec_filing_blocks_filing_ordinal_idx` ON `sec_filing_blocks` (`filing_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `sec_filing_periods` (
	`filing_id` text NOT NULL,
	`period_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`filing_id`, `period_id`, `role`)
);
--> statement-breakpoint
CREATE TABLE `sec_filings` (
	`filing_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`accession_number` text NOT NULL,
	`cik` text NOT NULL,
	`form` text NOT NULL,
	`filing_date` text NOT NULL,
	`report_date` text NOT NULL,
	`document_url` text NOT NULL,
	`index_url` text NOT NULL,
	`content_hash` text DEFAULT '' NOT NULL,
	`parser_version` text DEFAULT 'sec-structure.v1' NOT NULL,
	`ingest_status` text DEFAULT 'indexed' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sec_filings_ticker_accession_idx` ON `sec_filings` (`ticker`,`accession_number`);--> statement-breakpoint
CREATE TABLE `sec_memory_items` (
	`memory_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`module_key` text NOT NULL,
	`topic_key` text NOT NULL,
	`memory_type` text NOT NULL,
	`statement` text NOT NULL,
	`normalized_value` text DEFAULT '{}' NOT NULL,
	`first_seen_period` text NOT NULL,
	`last_confirmed_period` text NOT NULL,
	`expected_resolution_period` text,
	`status` text DEFAULT 'active' NOT NULL,
	`materiality_score` integer DEFAULT 0 NOT NULL,
	`confidence` text DEFAULT 'medium' NOT NULL,
	`evidence_ids` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sec_module_snapshots` (
	`snapshot_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`period_id` text NOT NULL,
	`filing_id` text NOT NULL,
	`module_key` text NOT NULL,
	`input_hash` text NOT NULL,
	`schema_version` text NOT NULL,
	`model_version` text NOT NULL,
	`prompt_version` text NOT NULL,
	`payload` text NOT NULL,
	`evidence_coverage` integer DEFAULT 0 NOT NULL,
	`verification_status` text DEFAULT 'pending' NOT NULL,
	`generated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sec_module_snapshots_identity_idx` ON `sec_module_snapshots` (`period_id`,`module_key`,`input_hash`);--> statement-breakpoint
CREATE TABLE `sec_periods` (
	`period_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`fiscal_year` integer,
	`fiscal_quarter` text,
	`period_scope` text NOT NULL,
	`start_date` text,
	`end_date` text NOT NULL,
	`duration_days` integer,
	`qoq_period_id` text,
	`yoy_period_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sec_periods_identity_idx` ON `sec_periods` (`ticker`,`fiscal_year`,`fiscal_quarter`,`period_scope`);--> statement-breakpoint
CREATE TABLE `sec_published_reports` (
	`ticker` text NOT NULL,
	`period_id` text NOT NULL,
	`report_version` text NOT NULL,
	`payload` text NOT NULL,
	`verification_status` text NOT NULL,
	`generated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`ticker`, `period_id`, `report_version`)
);
