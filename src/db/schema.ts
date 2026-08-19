import { pgTable, text, timestamp, integer, jsonb, real, index, uniqueIndex } from "drizzle-orm/pg-core";

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

export type MeetingRow = typeof meetings.$inferSelect;
export type TranscriptRow = typeof transcripts.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
