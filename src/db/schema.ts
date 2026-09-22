import type { CaptureDiagnostics } from "../domain/capture.ts";
import { pgTable, text, timestamp, integer, jsonb, real, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";

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
  claimToken: text("claim_token"),
  /** Present only while this batch has been durably admitted to an external Tinfoil request. */
  dispatchToken: text("dispatch_token"),
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

export type MeetingRow = typeof meetings.$inferSelect;
export type TranscriptRow = typeof transcripts.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
