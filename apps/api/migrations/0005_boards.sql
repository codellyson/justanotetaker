-- Multi-canvas: each board is a separate infinite canvas with its own notes
-- and its own view mode (canvas/sticky/paper). Notes gain a board_id.
CREATE TABLE `boards` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`view_mode` text DEFAULT 'default' NOT NULL,
	`sort` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `boards_user` ON `boards` (`user_id`);
--> statement-breakpoint
-- Backfill: give every user who already has notes a default "Canvas" board.
INSERT INTO `boards` (`id`, `user_id`, `name`, `view_mode`, `sort`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), `user_id`, 'Canvas', 'default', 0, unixepoch() * 1000, unixepoch() * 1000
FROM (SELECT DISTINCT `user_id` FROM `notes`);
--> statement-breakpoint
ALTER TABLE `notes` ADD `board_id` text;
--> statement-breakpoint
-- Point existing notes at their user's default board.
UPDATE `notes` SET `board_id` = (SELECT `b`.`id` FROM `boards` `b` WHERE `b`.`user_id` = `notes`.`user_id` LIMIT 1);
--> statement-breakpoint
CREATE INDEX `notes_board` ON `notes` (`board_id`);
