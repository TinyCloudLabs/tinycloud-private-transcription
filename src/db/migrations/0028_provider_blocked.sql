CREATE TABLE "transcription_provider_blocks" (
	"transcription_id" text PRIMARY KEY NOT NULL,
	"blocked_since" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_status" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transcription_provider_blocks" ADD CONSTRAINT "transcription_provider_blocks_transcription_id_transcriptions_id_fk" FOREIGN KEY ("transcription_id") REFERENCES "public"."transcriptions"("id") ON DELETE cascade ON UPDATE no action;