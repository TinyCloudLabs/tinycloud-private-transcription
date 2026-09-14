ALTER TABLE "transcripts" DROP COLUMN IF EXISTS "fallback_from";--> statement-breakpoint
ALTER TABLE "transcripts" DROP COLUMN IF EXISTS "fallback_reason";--> statement-breakpoint
ALTER TABLE "meetings" DROP COLUMN IF EXISTS "transcription_attempts";
