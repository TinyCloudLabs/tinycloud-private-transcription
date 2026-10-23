ALTER TABLE "meetings" ADD COLUMN "join_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "join_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "dispatch_fallback_at" timestamp with time zone;