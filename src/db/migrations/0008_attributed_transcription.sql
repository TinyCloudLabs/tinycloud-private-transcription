CREATE TABLE "attributed_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attributed_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"meeting_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"batch_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claim_token" text,
	"claimed_at" timestamp with time zone,
	"result_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attributed_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"meeting_id" text NOT NULL,
	"batch_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attributed_ranges" (
	"meeting_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"range_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attributed_transcription_runs" (
	"meeting_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "vexa_meeting_id" integer;--> statement-breakpoint
ALTER TABLE "attributed_attempts" ADD CONSTRAINT "attributed_attempts_batch_id_attributed_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."attributed_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributed_batches" ADD CONSTRAINT "attributed_batches_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributed_jobs" ADD CONSTRAINT "attributed_jobs_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributed_jobs" ADD CONSTRAINT "attributed_jobs_batch_id_attributed_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."attributed_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributed_ranges" ADD CONSTRAINT "attributed_ranges_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributed_transcription_runs" ADD CONSTRAINT "attributed_transcription_runs_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attributed_attempts_batch_ordinal_idx" ON "attributed_attempts" USING btree ("batch_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "attributed_batches_meeting_ordinal_idx" ON "attributed_batches" USING btree ("meeting_id","ordinal");--> statement-breakpoint
CREATE INDEX "attributed_batches_status_idx" ON "attributed_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "attributed_jobs_status_idx" ON "attributed_jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "attributed_ranges_meeting_sequence_idx" ON "attributed_ranges" USING btree ("meeting_id","sequence");
