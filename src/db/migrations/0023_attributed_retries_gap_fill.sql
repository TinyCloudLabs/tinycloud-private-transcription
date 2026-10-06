ALTER TABLE "attributed_attempts" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "attributed_batches" ADD COLUMN "kind" text DEFAULT 'batch' NOT NULL;--> statement-breakpoint
ALTER TABLE "attributed_batches" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attributed_transcription_runs" ADD COLUMN "coverage_json" jsonb;