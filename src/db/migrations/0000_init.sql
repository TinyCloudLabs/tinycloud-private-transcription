CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"meeting_url" text NOT NULL,
	"platform" text NOT NULL,
	"status" text NOT NULL,
	"bot_name" text,
	"language" text,
	"webhook_url" text,
	"vexa_platform" text,
	"vexa_native_meeting_id" text,
	"vexa_bot_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"idempotency_key" text,
	"request_hash" text,
	"transcription_attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"meeting_id" text PRIMARY KEY NOT NULL,
	"language" text NOT NULL,
	"duration_seconds" real NOT NULL,
	"segments_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"meeting_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"endpoint" text NOT NULL,
	"payload" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"response_code" integer,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_project_idempotency_idx" ON "meetings" USING btree ("project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "meetings_project_status_idx" ON "meetings" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_meeting_idx" ON "webhook_deliveries" USING btree ("meeting_id");