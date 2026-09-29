CREATE TABLE "provider_dispatch_slots" (
	"id" integer PRIMARY KEY NOT NULL,
	"attempt_id" text,
	"transcription_id" text,
	"owner_id" text,
	"claimed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transcription_admission" (
	"id" integer PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'open' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcription_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"transcription_id" text NOT NULL,
	"region_ordinal" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"generation" integer NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transcription_capabilities" (
	"id" text PRIMARY KEY NOT NULL,
	"transcription_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcription_capabilities_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "transcription_regions" (
	"transcription_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"channel" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"text" text,
	"generation" integer NOT NULL,
	CONSTRAINT "transcription_regions_transcription_id_ordinal_pk" PRIMARY KEY("transcription_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "transcription_results" (
	"transcription_id" text PRIMARY KEY NOT NULL,
	"result_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcription_tenant_usage" (
	"project_id" text NOT NULL,
	"tenant_ref" text NOT NULL,
	"day" text NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "transcription_tenant_usage_project_id_tenant_ref_day_pk" PRIMARY KEY("project_id","tenant_ref","day")
);
--> statement-breakpoint
CREATE TABLE "transcription_workers" (
	"id" text PRIMARY KEY NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"tenant_ref" text NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"language" text,
	"channel_mode" text NOT NULL,
	"channel_labels" jsonb NOT NULL,
	"upload_deadline_at" timestamp with time zone NOT NULL,
	"upload_lease_token" text,
	"upload_lease_started_at" timestamp with time zone,
	"upload_lease_heartbeat_at" timestamp with time zone,
	"upload_lease_hard_expires_at" timestamp with time zone,
	"audio_file" text,
	"duration_seconds" real,
	"channels" integer,
	"generation" integer DEFAULT 0 NOT NULL,
	"claim_token" text,
	"claim_owner_id" text,
	"claim_heartbeat_at" timestamp with time zone,
	"claim_count" integer DEFAULT 0 NOT NULL,
	"tinfoil_calls" integer DEFAULT 0 NOT NULL,
	"tinfoil_audio_seconds" real DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"deletion_state" text DEFAULT 'none' NOT NULL,
	"files_deleted_at" timestamp with time zone,
	"deletion_attempts" integer DEFAULT 0 NOT NULL,
	"tombstoned" boolean DEFAULT false NOT NULL,
	"tombstoned_at" timestamp with time zone,
	"transcript_expires_at" timestamp with time zone,
	"transcript_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone,
	"processing_started_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transcription_attempts" ADD CONSTRAINT "transcription_attempts_transcription_id_transcriptions_id_fk" FOREIGN KEY ("transcription_id") REFERENCES "public"."transcriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_capabilities" ADD CONSTRAINT "transcription_capabilities_transcription_id_transcriptions_id_fk" FOREIGN KEY ("transcription_id") REFERENCES "public"."transcriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_regions" ADD CONSTRAINT "transcription_regions_transcription_id_transcriptions_id_fk" FOREIGN KEY ("transcription_id") REFERENCES "public"."transcriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_results" ADD CONSTRAINT "transcription_results_transcription_id_transcriptions_id_fk" FOREIGN KEY ("transcription_id") REFERENCES "public"."transcriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcriptions" ADD CONSTRAINT "transcriptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transcription_attempts_region_ordinal_idx" ON "transcription_attempts" USING btree ("transcription_id","region_ordinal","ordinal");--> statement-breakpoint
CREATE INDEX "transcription_capabilities_job_idx" ON "transcription_capabilities" USING btree ("transcription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcriptions_project_idempotency_idx" ON "transcriptions" USING btree ("project_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "transcriptions_one_active_per_tenant_idx" ON "transcriptions" USING btree ("project_id","tenant_ref") WHERE "transcriptions"."status" in ('awaiting_upload', 'queued', 'processing');--> statement-breakpoint
CREATE INDEX "transcriptions_status_idx" ON "transcriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "transcriptions_tenant_idx" ON "transcriptions" USING btree ("project_id","tenant_ref","created_at");--> statement-breakpoint
CREATE INDEX "transcriptions_deletion_idx" ON "transcriptions" USING btree ("deletion_state");--> statement-breakpoint
-- Singletons for the batch role (additive; the meeting role never reads them). Admission starts open; the
-- dispatch slot starts free.
INSERT INTO "transcription_admission" ("id", "mode") VALUES (1, 'open') ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "provider_dispatch_slots" ("id") VALUES (1) ON CONFLICT DO NOTHING;
