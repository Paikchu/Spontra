CREATE TABLE `company_analysis_runs` (
	`analysis_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`trigger_ref` text NOT NULL,
	`period_id` text NOT NULL,
	`period_end` text,
	`report_label` text,
	`input_hash` text,
	`memory_version` integer NOT NULL,
	`fundamentals_data_version` text,
	`status` text NOT NULL,
	`coverage_status` text,
	`overview_json` text,
	`model_version` text NOT NULL,
	`prompt_version` text NOT NULL,
	`error_code` text,
	`error_detail` text,
	`generated_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT `company_analysis_runs_status_check` CHECK(`status` IN ('waiting_fundamentals', 'calculating', 'analyzing', 'validating', 'ready', 'insufficient_data', 'failed')),
	CONSTRAINT `company_analysis_runs_coverage_check` CHECK(`coverage_status` IS NULL OR `coverage_status` IN ('complete', 'partial'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_analysis_runs_trigger_idx` ON `company_analysis_runs` (`trigger_ref`);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_analysis_runs_input_idx` ON `company_analysis_runs` (`ticker`,`input_hash`) WHERE `input_hash` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `company_analysis_runs_latest_idx` ON `company_analysis_runs` (`ticker`,`status`,`generated_at`);
--> statement-breakpoint
CREATE INDEX `company_analysis_runs_recovery_idx` ON `company_analysis_runs` (`status`,`updated_at`);
