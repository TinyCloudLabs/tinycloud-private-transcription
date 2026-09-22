ALTER TABLE "attributed_batches" ADD COLUMN "dispatch_token" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "dispatch_blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "claim_token" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "tinfoil_dispatch_slots" (
  "id" integer PRIMARY KEY NOT NULL,
  "claim_token" text,
  "claimed_at" timestamp with time zone
);--> statement-breakpoint
INSERT INTO "tinfoil_dispatch_slots" ("id") VALUES (0), (1);
