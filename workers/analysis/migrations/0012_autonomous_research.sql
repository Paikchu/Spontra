CREATE TABLE `research_budget` (
	`day` text PRIMARY KEY NOT NULL,
	`investigations` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `research_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`ticker` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`workflow_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_owner` text,
	`lease_until` text,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_cases_event_idx` ON `research_cases` (`event_id`);--> statement-breakpoint
CREATE INDEX `research_cases_dispatch_idx` ON `research_cases` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `research_events` (
	`id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`observed_at` text NOT NULL,
	`source_at` text
);
--> statement-breakpoint
CREATE TABLE `research_followups` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`ticker` text NOT NULL,
	`question` text NOT NULL,
	`query` text NOT NULL,
	`due_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_followups_due_idx` ON `research_followups` (`status`,`due_at`);--> statement-breakpoint
CREATE TABLE `research_reports` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`case_id` text NOT NULL,
	`payload` text NOT NULL,
	`generated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_reports_id_idx` ON `research_reports` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `research_reports_case_idx` ON `research_reports` (`case_id`);--> statement-breakpoint
CREATE TABLE `research_state` (
	`key` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text NOT NULL
);
