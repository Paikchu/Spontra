CREATE TABLE `web_search_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`object_key` text,
	`lease_owner` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);
