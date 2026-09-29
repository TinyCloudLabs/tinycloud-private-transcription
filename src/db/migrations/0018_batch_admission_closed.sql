ALTER TABLE "transcription_admission" ALTER COLUMN "mode" SET DEFAULT 'closed';--> statement-breakpoint
-- A fresh install starts closed: the deploy workflow opens admission only after every gate passes. The migrator
-- applies all pending migrations in one transaction and now() is that transaction's start time, so updated_at =
-- now() matches only the singleton 0017 seeded `open` in this same run. A row from an earlier run (an existing
-- deployment, open or not) keeps its mode. The meeting role never reads this table.
UPDATE "transcription_admission" SET "mode" = 'closed' WHERE "id" = 1 AND "mode" = 'open' AND "updated_at" = now();
