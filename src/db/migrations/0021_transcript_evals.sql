CREATE TABLE "reference_transcripts" (
	"meeting_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_evals" (
	"id" text PRIMARY KEY NOT NULL,
	"meeting_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"calls" integer,
	"batches_json" jsonb,
	"transcript_json" jsonb,
	"metrics_json" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "reference_transcripts" ADD CONSTRAINT "reference_transcripts_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_evals" ADD CONSTRAINT "transcript_evals_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_evals_meeting_idx" ON "transcript_evals" USING btree ("meeting_id");