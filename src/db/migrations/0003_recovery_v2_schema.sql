ALTER TABLE "meetings" ADD COLUMN "budget_provenance" text;--> statement-breakpoint
UPDATE "meetings" SET "budget_provenance" = 'legacy_unknown';--> statement-breakpoint
ALTER TABLE "meetings" ALTER COLUMN "budget_provenance" SET DEFAULT 'tracked';--> statement-breakpoint
ALTER TABLE "meetings" ALTER COLUMN "budget_provenance" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "manual_recovery_cycles_consumed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "automatic_recovery_cycles_consumed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "operator_recovery_cycles_consumed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "consecutive_recoverable_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "next_recovery_eligible_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "active_recovery_operation_id" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "last_recovery_outcome" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "recovery_phase" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "transcript_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "recovery_capability_version" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "deletion_fence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "deletion_saga_state" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "deletion_provider_platform" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "deletion_provider_native_meeting_id" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_budget_provenance_check" CHECK ("budget_provenance" in ('tracked', 'legacy_unknown'));--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_recovery_counters_check" CHECK (
  "manual_recovery_cycles_consumed" >= 0 and
  "automatic_recovery_cycles_consumed" >= 0 and
  "operator_recovery_cycles_consumed" >= 0 and
  "consecutive_recoverable_failures" >= 0 and
  "transcript_revision" >= 0
);--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_last_recovery_outcome_check" CHECK (
  "last_recovery_outcome" is null or "last_recovery_outcome" in
    ('completed', 'failed', 'disabled', 'budget_exhausted', 'cancelled')
);--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_recovery_phase_check" CHECK (
  "recovery_phase" is null or "recovery_phase" in
    ('queued', 'preflighting', 'chunking', 'transcribing', 'delayed', 'publishing', 'completed', 'failed', 'disabled')
);--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_create_idempotency_key_check" CHECK (
  "idempotency_key" is null or "idempotency_key" ~ '^[!-~]{1,128}$'
);--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_deletion_fence_check" CHECK (
  "deletion_fence" between 0 and 9007199254740991 and
  (
    ("deleted_at" is null and "deletion_saga_state" is null and
     "deletion_provider_platform" is null and "deletion_provider_native_meeting_id" is null)
    or
    ("deleted_at" is not null and "deletion_saga_state" in ('pending', 'completed') and
     (("deletion_provider_platform" is null and "deletion_provider_native_meeting_id" is null)
      or ("deletion_saga_state" = 'pending' and "deletion_provider_platform" is not null and
          "deletion_provider_native_meeting_id" is not null)))
  )
);--> statement-breakpoint
CREATE TABLE "recovery_operations" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL,
  "meeting_id" text NOT NULL,
  "idempotency_key_hash" text NOT NULL,
  "kind" text NOT NULL,
  "state" text NOT NULL,
  "phase" text NOT NULL,
  "eligibility_code" text,
  "ordinal" integer NOT NULL,
  "planned_audio_ms" bigint DEFAULT 0 NOT NULL,
  "submitted_audio_ms" bigint DEFAULT 0 NOT NULL,
  "source_sample_rate_hz" integer,
  "source_sample_count" bigint,
  "reserved_calls" integer DEFAULT 0 NOT NULL,
  "spent_calls" integer DEFAULT 0 NOT NULL,
  "reserved_cost_microunits" bigint DEFAULT 0 NOT NULL,
  "spent_cost_microunits" bigint DEFAULT 0 NOT NULL,
  "cooldown_snapshot_at" timestamp with time zone,
  "deadline_at" timestamp with time zone,
  "delayed_at" timestamp with time zone,
  "worker_lease_owner_hash" text,
  "worker_lease_expires_at" timestamp with time zone,
  "worker_lease_fence" bigint DEFAULT 0 NOT NULL,
  "failure_code" text,
  "correlation_id" text NOT NULL,
  "actor_class" text NOT NULL,
  "reason_code" text NOT NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recovery_operations_key_hash_check" CHECK ("idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "recovery_operations_kind_check" CHECK ("kind" in ('initial', 'manual', 'automatic', 'operator')),
  CONSTRAINT "recovery_operations_state_check" CHECK ("state" in ('accepted', 'active', 'delayed', 'completed', 'failed', 'cancelled')),
  CONSTRAINT "recovery_operations_phase_check" CHECK ("phase" in ('queued', 'preflighting', 'chunking', 'transcribing', 'delayed', 'publishing', 'completed', 'failed', 'disabled')),
  CONSTRAINT "recovery_operations_eligibility_code_check" CHECK (
    "eligibility_code" is null or "eligibility_code" in
      ('eligible', 'legacy_unknown', 'wrong_state', 'cooldown', 'budget_exhausted', 'recording_absent', 'capability_unavailable', 'disabled')
  ),
  CONSTRAINT "recovery_operations_failure_code_check" CHECK (
    "failure_code" is null or "failure_code" in
      ('provider_timeout', 'provider_unavailable', 'provider_rejected', 'finalizer_interrupted', 'operation_deadline_exceeded',
       'recording_fetch_transient', 'recording_absent', 'recording_undecodable', 'recording_silent',
       'attestation_failed', 'coverage_incomplete', 'budget_exhausted', 'persistence_failed',
       'cancelled', 'deleted', 'validation_failed', 'authentication_failed')
  ),
  CONSTRAINT "recovery_operations_actor_class_check" CHECK ("actor_class" in ('system', 'user', 'operator')),
  CONSTRAINT "recovery_operations_reason_code_check" CHECK ("reason_code" in ('initial_transcription', 'user_requested', 'automatic_policy', 'operator_override')),
  CONSTRAINT "recovery_operations_correlation_id_check" CHECK (char_length("correlation_id") between 1 and 128),
  CONSTRAINT "recovery_operations_counters_check" CHECK (
    "ordinal" > 0 and
    "planned_audio_ms" between 0 and 9007199254740991 and
    "submitted_audio_ms" between 0 and 9007199254740991 and
    "reserved_calls" >= 0 and "spent_calls" >= 0 and
    "reserved_cost_microunits" >= 0 and "spent_cost_microunits" >= 0 and
    "worker_lease_fence" between 0 and 9007199254740991
  ),
  CONSTRAINT "recovery_operations_source_samples_check" CHECK (
    ("source_sample_rate_hz" is null and "source_sample_count" is null)
    or
    ("source_sample_rate_hz" is not null and "source_sample_count" is not null and
     "source_sample_rate_hz" > 0 and "source_sample_rate_hz" <= 2147483000 and
     "source_sample_rate_hz" % 1000 = 0 and
     "source_sample_count" between 1 and 9007199254740991 and
     "planned_audio_ms" = ("source_sample_count" + ("source_sample_rate_hz" / 1000) - 1) / ("source_sample_rate_hz" / 1000))
  )
);--> statement-breakpoint
CREATE TABLE "transcription_chunks" (
  "id" text PRIMARY KEY NOT NULL,
  "operation_id" text NOT NULL,
  "ordinal" integer NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "start_ms" bigint NOT NULL,
  "end_ms" bigint NOT NULL,
  "speaker_ref_hash" text,
  "provenance" text NOT NULL,
  "state" text NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "retry_count" integer DEFAULT 0 NOT NULL,
  "next_eligible_at" timestamp with time zone,
  "split_parent_id" text,
  "provider_call_ledger_id" text,
  "checkpoint_ciphertext" text,
  "checkpoint_nonce" text,
  "checkpoint_key_version" text,
  "checkpoint_content_hash" text,
  "lease_owner_hash" text,
  "lease_expires_at" timestamp with time zone,
  "lease_fence" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "transcription_chunks_bounds_check" CHECK (
    "ordinal" >= 0 and "version" > 0 and
    "start_ms" between 0 and 9007199254740991 and
    "end_ms" between 1 and 9007199254740991 and "end_ms" > "start_ms" and
    "attempt" >= 0 and "retry_count" between 0 and 1 and
    "lease_fence" between 0 and 9007199254740991
  ),
  CONSTRAINT "transcription_chunks_provenance_check" CHECK ("provenance" in ('provider', 'vexa_fallback')),
  CONSTRAINT "transcription_chunks_state_check" CHECK ("state" in ('planned', 'reserved', 'dispatching', 'retry_scheduled', 'succeeded', 'split', 'fallback', 'failed')),
  CONSTRAINT "transcription_chunks_checkpoint_shape_check" CHECK (
    ("checkpoint_ciphertext" is null and "checkpoint_nonce" is null and
     "checkpoint_key_version" is null and "checkpoint_content_hash" is null)
    or
    ("checkpoint_ciphertext" is not null and "checkpoint_nonce" is not null and
     "checkpoint_key_version" is not null and "checkpoint_content_hash" is not null and
     octet_length("checkpoint_ciphertext") between 1 and 1048576 and
     octet_length("checkpoint_nonce") between 1 and 256 and
     char_length("checkpoint_key_version") between 1 and 128 and
     "checkpoint_content_hash" ~ '^[0-9a-f]{64}$')
  )
);--> statement-breakpoint
CREATE TABLE "provider_call_ledger" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL,
  "operation_id" text NOT NULL,
  "chunk_id" text NOT NULL,
  "reservation_key_hash" text NOT NULL,
  "kind" text NOT NULL,
  "submitted_audio_ms" bigint NOT NULL,
  "submitted_bytes" bigint NOT NULL,
  "reserved_cost_microunits" bigint DEFAULT 0 NOT NULL,
  "spent_cost_microunits" bigint DEFAULT 0 NOT NULL,
  "attempt" integer NOT NULL,
  "dispatch_state" text NOT NULL,
  "outcome_code" text,
  "status_class" text,
  "lease_fence" bigint DEFAULT 0 NOT NULL,
  "budget_bucket_minute" timestamp with time zone DEFAULT now() NOT NULL,
  "reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
  "dispatching_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "provider_call_ledger_reservation_hash_check" CHECK ("reservation_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "provider_call_ledger_kind_check" CHECK ("kind" in ('initial', 'manual', 'automatic', 'operator')),
  CONSTRAINT "provider_call_ledger_dispatch_state_check" CHECK ("dispatch_state" in ('reserved', 'dispatching', 'not_dispatched', 'spent', 'completed')),
  CONSTRAINT "provider_call_ledger_outcome_code_check" CHECK (
    "outcome_code" is null or "outcome_code" in
      ('not_dispatched', 'success', 'timeout', 'transport_error', 'http_408', 'http_429',
       'http_4xx', 'http_5xx', 'invalid_response', 'attestation_failed', 'provider_rejected', 'unknown')
  ),
  CONSTRAINT "provider_call_ledger_status_class_check" CHECK ("status_class" is null or "status_class" in ('none', '2xx', '4xx', '5xx', 'network')),
  CONSTRAINT "provider_call_ledger_counters_check" CHECK (
    "submitted_audio_ms" between 0 and 9007199254740991 and
    "submitted_bytes" between 0 and 9007199254740991 and
    "reserved_cost_microunits" >= 0 and "spent_cost_microunits" >= 0 and
    "attempt" > 0 and "lease_fence" between 0 and 9007199254740991
  )
);--> statement-breakpoint
CREATE TABLE "project_recovery_guards" (
  "project_id" text PRIMARY KEY NOT NULL,
  "lock_version" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_recovery_guards_lock_version_check" CHECK ("lock_version" between 0 and 9007199254740991)
);--> statement-breakpoint
CREATE TABLE "project_recovery_buckets" (
  "project_id" text NOT NULL,
  "bucket_minute" timestamp with time zone NOT NULL,
  "initial_cycles" integer DEFAULT 0 NOT NULL,
  "manual_cycles" integer DEFAULT 0 NOT NULL,
  "automatic_cycles" integer DEFAULT 0 NOT NULL,
  "operator_cycles" integer DEFAULT 0 NOT NULL,
  "reserved_calls" integer DEFAULT 0 NOT NULL,
  "spent_calls" integer DEFAULT 0 NOT NULL,
  "reserved_audio_ms" bigint DEFAULT 0 NOT NULL,
  "spent_audio_ms" bigint DEFAULT 0 NOT NULL,
  "reserved_cost_microunits" bigint DEFAULT 0 NOT NULL,
  "spent_cost_microunits" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_recovery_buckets_pk" PRIMARY KEY("project_id", "bucket_minute"),
  CONSTRAINT "project_recovery_buckets_minute_check" CHECK (
    "bucket_minute" = date_trunc('minute', "bucket_minute" at time zone 'UTC') at time zone 'UTC'
  ),
  CONSTRAINT "project_recovery_buckets_counters_check" CHECK (
    "initial_cycles" >= 0 and "manual_cycles" >= 0 and "automatic_cycles" >= 0 and
    "operator_cycles" >= 0 and "reserved_calls" >= 0 and "spent_calls" >= 0 and
    "reserved_audio_ms" between 0 and 9007199254740991 and
    "spent_audio_ms" between 0 and 9007199254740991 and
    "reserved_cost_microunits" >= 0 and "spent_cost_microunits" >= 0
  )
);--> statement-breakpoint
CREATE TABLE "outbox_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL,
  "operation_id" text NOT NULL,
  "chunk_id" text,
  "event_type" text NOT NULL,
  "dedupe_key_hash" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_owner_hash" text,
  "lease_expires_at" timestamp with time zone,
  "lease_fence" bigint DEFAULT 0 NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "last_error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "outbox_jobs_dedupe_hash_check" CHECK ("dedupe_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "outbox_jobs_event_type_check" CHECK ("event_type" in ('operation.accepted', 'operation.resume', 'chunk.retry', 'transcript.publish', 'notification.deliver')),
  CONSTRAINT "outbox_jobs_state_check" CHECK ("state" in ('pending', 'leased', 'delivered', 'failed', 'cancelled')),
  CONSTRAINT "outbox_jobs_last_error_code_check" CHECK ("last_error_code" is null or "last_error_code" in ('lease_expired', 'delivery_failed', 'persistence_failed', 'operation_deadline_exceeded', 'disabled')),
  CONSTRAINT "outbox_jobs_counters_check" CHECK ("lease_fence" between 0 and 9007199254740991 and "attempt" >= 0)
);--> statement-breakpoint
CREATE TABLE "service_capability_leases" (
  "component" text PRIMARY KEY NOT NULL,
  "lease_owner_hash" text NOT NULL,
  "build_revision" text NOT NULL,
  "contract_version" text NOT NULL,
  "finalizer_version" text NOT NULL,
  "schema_version" text NOT NULL,
  "config_version" text NOT NULL,
  "lease_expires_at" timestamp with time zone NOT NULL,
  "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_fence" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "service_capability_leases_component_check" CHECK ("component" in ('api', 'worker')),
  CONSTRAINT "service_capability_leases_bounded_fields_check" CHECK (
    "lease_owner_hash" ~ '^[0-9a-f]{64}$' and
    char_length("build_revision") between 1 and 128 and
    char_length("contract_version") between 1 and 64 and
    char_length("finalizer_version") between 1 and 64 and
    char_length("schema_version") between 1 and 64 and
    char_length("config_version") between 1 and 128 and
    "lease_fence" between 0 and 9007199254740991
  )
);--> statement-breakpoint
ALTER TABLE "recovery_operations" ADD CONSTRAINT "recovery_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_operations" ADD CONSTRAINT "recovery_operations_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_chunks" ADD CONSTRAINT "transcription_chunks_operation_id_recovery_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."recovery_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_chunks" ADD CONSTRAINT "transcription_chunks_split_parent_id_transcription_chunks_id_fk" FOREIGN KEY ("split_parent_id") REFERENCES "public"."transcription_chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_call_ledger" ADD CONSTRAINT "provider_call_ledger_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_call_ledger" ADD CONSTRAINT "provider_call_ledger_operation_id_recovery_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."recovery_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_call_ledger" ADD CONSTRAINT "provider_call_ledger_chunk_id_transcription_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."transcription_chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_chunks" ADD CONSTRAINT "transcription_chunks_ledger_id_fk" FOREIGN KEY ("provider_call_ledger_id") REFERENCES "public"."provider_call_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_recovery_guards" ADD CONSTRAINT "project_recovery_guards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_recovery_buckets" ADD CONSTRAINT "project_recovery_buckets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_jobs" ADD CONSTRAINT "outbox_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_jobs" ADD CONSTRAINT "outbox_jobs_operation_id_recovery_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."recovery_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_jobs" ADD CONSTRAINT "outbox_jobs_chunk_id_transcription_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."transcription_chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_active_recovery_operation_id_recovery_operations_id_fk" FOREIGN KEY ("active_recovery_operation_id") REFERENCES "public"."recovery_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_operations_project_meeting_key_idx" ON "recovery_operations" USING btree ("project_id", "meeting_id", "idempotency_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_operations_one_active_meeting_idx" ON "recovery_operations" USING btree ("project_id", "meeting_id") WHERE "state" in ('accepted', 'active', 'delayed');--> statement-breakpoint
CREATE INDEX "recovery_operations_project_state_idx" ON "recovery_operations" USING btree ("project_id", "state");--> statement-breakpoint
CREATE UNIQUE INDEX "transcription_chunks_operation_ordinal_version_idx" ON "transcription_chunks" USING btree ("operation_id", "ordinal", "version");--> statement-breakpoint
CREATE INDEX "transcription_chunks_operation_state_idx" ON "transcription_chunks" USING btree ("operation_id", "state");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_call_ledger_operation_chunk_attempt_idx" ON "provider_call_ledger" USING btree ("operation_id", "chunk_id", "attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_call_ledger_project_reservation_idx" ON "provider_call_ledger" USING btree ("project_id", "reservation_key_hash");--> statement-breakpoint
CREATE INDEX "provider_call_ledger_operation_state_idx" ON "provider_call_ledger" USING btree ("operation_id", "dispatch_state");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_jobs_project_dedupe_idx" ON "outbox_jobs" USING btree ("project_id", "dedupe_key_hash");--> statement-breakpoint
CREATE INDEX "outbox_jobs_delivery_idx" ON "outbox_jobs" USING btree ("state", "available_at");
