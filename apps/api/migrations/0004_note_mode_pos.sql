-- Per-mode card positions (sticky / paper), stored as JSON so sticky and paper
-- layouts sync per-note alongside the canvas x/y. NULL until a card is dragged
-- in a mode; otherwise that mode falls back to a computed declumped layout.
-- FTS is untouched (its triggers only reference `text`/`rowid`).
ALTER TABLE `notes` ADD `mode_pos` text;
