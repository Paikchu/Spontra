CREATE TABLE `sec_analysis_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`accession_number` text NOT NULL,
	`analysis_version` text NOT NULL,
	`status` text NOT NULL,
	`current_stage` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`error_code` text,
	`error_detail` text,
	`requested_by` text NOT NULL,
	`workflow_instance_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `sec_analysis_jobs_filing_version_idx` ON `sec_analysis_jobs` (`ticker`,`accession_number`,`analysis_version`);
--> statement-breakpoint
DELETE FROM `sec_published_reports` WHERE `verification_status` = 'failed';
--> statement-breakpoint
DELETE FROM `sec_filing_summaries`
WHERE `payload` LIKE '%No verified data available%'
   OR `payload` LIKE '%All module snapshots failed verification%';
--> statement-breakpoint
DELETE FROM `sec_published_reports`
WHERE `period_id` IN (
	SELECT `sec_filing_periods`.`period_id`
	FROM `sec_filing_periods`
	JOIN `sec_filings` ON `sec_filings`.`filing_id` = `sec_filing_periods`.`filing_id`
	WHERE `sec_filings`.`form` IN ('8-K', '8-K/A', '6-K', '6-K/A')
	  AND NOT EXISTS (
		SELECT 1
		FROM `sec_filing_periods` AS `primary_period`
		JOIN `sec_filings` AS `primary_filing` ON `primary_filing`.`filing_id` = `primary_period`.`filing_id`
		WHERE `primary_period`.`period_id` = `sec_filing_periods`.`period_id`
		  AND (`primary_filing`.`form` LIKE '10-Q%' OR `primary_filing`.`form` LIKE '10-K%' OR `primary_filing`.`form` LIKE '20-F%')
	  )
);
--> statement-breakpoint
DELETE FROM `sec_memory_items`
WHERE EXISTS (
	SELECT 1 FROM `sec_evidence`
	JOIN `sec_filings` ON `sec_filings`.`filing_id` = `sec_evidence`.`filing_id`
	WHERE `sec_filings`.`form` IN ('8-K', '8-K/A', '6-K', '6-K/A')
	  AND `sec_memory_items`.`evidence_ids` LIKE '%' || `sec_evidence`.`evidence_id` || '%'
);
--> statement-breakpoint
DELETE FROM `sec_module_snapshots`
WHERE `filing_id` IN (
	SELECT `filing_id` FROM `sec_filings` WHERE `form` IN ('8-K', '8-K/A', '6-K', '6-K/A')
);
--> statement-breakpoint
DELETE FROM `sec_facts`
WHERE `filing_id` IN (
	SELECT `filing_id` FROM `sec_filings` WHERE `form` IN ('8-K', '8-K/A', '6-K', '6-K/A')
);
--> statement-breakpoint
DELETE FROM `sec_filing_summaries`
WHERE `accession_number` IN (
	SELECT `accession_number` FROM `sec_filings` WHERE `form` IN ('8-K', '8-K/A', '6-K', '6-K/A')
);
--> statement-breakpoint
DELETE FROM `sec_memory_events`
WHERE EXISTS (
	SELECT 1 FROM `sec_evidence`
	JOIN `sec_filings` ON `sec_filings`.`filing_id` = `sec_evidence`.`filing_id`
	WHERE `sec_filings`.`form` IN ('8-K', '8-K/A', '6-K', '6-K/A')
	  AND `sec_memory_events`.`evidence_ids` LIKE '%' || `sec_evidence`.`evidence_id` || '%'
);
--> statement-breakpoint
DELETE FROM `sec_evidence`
WHERE `filing_id` IN (
	SELECT `filing_id` FROM `sec_filings` WHERE `form` IN ('8-K', '8-K/A', '6-K', '6-K/A')
);
--> statement-breakpoint
DELETE FROM `sec_filing_blocks`
WHERE `filing_id` IN (
	SELECT `filing_id` FROM `sec_filings` WHERE `form` IN ('8-K', '8-K/A', '6-K', '6-K/A')
);
--> statement-breakpoint
DELETE FROM `sec_filing_periods`
WHERE `filing_id` IN (
	SELECT `filing_id` FROM `sec_filings` WHERE `form` IN ('8-K', '8-K/A', '6-K', '6-K/A')
);
--> statement-breakpoint
DELETE FROM `sec_filings` WHERE `form` IN ('8-K', '8-K/A', '6-K', '6-K/A');
--> statement-breakpoint
DELETE FROM `sec_periods`
WHERE NOT EXISTS (
	SELECT 1 FROM `sec_filing_periods` WHERE `sec_filing_periods`.`period_id` = `sec_periods`.`period_id`
);
--> statement-breakpoint
DELETE FROM `sec_comparisons`
WHERE `current_period_id` NOT IN (SELECT `period_id` FROM `sec_periods`)
   OR `prior_period_id` NOT IN (SELECT `period_id` FROM `sec_periods`);
