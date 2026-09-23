ALTER TABLE "meetings" ADD COLUMN "deletion_owner_id" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "deletion_lease_at" timestamp with time zone;
