CREATE TABLE `fundamental_chart_specs` (
	`spec_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`spec_json` text NOT NULL,
	`schema_version` text NOT NULL,
	`input_data_hash` text NOT NULL,
	`model_version` text NOT NULL,
	`prompt_version` text NOT NULL,
	`status` text NOT NULL,
	`generated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`superseded_at` text,
	CONSTRAINT "fundamental_chart_specs_status_check" CHECK("fundamental_chart_specs"."status" IN ('active', 'superseded', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fundamental_chart_specs_active_ticker_idx` ON `fundamental_chart_specs` (`ticker`) WHERE "fundamental_chart_specs"."status" = 'active';--> statement-breakpoint
CREATE INDEX `fundamental_chart_specs_ticker_status_generated_idx` ON `fundamental_chart_specs` (`ticker`,`status`,`generated_at`);--> statement-breakpoint
CREATE TABLE `fundamental_company_profiles` (
	`ticker` text PRIMARY KEY NOT NULL,
	`classification` text DEFAULT 'unclassified' NOT NULL,
	`features_json` text DEFAULT '{}' NOT NULL,
	`profile_version` text NOT NULL,
	`input_data_hash` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fundamental_fetch_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`source` text DEFAULT 'yahoo_finance' NOT NULL,
	`status` text NOT NULL,
	`request_hash` text NOT NULL,
	`payload_hash` text,
	`parser_version` text NOT NULL,
	`catalog_version` text NOT NULL,
	`started_at` text NOT NULL,
	`fetched_at` text,
	`completed_at` text,
	`error_code` text,
	`error_detail` text,
	CONSTRAINT "fundamental_fetch_runs_source_check" CHECK("fundamental_fetch_runs"."source" = 'yahoo_finance'),
	CONSTRAINT "fundamental_fetch_runs_status_check" CHECK("fundamental_fetch_runs"."status" IN ('running', 'success', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `fundamental_fetch_runs_ticker_status_fetched_idx` ON `fundamental_fetch_runs` (`ticker`,`status`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `fundamental_observation_revisions` (
	`revision_id` text PRIMARY KEY NOT NULL,
	`observation_id` text NOT NULL,
	`source_run_id` text NOT NULL,
	`old_value_decimal` text NOT NULL,
	`new_value_decimal` text NOT NULL,
	`previous_revision` integer NOT NULL,
	`new_revision` integer NOT NULL,
	`changed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`observation_id`) REFERENCES `fundamental_observations`(`observation_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_run_id`) REFERENCES `fundamental_fetch_runs`(`run_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "fundamental_revisions_sequence_check" CHECK("fundamental_observation_revisions"."new_revision" = "fundamental_observation_revisions"."previous_revision" + 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fundamental_revisions_observation_version_idx` ON `fundamental_observation_revisions` (`observation_id`,`new_revision`);--> statement-breakpoint
CREATE INDEX `fundamental_revisions_observation_changed_idx` ON `fundamental_observation_revisions` (`observation_id`,`changed_at`);--> statement-breakpoint
CREATE TABLE `fundamental_observations` (
	`observation_id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`ticker` text NOT NULL,
	`period_end` text NOT NULL,
	`metric_key` text NOT NULL,
	`source_field` text,
	`value_decimal` text NOT NULL,
	`unit_family` text NOT NULL,
	`unit` text NOT NULL,
	`currency` text DEFAULT '' NOT NULL,
	`basis` text NOT NULL,
	`derivation_formula` text,
	`derivation_version` text,
	`source_run_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `fundamental_periods`(`period_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_run_id`) REFERENCES `fundamental_fetch_runs`(`run_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "fundamental_observations_unit_family_check" CHECK("fundamental_observations"."unit_family" IN ('currency', 'percent', 'per_share', 'shares')),
	CONSTRAINT "fundamental_observations_basis_check" CHECK("fundamental_observations"."basis" IN ('reported', 'derived')),
	CONSTRAINT "fundamental_observations_revision_check" CHECK("fundamental_observations"."revision" >= 1),
	CONSTRAINT "fundamental_observations_source_field_check" CHECK(("fundamental_observations"."basis" = 'reported' AND "fundamental_observations"."source_field" IS NOT NULL) OR ("fundamental_observations"."basis" = 'derived' AND "fundamental_observations"."source_field" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fundamental_observations_identity_idx` ON `fundamental_observations` (`period_id`,`metric_key`);--> statement-breakpoint
CREATE INDEX `fundamental_observations_chart_read_idx` ON `fundamental_observations` (`ticker`,`metric_key`,`period_end`);--> statement-breakpoint
CREATE INDEX `fundamental_observations_source_run_idx` ON `fundamental_observations` (`source_run_id`);--> statement-breakpoint
CREATE TABLE `fundamental_periods` (
	`period_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`source` text DEFAULT 'yahoo_finance' NOT NULL,
	`period_type` text NOT NULL,
	`period_end` text NOT NULL,
	`fiscal_year` integer,
	`fiscal_quarter` text,
	`currency` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "fundamental_periods_source_check" CHECK("fundamental_periods"."source" = 'yahoo_finance'),
	CONSTRAINT "fundamental_periods_type_check" CHECK("fundamental_periods"."period_type" IN ('3M', 'FY')),
	CONSTRAINT "fundamental_periods_quarter_check" CHECK("fundamental_periods"."fiscal_quarter" IS NULL OR "fundamental_periods"."fiscal_quarter" IN ('Q1', 'Q2', 'Q3', 'Q4'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fundamental_periods_identity_idx` ON `fundamental_periods` (`ticker`,`period_type`,`period_end`);--> statement-breakpoint
CREATE INDEX `fundamental_periods_ticker_end_idx` ON `fundamental_periods` (`ticker`,`period_end`);
