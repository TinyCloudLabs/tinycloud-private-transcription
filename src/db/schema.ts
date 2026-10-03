import type { CaptureDiagnostics } from "../domain/capture.ts";
import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, integer, bigint, jsonb, real, boolean, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";

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
  /** Exact scope strings (see API_KEY_SCOPES); each authenticated route group requires one. */
  scopes: text("scopes").array().notNull().default([]),
  /** Owned by the sealed PTX_BOOTSTRAP_KEYS env: upserted and revoked at API boot. CLI keys are never touched. */
  bootstrapManaged: boolean("bootstrap_managed").notNull().default(false),
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
    /** Numeric Vexa row ID used exclusively for durable attributed-audio retrieval. */
    vexaMeetingId: integer("vexa_meeting_id"),
    vexaBotId: text("vexa_bot_id"),
    /** Signal worker session ID; unlike a call fragment this is safe operational metadata. */
    signalSessionId: text("signal_session_id"),
    /** AES-GCM encrypted Signal call fragment. Cleared as soon as capture becomes terminal. */
    signalCapability: text("signal_capability"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    captureDiagnostics: jsonb("capture_diagnostics").$type<CaptureDiagnostics>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
    /** Durable deletion fence; prevents new attributed dispatch while provider deletion is in flight. */
    dispatchBlocked: boolean("dispatch_blocked").notNull().default(false),
    /** Ownership token for the deletion fence. A loser must never clear a winner's fence. */
    deletionToken: text("deletion_token"),
    /** Renewable owner lease makes a crash between fencing and provider work recoverable. */
    deletionOwnerId: text("deletion_owner_id"),
    deletionLeaseAt: timestamp("deletion_lease_at", { withTimezone: true }),
    /** Set immediately before an external delete. A replacement reconciles it, never repeats it. */
    deletionProviderAdmittedAt: timestamp("deletion_provider_admitted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("meetings_project_idempotency_idx").on(t.projectId, t.idempotencyKey),
    index("meetings_project_status_idx").on(t.projectId, t.status),
  ],
);

export const transcripts = pgTable("transcripts", {
  meetingId: text("meeting_id").primaryKey().references(() => meetings.id, { onDelete: "cascade" }),
  language: text("language").notNull(),
  durationSeconds: real("duration_seconds").notNull(),
  segmentsJson: jsonb("segments_json").notNull(),
  /** Producer of the stored transcript: normally Vexa, or Tinfoil for recording recovery. */
  provider: text("provider").notNull().default("vexa"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One immutable producer manifest per meeting. Its rows are retained until meeting deletion. */
export const attributedTranscriptionRuns = pgTable("attributed_transcription_runs", {
  meetingId: text("meeting_id").primaryKey().references(() => meetings.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"), // pending | processing | partial | failed | completed
  manifestJson: jsonb("manifest_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const attributedRanges = pgTable("attributed_ranges", {
  meetingId: text("meeting_id").notNull().references(() => meetings.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  rangeJson: jsonb("range_json").notNull(),
  status: text("status").notNull().default("pending"), // pending | silence | completed | unresolved | failed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("attributed_ranges_meeting_sequence_idx").on(t.meetingId, t.sequence)]);

export const attributedBatches = pgTable("attributed_batches", {
  id: text("id").primaryKey(),
  meetingId: text("meeting_id").notNull().references(() => meetings.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  batchJson: jsonb("batch_json").notNull(),
  status: text("status").notNull().default("pending"), // pending | claimed | completed | silence | unresolved | failed | ambiguous
  attempts: integer("attempts").notNull().default(0),
  /** Failed range fetches only; durable so finalize/reconcile requeues cannot reset the bound (TC-576). */
  fetchAttempts: integer("fetch_attempts").notNull().default(0),
  claimToken: text("claim_token"),
  /** Present only while this batch has been durably admitted to an external Tinfoil request. */
  dispatchToken: text("dispatch_token"),
  /** Worker identity which owns an admitted paid request; stale owners are terminalized, never retried. */
  dispatchOwnerId: text("dispatch_owner_id"),
  /** The external-call lease starts at admission, not when a queue message was claimed. */
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  resultJson: jsonb("result_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("attributed_batches_meeting_ordinal_idx").on(t.meetingId, t.ordinal), index("attributed_batches_status_idx").on(t.status)]);

export const attributedAttempts = pgTable("attributed_attempts", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull().references(() => attributedBatches.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  status: text("status").notNull(), // started | succeeded | failed | ambiguous
  outcome: text("outcome"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [uniqueIndex("attributed_attempts_batch_ordinal_idx").on(t.batchId, t.ordinal)]);

/** Two durable, expiring leases preserve global attributed-provider capacity without a long transaction. */
export const tinfoilDispatchSlots = pgTable("tinfoil_dispatch_slots", {
  id: integer("id").primaryKey(),
  claimToken: text("claim_token"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  ownerId: text("owner_id"),
});

/**
 * Durable paid-call fence for whole-recording recovery (TC-574). One row per meeting: a live
 * owner token admits exactly one in-flight recovery transcription; a recorded outcome is
 * terminal, and a stale owner may be re-admitted only while `admissions` stays under its bound.
 */
export const recordingRecoveryRuns = pgTable("recording_recovery_runs", {
  meetingId: text("meeting_id").primaryKey().references(() => meetings.id, { onDelete: "cascade" }),
  /** Process-unique token owning the current admission; the paid call may leave only under it. */
  ownerToken: text("owner_token"),
  admittedAt: timestamp("admitted_at", { withTimezone: true }),
  /** Total grants of the paid-call slot; every grant covers one multi-chunk recovery transcription. */
  admissions: integer("admissions").notNull().default(0),
  /** Terminal once set: succeeded | failed | ambiguous | exhausted. */
  outcome: text("outcome"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});


/** A PostgreSQL-backed worker heartbeat; API and worker commonly run in separate processes. */
export const attributedWorkerReadiness = pgTable("attributed_worker_readiness", {
  id: text("id").primaryKey(),
  ready: boolean("ready").notNull(),
  stage: text("stage").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
});

/** Durable queue intent; Redis only wakes work and is never the source of truth. */
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
    status: text("status").notNull(), // pending | claimed | delivered | failed
    responseCode: integer("response_code"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /** A durable queue/worker lease makes one due attempt single-delivery across worker processes. */
    claimToken: text("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("webhook_deliveries_meeting_idx").on(t.meetingId),
    // A terminal transition has one durable delivery intent.  It makes a post-commit crash
    // recoverable without minting a second completion event.
    uniqueIndex("webhook_deliveries_meeting_event_idx").on(t.meetingId, t.eventType),
  ],
);

/*
 * Batch transcription (PTX_ROLE=batch only). None of these tables is read or written by the meeting role.
 * Every worker write is fenced by (status='processing', claim_token, generation, tombstoned=false); see
 * src/uploads/fence.ts. Admission is serialized on the singleton transcription_admission row.
 */
export const transcriptions = pgTable(
  "transcriptions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    /** HMAC tenant reference supplied by the caller; the only tenant identity PTX ever sees. */
    tenantRef: text("tenant_ref").notNull(),
    status: text("status").notNull(), // awaiting_upload | queued | processing | completed | failed | cancelled
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    language: text("language"),
    channelMode: text("channel_mode").notNull(),
    channelLabels: jsonb("channel_labels").$type<string[]>().notNull(),
    /** Downmixed to mono and split into speaker turns by the diarization stage (create `diarize: true`). */
    diarize: boolean("diarize").notNull().default(false),
    /** Absolute: an upload that has not been accepted by then fails upload_expired. */
    uploadDeadlineAt: timestamp("upload_deadline_at", { withTimezone: true }).notNull(),
    /** The single live PUT (serializes uploads). Heartbeats never extend past upload_lease_hard_expires_at. */
    uploadLeaseToken: text("upload_lease_token"),
    uploadLeaseStartedAt: timestamp("upload_lease_started_at", { withTimezone: true }),
    uploadLeaseHeartbeatAt: timestamp("upload_lease_heartbeat_at", { withTimezone: true }),
    uploadLeaseHardExpiresAt: timestamp("upload_lease_hard_expires_at", { withTimezone: true }),
    /** File name (inside the job directory) of the accepted upload. */
    audioFile: text("audio_file"),
    durationSeconds: real("duration_seconds"),
    channels: integer("channels"),
    /** Fencing generation: bumped by every worker claim and by every cancel/delete/timeout invalidation. */
    generation: integer("generation").notNull().default(0),
    claimToken: text("claim_token"),
    claimOwnerId: text("claim_owner_id"),
    claimHeartbeatAt: timestamp("claim_heartbeat_at", { withTimezone: true }),
    claimCount: integer("claim_count").notNull().default(0),
    tinfoilCalls: integer("tinfoil_calls").notNull().default(0),
    tinfoilAudioSeconds: real("tinfoil_audio_seconds").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    /** Deletion ledger: pending is committed with (or before) the terminal state, before any unlink. */
    deletionState: text("deletion_state").notNull().default("none"), // none | pending | files_deleted
    filesDeletedAt: timestamp("files_deleted_at", { withTimezone: true }),
    deletionAttempts: integer("deletion_attempts").notNull().default(0),
    tombstoned: boolean("tombstoned").notNull().default(false),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    transcriptExpiresAt: timestamp("transcript_expires_at", { withTimezone: true }),
    transcriptDeletedAt: timestamp("transcript_deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("transcriptions_project_idempotency_idx").on(t.projectId, t.idempotencyKey),
    // One active job per tenant, enforced by the database even if the admission lock were bypassed.
    uniqueIndex("transcriptions_one_active_per_tenant_idx").on(t.projectId, t.tenantRef)
      .where(sql`${t.status} in ('awaiting_upload', 'queued', 'processing')`),
    index("transcriptions_status_idx").on(t.status),
    index("transcriptions_tenant_idx").on(t.projectId, t.tenantRef, t.createdAt),
    index("transcriptions_deletion_idx").on(t.deletionState),
  ],
);

/** Job-scoped upload capabilities (sha256 only). Deleted in the same transaction that ends awaiting_upload. */
export const transcriptionCapabilities = pgTable("transcription_capabilities", {
  id: text("id").primaryKey(),
  transcriptionId: text("transcription_id").notNull().references(() => transcriptions.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("transcription_capabilities_job_idx").on(t.transcriptionId)]);

/** VAD regions (or speaker turns of a diarized job), one provider request each. Text is content: nulled on DELETE and transcript expiry. */
export const transcriptionRegions = pgTable("transcription_regions", {
  transcriptionId: text("transcription_id").notNull().references(() => transcriptions.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  channel: integer("channel").notNull(),
  /** Diarizer speaker label of a diarized job's turn (renumbered by first appearance at assembly); null otherwise. */
  speaker: integer("speaker"),
  startMs: integer("start_ms").notNull(),
  endMs: integer("end_ms").notNull(),
  status: text("status").notNull().default("pending"), // pending | completed | failed | ambiguous
  text: text("text"),
  generation: integer("generation").notNull(),
}, (t) => [primaryKey({ columns: [t.transcriptionId, t.ordinal] })]);

/** Exactly-once provider ledger. A started attempt is committed before the call; ambiguous ones are never re-sent. */
export const transcriptionAttempts = pgTable("transcription_attempts", {
  id: text("id").primaryKey(),
  transcriptionId: text("transcription_id").notNull().references(() => transcriptions.id, { onDelete: "cascade" }),
  regionOrdinal: integer("region_ordinal").notNull(),
  ordinal: integer("ordinal").notNull(),
  generation: integer("generation").notNull(),
  status: text("status").notNull(), // started | succeeded | rate_limited | not_sent | rejected | ambiguous | discarded
  outcome: text("outcome"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [uniqueIndex("transcription_attempts_region_ordinal_idx").on(t.transcriptionId, t.regionOrdinal, t.ordinal)]);

/** The assembled transcript. The row is deleted on DELETE and on transcript expiry. */
export const transcriptionResults = pgTable("transcription_results", {
  transcriptionId: text("transcription_id").primaryKey().references(() => transcriptions.id, { onDelete: "cascade" }),
  resultJson: jsonb("result_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row (id=1): the durable single-slot provider arbiter. At most one Tinfoil call is ever admitted. */
export const providerDispatchSlots = pgTable("provider_dispatch_slots", {
  id: integer("id").primaryKey(),
  attemptId: text("attempt_id"),
  transcriptionId: text("transcription_id"),
  ownerId: text("owner_id"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
});

/** Per-tenant daily byte budget, charged atomically at create. */
export const transcriptionTenantUsage = pgTable("transcription_tenant_usage", {
  projectId: text("project_id").notNull(),
  tenantRef: text("tenant_ref").notNull(),
  day: text("day").notNull(),
  bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
}, (t) => [primaryKey({ columns: [t.projectId, t.tenantRef, t.day] })]);

/**
 * One row (id=1): admission mode and the lock that serializes every create and upload-lease admission. A fresh
 * install starts `closed` (0018); only the deploy workflow's final gate opens it.
 */
export const transcriptionAdmission = pgTable("transcription_admission", {
  id: integer("id").primaryKey(),
  mode: text("mode").notNull().default("closed"), // open | drain | closed
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Batch worker process heartbeats; the API only admits work while one is live. */
export const transcriptionWorkers = pgTable("transcription_workers", {
  id: text("id").primaryKey(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
});

export type TranscriptionRow = typeof transcriptions.$inferSelect;
export type MeetingRow = typeof meetings.$inferSelect;
export type TranscriptRow = typeof transcripts.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
