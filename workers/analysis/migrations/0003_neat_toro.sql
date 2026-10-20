CREATE TABLE `sec_memory_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`ticker` text NOT NULL,
	`period_id` text NOT NULL,
	`event_type` text NOT NULL,
	`current_statement` text,
	`prior_statement` text,
	`evidence_ids` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
