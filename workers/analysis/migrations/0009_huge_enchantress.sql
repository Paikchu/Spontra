PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_fundamental_observations` (
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
	CONSTRAINT "fundamental_observations_unit_family_check" CHECK("__new_fundamental_observations"."unit_family" IN ('currency', 'percent', 'per_share', 'shares', 'multiple')),
	CONSTRAINT "fundamental_observations_basis_check" CHECK("__new_fundamental_observations"."basis" IN ('reported', 'derived')),
	CONSTRAINT "fundamental_observations_revision_check" CHECK("__new_fundamental_observations"."revision" >= 1),
	CONSTRAINT "fundamental_observations_source_field_check" CHECK(("__new_fundamental_observations"."basis" = 'reported' AND "__new_fundamental_observations"."source_field" IS NOT NULL) OR ("__new_fundamental_observations"."basis" = 'derived' AND "__new_fundamental_observations"."source_field" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_fundamental_observations`("observation_id", "period_id", "ticker", "period_end", "metric_key", "source_field", "value_decimal", "unit_family", "unit", "currency", "basis", "derivation_formula", "derivation_version", "source_run_id", "revision", "created_at", "updated_at") SELECT "observation_id", "period_id", "ticker", "period_end", "metric_key", "source_field", "value_decimal", "unit_family", "unit", "currency", "basis", "derivation_formula", "derivation_version", "source_run_id", "revision", "created_at", "updated_at" FROM `fundamental_observations`;--> statement-breakpoint
DROP TABLE `fundamental_observations`;--> statement-breakpoint
ALTER TABLE `__new_fundamental_observations` RENAME TO `fundamental_observations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `fundamental_observations_identity_idx` ON `fundamental_observations` (`period_id`,`metric_key`);--> statement-breakpoint
CREATE INDEX `fundamental_observations_chart_read_idx` ON `fundamental_observations` (`ticker`,`metric_key`,`period_end`);--> statement-breakpoint
CREATE INDEX `fundamental_observations_source_run_idx` ON `fundamental_observations` (`source_run_id`);