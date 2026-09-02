import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  ForeignKeyBuilder,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { PROVIDER_V2_MAX_SOURCE_SAMPLE_RATE_HZ } from "../providers/transcription/provider-v2-planner.ts";

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  webhookSecret: text("webhook_secret").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  keyHash: text("key_hash").notNull().unique(),
  scopes: text("scopes").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const meetings = pgTable(
  "meetings",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    meetingUrl: text("meeting_url").notNull(),
    platform: text("platform").notNull(),
    status: text("status").notNull(),
    botName: text("bot_name"),
    language: text("language"),
    webhookUrl: text("webhook_url"),
    vexaPlatform: text("vexa_platform"),
    vexaNativeMeetingId: text("vexa_native_meeting_id"),
    vexaBotId: text("vexa_bot_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
    transcriptionAttempts: integer("transcription_attempts").notNull().default(0),
    budgetProvenance: text("budget_provenance").notNull().default("tracked"),
    manualRecoveryCyclesConsumed: integer("manual_recovery_cycles_consumed").notNull().default(0),
    automaticRecoveryCyclesConsumed: integer("automatic_recovery_cycles_consumed").notNull().default(0),
    operatorRecoveryCyclesConsumed: integer("operator_recovery_cycles_consumed").notNull().default(0),
    consecutiveRecoverableFailures: integer("consecutive_recoverable_failures").notNull().default(0),
    nextRecoveryEligibleAt: timestamp("next_recovery_eligible_at", { withTimezone: true }),
    activeRecoveryOperationId: text("active_recovery_operation_id").references(
      (): AnyPgColumn => recoveryOperations.id,
    ),
    lastRecoveryOutcome: text("last_recovery_outcome"),
    recoveryPhase: text("recovery_phase"),
    transcriptRevision: integer("transcript_revision").notNull().default(0),
    recoveryCapabilityVersion: text("recovery_capability_version"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletionFence: bigint("deletion_fence", { mode: "number" }).notNull().default(0),
    deletionSagaState: text("deletion_saga_state"),
    deletionProviderPlatform: text("deletion_provider_platform"),
    deletionProviderNativeMeetingId: text("deletion_provider_native_meeting_id"),
  },
  (t) => [
    uniqueIndex("meetings_project_idempotency_idx").on(t.projectId, t.idempotencyKey),
    index("meetings_project_status_idx").on(t.projectId, t.status),
    check("meetings_budget_provenance_check", sql`${t.budgetProvenance} in ('tracked', 'legacy_unknown')`),
    check("meetings_recovery_counters_check", sql`
      ${t.manualRecoveryCyclesConsumed} >= 0 and
      ${t.automaticRecoveryCyclesConsumed} >= 0 and
      ${t.operatorRecoveryCyclesConsumed} >= 0 and
      ${t.consecutiveRecoverableFailures} >= 0 and
      ${t.transcriptRevision} >= 0
    `),
    check("meetings_last_recovery_outcome_check", sql`
      ${t.lastRecoveryOutcome} is null or ${t.lastRecoveryOutcome} in
        ('completed', 'failed', 'disabled', 'budget_exhausted', 'cancelled')
    `),
    check("meetings_recovery_phase_check", sql`
      ${t.recoveryPhase} is null or ${t.recoveryPhase} in
        ('queued', 'preflighting', 'chunking', 'transcribing', 'delayed', 'publishing', 'completed', 'failed', 'disabled')
    `),
    check("meetings_create_idempotency_key_check", sql`
      ${t.idempotencyKey} is null or ${t.idempotencyKey} ~ '^[!-~]{1,128}$'
    `),
    check("meetings_deletion_fence_check", sql`
      ${t.deletionFence} between 0 and 9007199254740991 and
      (
        (${t.deletedAt} is null and ${t.deletionSagaState} is null and
         ${t.deletionProviderPlatform} is null and ${t.deletionProviderNativeMeetingId} is null)
        or
        (${t.deletedAt} is not null and ${t.deletionSagaState} in ('pending', 'completed') and
         ((${t.deletionProviderPlatform} is null and ${t.deletionProviderNativeMeetingId} is null)
          or (${t.deletionSagaState} = 'pending' and ${t.deletionProviderPlatform} is not null and
              ${t.deletionProviderNativeMeetingId} is not null)))
      )
    `),
  ],
);

export const transcripts = pgTable("transcripts", {
  meetingId: text("meeting_id").primaryKey().references(() => meetings.id, { onDelete: "cascade" }),
  language: text("language").notNull(),
  durationSeconds: real("duration_seconds").notNull(),
  segmentsJson: jsonb("segments_json").notNull(),
  /** Which provider produced the stored transcript: "vexa" (WhisperLive passthrough / fallback) | "tinfoil". */
  provider: text("provider").notNull().default("vexa"),
  /** Set when the configured provider fell back to vexa-native: the provider we fell back FROM (e.g. "tinfoil"). */
  fallbackFrom: text("fallback_from"),
  /** Why the fallback fired (e.g. "no_usable_recording", "provider_unavailable_after_retries"). */
  fallbackReason: text("fallback_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    meetingId: text("meeting_id").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    endpoint: text("endpoint").notNull(),
    payload: text("payload").notNull(),
    attempt: integer("attempt").notNull().default(0),
    status: text("status").notNull(), // pending | delivered | failed
    responseCode: integer("response_code"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_deliveries_meeting_idx").on(t.meetingId)],
);

export const recoveryOperations = pgTable(
  "recovery_operations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    meetingId: text("meeting_id").notNull().references(() => meetings.id),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    kind: text("kind").notNull(),
    state: text("state").notNull(),
    phase: text("phase").notNull(),
    eligibilityCode: text("eligibility_code"),
    ordinal: integer("ordinal").notNull(),
    plannedAudioMs: bigint("planned_audio_ms", { mode: "number" }).notNull().default(0),
    submittedAudioMs: bigint("submitted_audio_ms", { mode: "number" }).notNull().default(0),
    sourceSampleRateHz: integer("source_sample_rate_hz"),
    sourceSampleCount: bigint("source_sample_count", { mode: "number" }),
    reservedCalls: integer("reserved_calls").notNull().default(0),
    spentCalls: integer("spent_calls").notNull().default(0),
    reservedCostMicrounits: bigint("reserved_cost_microunits", { mode: "bigint" }).notNull().default(sql`0`),
    spentCostMicrounits: bigint("spent_cost_microunits", { mode: "bigint" }).notNull().default(sql`0`),
    cooldownSnapshotAt: timestamp("cooldown_snapshot_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    delayedAt: timestamp("delayed_at", { withTimezone: true }),
    workerLeaseOwnerHash: text("worker_lease_owner_hash"),
    workerLeaseExpiresAt: timestamp("worker_lease_expires_at", { withTimezone: true }),
    workerLeaseFence: bigint("worker_lease_fence", { mode: "number" }).notNull().default(0),
    failureCode: text("failure_code"),
    correlationId: text("correlation_id").notNull(),
    actorClass: text("actor_class").notNull(),
    reasonCode: text("reason_code").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("recovery_operations_project_meeting_key_idx").on(t.projectId, t.meetingId, t.idempotencyKeyHash),
    uniqueIndex("recovery_operations_one_active_meeting_idx")
      .on(t.projectId, t.meetingId)
      .where(sql`${t.state} in ('accepted', 'active', 'delayed')`),
    index("recovery_operations_project_state_idx").on(t.projectId, t.state),
    check("recovery_operations_key_hash_check", sql`${t.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`),
    check("recovery_operations_kind_check", sql`${t.kind} in ('initial', 'manual', 'automatic', 'operator')`),
    check("recovery_operations_state_check", sql`${t.state} in ('accepted', 'active', 'delayed', 'completed', 'failed', 'cancelled')`),
    check("recovery_operations_phase_check", sql`
      ${t.phase} in ('queued', 'preflighting', 'chunking', 'transcribing', 'delayed', 'publishing', 'completed', 'failed', 'disabled')
    `),
    check("recovery_operations_eligibility_code_check", sql`
      ${t.eligibilityCode} is null or ${t.eligibilityCode} in
        ('eligible', 'legacy_unknown', 'wrong_state', 'cooldown', 'budget_exhausted', 'recording_absent', 'capability_unavailable', 'disabled')
    `),
    check("recovery_operations_failure_code_check", sql`
      ${t.failureCode} is null or ${t.failureCode} in
        ('provider_timeout', 'provider_unavailable', 'provider_rejected', 'finalizer_interrupted', 'operation_deadline_exceeded',
         'recording_fetch_transient', 'recording_absent', 'recording_undecodable', 'recording_silent',
         'attestation_failed', 'coverage_incomplete', 'budget_exhausted', 'persistence_failed',
         'cancelled', 'deleted', 'validation_failed', 'authentication_failed')
    `),
    check("recovery_operations_actor_class_check", sql`${t.actorClass} in ('system', 'user', 'operator')`),
    check("recovery_operations_reason_code_check", sql`
      ${t.reasonCode} in ('initial_transcription', 'user_requested', 'automatic_policy', 'operator_override')
    `),
    check("recovery_operations_correlation_id_check", sql`char_length(${t.correlationId}) between 1 and 128`),
    check("recovery_operations_counters_check", sql`
      ${t.ordinal} > 0 and
      ${t.plannedAudioMs} between 0 and 9007199254740991 and
      ${t.submittedAudioMs} between 0 and 9007199254740991 and
      ${t.reservedCalls} >= 0 and ${t.spentCalls} >= 0 and
      ${t.reservedCostMicrounits} >= 0 and ${t.spentCostMicrounits} >= 0 and
      ${t.workerLeaseFence} between 0 and 9007199254740991
    `),
    check("recovery_operations_source_samples_check", sql`
      (${t.sourceSampleRateHz} is null and ${t.sourceSampleCount} is null)
      or
      (${t.sourceSampleRateHz} is not null and ${t.sourceSampleCount} is not null and
       ${t.sourceSampleRateHz} > 0 and
       ${t.sourceSampleRateHz} <= ${sql.raw(String(PROVIDER_V2_MAX_SOURCE_SAMPLE_RATE_HZ))} and
       ${t.sourceSampleRateHz} % 1000 = 0 and
       ${t.sourceSampleCount} between 1 and 9007199254740991 and
       ${t.plannedAudioMs} = (${t.sourceSampleCount} + (${t.sourceSampleRateHz} / 1000) - 1) / (${t.sourceSampleRateHz} / 1000))
    `),
  ],
);

export const transcriptionChunks = pgTable(
  "transcription_chunks",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id").notNull().references(() => recoveryOperations.id),
    ordinal: integer("ordinal").notNull(),
    version: integer("version").notNull().default(1),
    startMs: bigint("start_ms", { mode: "number" }).notNull(),
    endMs: bigint("end_ms", { mode: "number" }).notNull(),
    speakerRefHash: text("speaker_ref_hash"),
    provenance: text("provenance").notNull(),
    state: text("state").notNull(),
    attempt: integer("attempt").notNull().default(0),
    retryCount: integer("retry_count").notNull().default(0),
    nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true }),
    splitParentId: text("split_parent_id").references((): AnyPgColumn => transcriptionChunks.id),
    providerCallLedgerId: text("provider_call_ledger_id"),
    checkpointCiphertext: text("checkpoint_ciphertext"),
    checkpointNonce: text("checkpoint_nonce"),
    checkpointKeyVersion: text("checkpoint_key_version"),
    checkpointContentHash: text("checkpoint_content_hash"),
    leaseOwnerHash: text("lease_owner_hash"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseFence: bigint("lease_fence", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("transcription_chunks_operation_ordinal_version_idx").on(t.operationId, t.ordinal, t.version),
    index("transcription_chunks_operation_state_idx").on(t.operationId, t.state),
    new ForeignKeyBuilder((): {
      name: string;
      columns: AnyPgColumn[];
      foreignColumns: AnyPgColumn[];
    } => ({
      name: "transcription_chunks_ledger_id_fk",
      columns: [t.providerCallLedgerId],
      foreignColumns: [providerCallLedger.id],
    })),
    check("transcription_chunks_bounds_check", sql`
      ${t.ordinal} >= 0 and ${t.version} > 0 and
      ${t.startMs} between 0 and 9007199254740991 and
      ${t.endMs} between 1 and 9007199254740991 and ${t.endMs} > ${t.startMs} and
      ${t.attempt} >= 0 and ${t.retryCount} between 0 and 1 and
      ${t.leaseFence} between 0 and 9007199254740991
    `),
    check("transcription_chunks_provenance_check", sql`${t.provenance} in ('provider', 'vexa_fallback')`),
    check("transcription_chunks_state_check", sql`
      ${t.state} in ('planned', 'reserved', 'dispatching', 'retry_scheduled', 'succeeded', 'split', 'fallback', 'failed')
    `),
    check("transcription_chunks_checkpoint_shape_check", sql`
      (${t.checkpointCiphertext} is null and ${t.checkpointNonce} is null and
       ${t.checkpointKeyVersion} is null and ${t.checkpointContentHash} is null)
      or
      (${t.checkpointCiphertext} is not null and ${t.checkpointNonce} is not null and
       ${t.checkpointKeyVersion} is not null and ${t.checkpointContentHash} is not null and
       octet_length(${t.checkpointCiphertext}) between 1 and 1048576 and
       octet_length(${t.checkpointNonce}) between 1 and 256 and
       char_length(${t.checkpointKeyVersion}) between 1 and 128 and
       ${t.checkpointContentHash} ~ '^[0-9a-f]{64}$')
    `),
  ],
);

export const providerCallLedger = pgTable(
  "provider_call_ledger",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    operationId: text("operation_id").notNull().references(() => recoveryOperations.id),
    chunkId: text("chunk_id").notNull().references(() => transcriptionChunks.id),
    reservationKeyHash: text("reservation_key_hash").notNull(),
    kind: text("kind").notNull(),
    submittedAudioMs: bigint("submitted_audio_ms", { mode: "number" }).notNull(),
    submittedBytes: bigint("submitted_bytes", { mode: "number" }).notNull(),
    reservedCostMicrounits: bigint("reserved_cost_microunits", { mode: "bigint" }).notNull().default(sql`0`),
    spentCostMicrounits: bigint("spent_cost_microunits", { mode: "bigint" }).notNull().default(sql`0`),
    attempt: integer("attempt").notNull(),
    dispatchState: text("dispatch_state").notNull(),
    outcomeCode: text("outcome_code"),
    statusClass: text("status_class"),
    leaseFence: bigint("lease_fence", { mode: "number" }).notNull().default(0),
    budgetBucketMinute: timestamp("budget_bucket_minute", { withTimezone: true }).notNull().defaultNow(),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchingAt: timestamp("dispatching_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("provider_call_ledger_operation_chunk_attempt_idx").on(t.operationId, t.chunkId, t.attempt),
    uniqueIndex("provider_call_ledger_project_reservation_idx").on(t.projectId, t.reservationKeyHash),
    index("provider_call_ledger_operation_state_idx").on(t.operationId, t.dispatchState),
    check("provider_call_ledger_reservation_hash_check", sql`${t.reservationKeyHash} ~ '^[0-9a-f]{64}$'`),
    check("provider_call_ledger_kind_check", sql`${t.kind} in ('initial', 'manual', 'automatic', 'operator')`),
    check("provider_call_ledger_dispatch_state_check", sql`
      ${t.dispatchState} in ('reserved', 'dispatching', 'not_dispatched', 'spent', 'completed')
    `),
    check("provider_call_ledger_outcome_code_check", sql`
      ${t.outcomeCode} is null or ${t.outcomeCode} in
        ('not_dispatched', 'success', 'timeout', 'transport_error', 'http_408', 'http_429',
         'http_4xx', 'http_5xx', 'invalid_response', 'attestation_failed', 'provider_rejected', 'unknown')
    `),
    check("provider_call_ledger_status_class_check", sql`
      ${t.statusClass} is null or ${t.statusClass} in ('none', '2xx', '4xx', '5xx', 'network')
    `),
    check("provider_call_ledger_counters_check", sql`
      ${t.submittedAudioMs} between 0 and 9007199254740991 and
      ${t.submittedBytes} between 0 and 9007199254740991 and
      ${t.reservedCostMicrounits} >= 0 and ${t.spentCostMicrounits} >= 0 and
      ${t.attempt} > 0 and ${t.leaseFence} between 0 and 9007199254740991
    `),
  ],
);

export const projectRecoveryGuards = pgTable(
  "project_recovery_guards",
  {
    projectId: text("project_id").primaryKey().references(() => projects.id),
    lockVersion: bigint("lock_version", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("project_recovery_guards_lock_version_check", sql`${t.lockVersion} between 0 and 9007199254740991`)],
);

export const projectRecoveryBuckets = pgTable(
  "project_recovery_buckets",
  {
    projectId: text("project_id").notNull().references(() => projects.id),
    bucketMinute: timestamp("bucket_minute", { withTimezone: true }).notNull(),
    initialCycles: integer("initial_cycles").notNull().default(0),
    manualCycles: integer("manual_cycles").notNull().default(0),
    automaticCycles: integer("automatic_cycles").notNull().default(0),
    operatorCycles: integer("operator_cycles").notNull().default(0),
    reservedCalls: integer("reserved_calls").notNull().default(0),
    spentCalls: integer("spent_calls").notNull().default(0),
    reservedAudioMs: bigint("reserved_audio_ms", { mode: "number" }).notNull().default(0),
    spentAudioMs: bigint("spent_audio_ms", { mode: "number" }).notNull().default(0),
    reservedCostMicrounits: bigint("reserved_cost_microunits", { mode: "bigint" }).notNull().default(sql`0`),
    spentCostMicrounits: bigint("spent_cost_microunits", { mode: "bigint" }).notNull().default(sql`0`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "project_recovery_buckets_pk", columns: [t.projectId, t.bucketMinute] }),
    check("project_recovery_buckets_minute_check", sql`
      ${t.bucketMinute} = date_trunc('minute', ${t.bucketMinute} at time zone 'UTC') at time zone 'UTC'
    `),
    check("project_recovery_buckets_counters_check", sql`
      ${t.initialCycles} >= 0 and ${t.manualCycles} >= 0 and ${t.automaticCycles} >= 0 and
      ${t.operatorCycles} >= 0 and ${t.reservedCalls} >= 0 and ${t.spentCalls} >= 0 and
      ${t.reservedAudioMs} between 0 and 9007199254740991 and
      ${t.spentAudioMs} between 0 and 9007199254740991 and
      ${t.reservedCostMicrounits} >= 0 and ${t.spentCostMicrounits} >= 0
    `),
  ],
);

export const outboxJobs = pgTable(
  "outbox_jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    operationId: text("operation_id").notNull().references(() => recoveryOperations.id),
    chunkId: text("chunk_id").references(() => transcriptionChunks.id),
    eventType: text("event_type").notNull(),
    dedupeKeyHash: text("dedupe_key_hash").notNull(),
    state: text("state").notNull().default("pending"),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwnerHash: text("lease_owner_hash"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseFence: bigint("lease_fence", { mode: "number" }).notNull().default(0),
    attempt: integer("attempt").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("outbox_jobs_project_dedupe_idx").on(t.projectId, t.dedupeKeyHash),
    index("outbox_jobs_delivery_idx").on(t.state, t.availableAt),
    check("outbox_jobs_dedupe_hash_check", sql`${t.dedupeKeyHash} ~ '^[0-9a-f]{64}$'`),
    check("outbox_jobs_event_type_check", sql`${t.eventType} in ('operation.accepted', 'operation.resume', 'chunk.retry', 'transcript.publish', 'notification.deliver')`),
    check("outbox_jobs_state_check", sql`${t.state} in ('pending', 'leased', 'delivered', 'failed', 'cancelled')`),
    check("outbox_jobs_last_error_code_check", sql`
      ${t.lastErrorCode} is null or ${t.lastErrorCode} in
        ('lease_expired', 'delivery_failed', 'persistence_failed', 'operation_deadline_exceeded', 'disabled')
    `),
    check("outbox_jobs_counters_check", sql`${t.leaseFence} between 0 and 9007199254740991 and ${t.attempt} >= 0`),
  ],
);

export const serviceCapabilityLeases = pgTable(
  "service_capability_leases",
  {
    component: text("component").primaryKey(),
    leaseOwnerHash: text("lease_owner_hash").notNull(),
    buildRevision: text("build_revision").notNull(),
    contractVersion: text("contract_version").notNull(),
    finalizerVersion: text("finalizer_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    configVersion: text("config_version").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    leaseFence: bigint("lease_fence", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("service_capability_leases_component_check", sql`${t.component} in ('api', 'worker')`),
    check("service_capability_leases_bounded_fields_check", sql`
      ${t.leaseOwnerHash} ~ '^[0-9a-f]{64}$' and
      char_length(${t.buildRevision}) between 1 and 128 and
      char_length(${t.contractVersion}) between 1 and 64 and
      char_length(${t.finalizerVersion}) between 1 and 64 and
      char_length(${t.schemaVersion}) between 1 and 64 and
      char_length(${t.configVersion}) between 1 and 128 and
      ${t.leaseFence} between 0 and 9007199254740991
    `),
  ],
);

export type MeetingRow = typeof meetings.$inferSelect;
export type TranscriptRow = typeof transcripts.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type RecoveryOperationRow = typeof recoveryOperations.$inferSelect;
export type TranscriptionChunkRow = typeof transcriptionChunks.$inferSelect;
export type ProviderCallLedgerRow = typeof providerCallLedger.$inferSelect;
export type ProjectRecoveryBucketRow = typeof projectRecoveryBuckets.$inferSelect;
export type OutboxJobRow = typeof outboxJobs.$inferSelect;
export type ServiceCapabilityLeaseRow = typeof serviceCapabilityLeases.$inferSelect;
