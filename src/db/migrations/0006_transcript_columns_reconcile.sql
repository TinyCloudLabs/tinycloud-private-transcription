-- Same development-database reconciliation as 0005; fresh installs already receive these in
-- their historical migrations.
ALTER TABLE "transcripts" ADD COLUMN IF NOT EXISTS "provider" text DEFAULT 'vexa' NOT NULL;
ALTER TABLE "transcripts" ADD COLUMN IF NOT EXISTS "fallback_from" text;
ALTER TABLE "transcripts" ADD COLUMN IF NOT EXISTS "fallback_reason" text;
