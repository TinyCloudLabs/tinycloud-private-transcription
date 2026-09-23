DROP TABLE IF EXISTS "attributed_jobs";
--> statement-breakpoint
CREATE TABLE "attributed_worker_readiness" (
  "id" text PRIMARY KEY NOT NULL,
  "ready" boolean NOT NULL,
  "stage" text NOT NULL,
  "observed_at" timestamp with time zone NOT NULL
);
