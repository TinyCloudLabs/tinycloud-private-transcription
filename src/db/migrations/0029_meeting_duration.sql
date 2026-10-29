ALTER TABLE "meetings" ADD COLUMN "max_duration_seconds" integer DEFAULT 3600 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "scheduled_stop_at" timestamp with time zone;