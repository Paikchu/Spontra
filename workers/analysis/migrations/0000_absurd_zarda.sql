CREATE TABLE `holding_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`ticker` text NOT NULL,
	`company_name` text NOT NULL,
	`holding_reason` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holding_plans_owner_ticker_idx` ON `holding_plans` (`owner_email`,`ticker`);--> statement-breakpoint
CREATE TABLE `plan_levels` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`action` text NOT NULL,
	`price_cents` integer NOT NULL,
	`size_note` text DEFAULT '' NOT NULL,
	`trigger_note` text DEFAULT '' NOT NULL,
	`sort_order` integer NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `holding_plans`(`id`) ON UPDATE no action ON DELETE cascade
);
