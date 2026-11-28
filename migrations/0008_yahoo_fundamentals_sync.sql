PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_fundamental_fetch_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`source` text DEFAULT 'yahoo_finance' NOT NULL,
	`status` text NOT NULL,
	`quality_status` text DEFAULT 'pending' NOT NULL,
	`request_hash` text NOT NULL,
	`payload_hash` text,
	`parser_version` text NOT NULL,
	`catalog_version` text NOT NULL,
	`issue_count` integer DEFAULT 0 NOT NULL,
	`observation_count` integer DEFAULT 0 NOT NULL,
	`period_count` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_until` text,
	`started_at` text NOT NULL,
	`fetched_at` text,
	`completed_at` text,
	`error_code` text,
	`error_detail` text,
	CONSTRAINT "fundamental_fetch_runs_source_check" CHECK("__new_fundamental_fetch_runs"."source" = 'yahoo_finance'),
	CONSTRAINT "fundamental_fetch_runs_status_check" CHECK("__new_fundamental_fetch_runs"."status" IN ('running', 'success', 'failed')),
	CONSTRAINT "fundamental_fetch_runs_quality_check" CHECK("__new_fundamental_fetch_runs"."quality_status" IN ('pending', 'complete', 'partial', 'rejected')),
	CONSTRAINT "fundamental_fetch_runs_counts_check" CHECK("__new_fundamental_fetch_runs"."issue_count" >= 0 AND "__new_fundamental_fetch_runs"."observation_count" >= 0 AND "__new_fundamental_fetch_runs"."period_count" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_fundamental_fetch_runs`("run_id", "ticker", "source", "status", "quality_status", "request_hash", "payload_hash", "parser_version", "catalog_version", "issue_count", "observation_count", "period_count", "lease_owner", "lease_until", "started_at", "fetched_at", "completed_at", "error_code", "error_detail") SELECT "run_id", "ticker", "source", "status", CASE WHEN "status" = 'success' THEN 'partial' WHEN "status" = 'failed' THEN 'rejected' ELSE 'pending' END, "request_hash", "payload_hash", "parser_version", "catalog_version", 0, 0, 0, NULL, NULL, "started_at", "fetched_at", "completed_at", "error_code", "error_detail" FROM `fundamental_fetch_runs`;--> statement-breakpoint
DROP TABLE `fundamental_fetch_runs`;--> statement-breakpoint
ALTER TABLE `__new_fundamental_fetch_runs` RENAME TO `fundamental_fetch_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `fundamental_fetch_runs_running_ticker_idx` ON `fundamental_fetch_runs` (`ticker`) WHERE "fundamental_fetch_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX `fundamental_fetch_runs_ticker_status_fetched_idx` ON `fundamental_fetch_runs` (`ticker`,`status`,`fetched_at`);
