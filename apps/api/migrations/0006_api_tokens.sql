-- Personal API tokens for programmatic access (agents / scripts piping notes
-- in via the MCP server). We store only a SHA-256 hash of the token; the raw
-- value is shown once at creation. `prefix` is the first chars, kept for
-- display so a user can tell their keys apart without revealing the secret.
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash` ON `api_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `api_tokens_user` ON `api_tokens` (`user_id`);
