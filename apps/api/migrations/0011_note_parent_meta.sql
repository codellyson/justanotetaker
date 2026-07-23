-- Substrate for the new canvas item kinds (frame / image / task).
-- parent_id: full-containment frame membership (null = board root). No FK —
-- a frame delete releases members app-side, and dangling ids are harmless.
-- meta: kind-specific JSON payload (image: {key,w,h,size,alt?}; task:
-- {status,prompt,startedAt?,finishedAt?,error?}). The FTS triggers reference
-- only rowid/text, so both columns are invisible to search.
ALTER TABLE `notes` ADD `parent_id` text;
--> statement-breakpoint
ALTER TABLE `notes` ADD `meta` text;
--> statement-breakpoint
-- Server-enforced media quota lives on settings (one row per user); the
-- tweaks JSON blob is client-owned and can't be trusted for enforcement.
ALTER TABLE `settings` ADD `media_bytes` integer NOT NULL DEFAULT 0;
