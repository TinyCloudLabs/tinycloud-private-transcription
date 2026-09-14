-- Older development databases predate the retry counter that was folded into 0000 before release.
-- Keep upgrades from those databases valid without changing fresh-install semantics.
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "transcription_attempts" integer DEFAULT 0 NOT NULL;
