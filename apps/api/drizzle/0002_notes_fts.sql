-- Phase 2: FTS5 search index over notes.text.
--
-- Hand-written because drizzle-kit can't model FTS5 virtual tables. We
-- use the "external content" pattern (content='notes' + content_rowid)
-- so the index lives alongside the canonical notes rows without
-- duplicating storage; triggers keep it synced on insert/update/delete.
-- Search queries filter to the caller's user_id + deleted_at IS NULL
-- at query time — the index itself doesn't know about ownership or
-- soft-delete.

CREATE VIRTUAL TABLE notes_fts USING fts5(
  text,
  content='notes',
  content_rowid='rowid'
);
--> statement-breakpoint

-- Backfill any rows that exist before this migration runs.
INSERT INTO notes_fts(rowid, text) SELECT rowid, text FROM notes;
--> statement-breakpoint

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, text) VALUES (new.rowid, new.text);
END;
--> statement-breakpoint

CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
--> statement-breakpoint

CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO notes_fts(rowid, text) VALUES (new.rowid, new.text);
END;
