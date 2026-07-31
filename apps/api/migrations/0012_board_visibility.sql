-- 'public' exposes the board read-only at GET /api/public/boards/:id; the
-- board id doubles as the share token. Flip back to 'private' to revoke.
ALTER TABLE `boards` ADD `visibility` text DEFAULT 'private' NOT NULL;
