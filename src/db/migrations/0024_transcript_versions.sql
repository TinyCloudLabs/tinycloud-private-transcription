CREATE TABLE "transcript_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"meeting_id" text NOT NULL,
	"version" integer NOT NULL,
	"language" text,
	"duration_seconds" real,
	"provider" text,
	"segments_json" jsonb NOT NULL,
	"transcript_created_at" timestamp with time zone NOT NULL,
	"meeting_completed_at" timestamp with time zone,
	"coverage_json" jsonb,
	"reason" text NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transcript_versions" ADD CONSTRAINT "transcript_versions_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_versions_meeting_version_idx" ON "transcript_versions" USING btree ("meeting_id","version");