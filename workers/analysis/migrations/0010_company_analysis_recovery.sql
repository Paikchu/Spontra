ALTER TABLE company_analysis_runs ADD COLUMN workflow_instance_id TEXT;
--> statement-breakpoint
ALTER TABLE company_analysis_runs ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0;
