ALTER TABLE "api_keys" ADD COLUMN "bootstrap_managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Before route-level scope enforcement, stored scopes were never checked, so every existing key could use
-- every authenticated route that existed: only /v1/meetings. `create-key` has always written {meetings:*},
-- so this is a no-op for those keys; it only covers rows written by raw SQL (e.g. the column default '{}').
-- Each existing key keeps exactly its current access now that /v1/meetings requires meetings:*; no key
-- gains any other scope, and keys created after this migration are unaffected.
-- array_position is NULL-safe: it is NULL (not found) for '{}', '{NULL}', arrays without the scope, and a
-- NULL column, whereas `NOT ('meetings:*' = ANY(scopes))` is NULL, and so skipped, when the array holds a NULL.
-- This backfill is not reversible: after it runs, a backfilled meetings:* is indistinguishable from a minted one.
UPDATE "api_keys" SET "scopes" = array_append("scopes", 'meetings:*') WHERE array_position("scopes", 'meetings:*') IS NULL;
