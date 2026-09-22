ALTER TABLE "attributed_batches" ADD COLUMN "dispatch_owner_id" text;--> statement-breakpoint
ALTER TABLE "tinfoil_dispatch_slots" ADD COLUMN "owner_id" text;
