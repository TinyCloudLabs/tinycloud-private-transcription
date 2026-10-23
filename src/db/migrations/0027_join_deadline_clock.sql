CREATE TABLE "meeting_join_clocks" (
	"meeting_id" text PRIMARY KEY NOT NULL,
	"join_observed_at" timestamp with time zone,
	"join_deadline_at" timestamp with time zone,
	"dispatch_fallback_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "meeting_join_clocks" ADD CONSTRAINT "meeting_join_clocks_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;