ALTER TABLE "meetings" ADD COLUMN "max_duration_seconds" integer DEFAULT 14400 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "scheduled_stop_at" timestamp with time zone;