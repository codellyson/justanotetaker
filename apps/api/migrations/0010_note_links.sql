-- User-defined relationships between notes, drawn as threads on the canvas.
-- Undirected: the pair is stored normalized (a_id < b_id) so the unique index
-- catches duplicates created from either end.
CREATE TABLE `note_links` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `board_id` text,
  `a_id` text NOT NULL,
  `b_id` text NOT NULL,
  `created_at` integer NOT NULL
);
CREATE INDEX `idx_note_links_user_board` ON `note_links` (`user_id`, `board_id`);
CREATE UNIQUE INDEX `idx_note_links_pair` ON `note_links` (`user_id`, `a_id`, `b_id`);
