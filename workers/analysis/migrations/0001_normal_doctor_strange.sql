CREATE TABLE `sec_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sec_filing_summaries` (
	`ticker` text NOT NULL,
	`accession_number` text NOT NULL,
	`generated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`ticker`, `accession_number`)
);
