-- Drop the dead columns left behind by the move to per-note kind/color:
-- notes.mode_pos (old per-view-mode positions) and boards.view_mode (old
-- board-level view mode). Nothing reads them anymore. The FTS triggers only
-- reference notes.text/rowid, so dropping mode_pos doesn't touch the index.
ALTER TABLE `notes` DROP COLUMN `mode_pos`;
--> statement-breakpoint
ALTER TABLE `boards` DROP COLUMN `view_mode`;
