ALTER TABLE "meetings" ADD COLUMN "deletion_token" text;--> statement-breakpoint
ALTER TABLE "attributed_batches" ADD COLUMN "dispatched_at" timestamp with time zone;
