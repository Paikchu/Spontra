CREATE TABLE `sec_company_memory_threads` (
	`ticker` text PRIMARY KEY NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_until` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sec_memory_extractions` (
	`extraction_id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`ticker` text NOT NULL,
	`period_id` text NOT NULL,
	`payload` text NOT NULL,
	`input_hash` text NOT NULL,
	`schema_version` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sec_memory_extractions_job_idx` ON `sec_memory_extractions` (`job_id`);--> statement-breakpoint
CREATE TABLE `sec_memory_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`filing_id` text NOT NULL,
	`period_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source_r2_key` text NOT NULL,
	`owner_token` text,
	`lease_until` text,
	`attempt` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `sec_memory_jobs_status_created_idx` ON `sec_memory_jobs` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `sec_analysis_runs` ADD `output_r2_key` text;--> statement-breakpoint
ALTER TABLE `sec_analysis_runs` ADD `round` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sec_analysis_runs` ADD `stop_reason` text;--> statement-breakpoint
ALTER TABLE `sec_facts` ADD `observation_start` text;--> statement-breakpoint
ALTER TABLE `sec_facts` ADD `observation_end` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sec_facts` ADD `source_filed_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sec_facts` ADD `source_accession` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sec_facts` ADD `source_version` text DEFAULT 'legacy_unvalidated' NOT NULL;--> statement-breakpoint
UPDATE `sec_facts` SET `quality_status` = 'legacy_unvalidated' WHERE `source_version` = 'legacy_unvalidated';--> statement-breakpoint
ALTER TABLE `sec_memory_events` ADD `job_id` text;--> statement-breakpoint
ALTER TABLE `sec_memory_items` ADD `kind` text DEFAULT 'fact' NOT NULL;--> statement-breakpoint
ALTER TABLE `sec_memory_items` ADD `horizon` text;--> statement-breakpoint
ALTER TABLE `sec_memory_items` ADD `next_test` text;--> statement-breakpoint
ALTER TABLE `sec_memory_items` ADD `falsifier` text;--> statement-breakpoint
ALTER TABLE `sec_memory_items` ADD `due_period` text;--> statement-breakpoint
ALTER TABLE `sec_memory_items` ADD `source_job_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `sec_memory_items` ADD `normalized_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sec_memory_items` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `sec_memory_items` ADD `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL;--> statement-breakpoint
UPDATE `sec_memory_items` SET `status` = 'rejected' WHERE `source_job_ids` = '[]';--> statement-breakpoint
CREATE INDEX `sec_memory_items_ticker_status_due_idx` ON `sec_memory_items` (`ticker`,`status`,`due_period`);
