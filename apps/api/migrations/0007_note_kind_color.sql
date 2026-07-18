-- Per-note presentation replaces the old board-level view modes: `kind`
-- (card | sticky | page) is how a single note renders, and `color` holds a
-- sticky's palette key (NULL otherwise). Existing notes default to `card`
-- (the "reset to cards" migration away from sticky/paper boards). The old
-- `mode_pos` column and boards' `view_mode` are left in place but unused.
-- FTS is untouched — its triggers only reference `text`/`rowid`.
ALTER TABLE `notes` ADD `kind` text DEFAULT 'card' NOT NULL;
--> statement-breakpoint
ALTER TABLE `notes` ADD `color` text;
