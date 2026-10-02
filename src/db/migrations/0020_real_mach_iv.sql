CREATE TABLE "recording_recovery_runs" (
	"meeting_id" text PRIMARY KEY NOT NULL,
	"owner_token" text,
	"admitted_at" timestamp with time zone,
	"admissions" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recording_recovery_runs" ADD CONSTRAINT "recording_recovery_runs_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;