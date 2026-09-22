import { and, eq, isNotNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { AppContext } from "../context.ts";
import { attributedBatches, attributedTranscriptionRuns, meetings, transcripts, type MeetingRow, type TranscriptRow } from "../db/schema.ts";
import { ApiError, type ErrorCode, errorTypeFor } from "../domain/errors.ts";
import { newMeetingId } from "../domain/ids.ts";
import { detectPlatform, type Platform } from "../domain/platform.ts";
import { canTransition, isTerminal, type MeetingStatus } from "../domain/state.ts";
import type { NormalizedTranscript } from "../domain/transcript.ts";
import { recordCapture } from "./capture.ts";
import { VexaHttpError } from "../providers/vexa/client.ts";
import { sealSignalCapability } from "../providers/signal/capability.ts";
import { wakeWebhookDelivery, webhookDeliveryValues } from "../webhooks/dispatcher.ts";

export interface CreateMeetingInput {
  meeting_url: string;
  bot_name?: string;
  language?: string;
  webhook_url?: string;
  platform?: string;
  metadata?: Record<string, unknown>;
}

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
};
export const hashCreateRequest = (input: CreateMeetingInput) => createHash("sha256").update(canonical(input)).digest("hex");

export async function createMeeting(
  ctx: AppContext,
  projectId: string,
  input: CreateMeetingInput,
  idempotencyKey: string | null,
): Promise<{ meeting: MeetingRow; created: boolean }> {
  const detected = detectPlatform(input.meeting_url, input.platform);
  const signalUrl = detected.platform === "signal" ? new URL(input.meeting_url) : null;
  const signalCapability = signalUrl?.hash.slice(1) ?? null;
  // Never retain a raw Signal fragment in an idempotency hash, URL column, API object, webhook, or log.
  if (signalUrl) signalUrl.hash = "";
  const storedMeetingUrl = signalUrl?.toString() ?? input.meeting_url;
  const requestHash = hashCreateRequest({ ...input, meeting_url: storedMeetingUrl });
  if (idempotencyKey) {
    const [existing] = await ctx.db
      .select()
      .from(meetings)
      .where(and(eq(meetings.projectId, projectId), eq(meetings.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ApiError("idempotency_conflict", "Idempotency-Key was already used with a different request body");
      }
      return { meeting: existing, created: false };
    }
  }
  // Detection recognizes every platform; deployments only accept the ones in ENABLED_PLATFORMS
  // (default jitsi — the others are detected but not serviceable yet, see .context/ptx-demo-readiness.md #8).
  if (!ctx.config.enabledPlatforms.includes(detected.platform)) {
    throw new ApiError(
      "unsupported_platform",
      `The ${detected.platform} platform was detected but is not enabled on this deployment.`,
    );
  }
  const [row] = await ctx.db
    .insert(meetings)
    .values({
      id: newMeetingId(),
      projectId,
      meetingUrl: storedMeetingUrl,
      platform: detected.platform,
      status: "queued",
      botName: input.bot_name ?? null,
      language: input.language ?? null,
      webhookUrl: input.webhook_url ?? null,
      vexaNativeMeetingId: detected.nativeMeetingId,
      metadata: input.metadata ?? {},
      idempotencyKey,
      requestHash,
      ...(signalCapability ? { signalCapability: sealSignalCapability(signalCapability, ctx.config.signal.capabilityKey) } : {}),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    // Lost a race on the idempotency key; return the winner.
    return createMeeting(ctx, projectId, input, idempotencyKey);
  }
  await ctx.queue.push({ type: "meeting.start", meetingId: row.id });
  return { meeting: row, created: true };
}

export async function getMeeting(ctx: AppContext, projectId: string, id: string): Promise<MeetingRow> {
  const [row] = await ctx.db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, id), eq(meetings.projectId, projectId)))
    .limit(1);
  if (!row) throw new ApiError("meeting_not_found", `No meeting with id ${id}`);
  return row;
}

export async function getMeetingById(ctx: AppContext, id: string): Promise<MeetingRow | null> {
  const [row] = await ctx.db.select().from(meetings).where(eq(meetings.id, id)).limit(1);
  return row ?? null;
}

export async function getTranscript(ctx: AppContext, meetingId: string): Promise<TranscriptRow | null> {
  const [row] = await ctx.db.select().from(transcripts).where(eq(transcripts.meetingId, meetingId)).limit(1);
  return row ?? null;
}

/**
 * Apply a status transition if the state machine allows it. Returns the updated row (or the
 * unchanged row when the transition is not allowed). Timestamps are set on first entry.
 */
export async function transition(
  ctx: AppContext,
  meeting: MeetingRow,
  to: MeetingStatus,
  extra: Partial<typeof meetings.$inferInsert> = {},
): Promise<{ meeting: MeetingRow; changed: boolean }> {
  if (!canTransition(meeting.status as MeetingStatus, to)) return { meeting, changed: false };
  const now = new Date();
  const patch: Partial<typeof meetings.$inferInsert> = { status: to, ...extra };
  if (to === "in_progress" && !meeting.startedAt) patch.startedAt = now;
  if ((to === "processing" || isTerminal(to)) && !meeting.endedAt) patch.endedAt = now;
  if (to === "completed") patch.completedAt = now;
  // The Signal fragment is only needed until a terminal worker result. It must not outlive capture.
  if (isTerminal(to) && meeting.platform === "signal") patch.signalCapability = null;
  if (isTerminal(to)) return terminalTransition(ctx, meeting, to, patch);
  const [row] = await ctx.db
    .update(meetings)
    .set(patch)
    .where(and(eq(meetings.id, meeting.id), eq(meetings.status, meeting.status)))
    .returning();
  // If another writer moved it first, re-read and report unchanged.
  if (!row) return { meeting: (await getMeetingById(ctx, meeting.id)) ?? meeting, changed: false };
  ctx.log.info("meeting status changed", { meetingId: row.id, from: meeting.status, to, completionReason: row.captureDiagnostics?.completion_reason ?? null });
  return { meeting: row, changed: true };
}

/**
 * A paid attributed request is durably marked on its batch before it leaves PostgreSQL. Terminal
 * transitions serialize on the meeting row and wait for that marker to settle. This gives a real
 * ordering fence without holding a database transaction open around a provider request.
 */
async function terminalTransition(
  ctx: AppContext,
  meeting: MeetingRow,
  to: MeetingStatus,
  patch: Partial<typeof meetings.$inferInsert>,
): Promise<{ meeting: MeetingRow; changed: boolean }> {
  for (;;) {
    const result = await ctx.db.transaction(async (tx) => {
      const [current] = await tx.select().from(meetings).where(eq(meetings.id, meeting.id)).for("update");
      if (!current || current.status !== meeting.status || !canTransition(current.status as MeetingStatus, to)) {
        return { meeting: current ?? meeting, changed: false, waiting: false };
      }
      const [run] = await tx.select().from(attributedTranscriptionRuns)
        .where(eq(attributedTranscriptionRuns.meetingId, meeting.id)).for("update");
      if (run) {
        const active = await tx.select({ id: attributedBatches.id }).from(attributedBatches)
          .where(and(eq(attributedBatches.meetingId, meeting.id), isNotNull(attributedBatches.dispatchToken))).for("update");
        if (active.length) return { meeting: current, changed: false, waiting: true };
      }
      const [row] = await tx.update(meetings).set(patch)
        .where(and(eq(meetings.id, meeting.id), eq(meetings.status, meeting.status))).returning();
      return row ? { meeting: row, changed: true, waiting: false } : { meeting: current, changed: false, waiting: false };
    });
    if (!result.waiting) {
      if (result.changed) ctx.log.info("meeting status changed", { meetingId: result.meeting.id, from: meeting.status, to, completionReason: result.meeting.captureDiagnostics?.completion_reason ?? null });
      return result;
    }
    // No transaction is held while a provider call is in flight. A settled request clears its
    // marker atomically; an abandoned process is recovered by the durable claim reconciler.
    await Bun.sleep(10);
  }
}

export async function failMeeting(ctx: AppContext, meeting: MeetingRow, code: ErrorCode, message: string) {
  return transition(ctx, meeting, "failed", { errorCode: code, errorMessage: message });
}

export async function storeTranscript(
  ctx: AppContext,
  meetingId: string,
  t: NormalizedTranscript,
  provider: string,
) {
  // Bun's SQL driver binds a JavaScript object as a JSON string. Cast that JSON text explicitly so
  // Postgres stores a jsonb object instead of a jsonb string containing encoded JSON.
  const segmentsJson = sql`${JSON.stringify({ speakers: t.speakers, segments: t.segments, text: t.text })}::text::jsonb`;
  const row = {
    language: t.language,
    durationSeconds: t.duration_seconds,
    segmentsJson,
    provider,
  };
  await ctx.db
    .insert(transcripts)
    .values({ meetingId, ...row })
    .onConflictDoUpdate({ target: transcripts.meetingId, set: row });
}

/** Commit canonical text, terminal state, and completion delivery intent together. */
export async function completeMeetingWithTranscript(
  ctx: AppContext,
  meetingId: string,
  t: NormalizedTranscript,
  provider: string,
  extra: Partial<typeof meetings.$inferInsert> = {},
): Promise<{ meeting: MeetingRow | null; changed: boolean }> {
  const result = await ctx.db.transaction(async (tx) => {
    const [current] = await tx.select().from(meetings).where(eq(meetings.id, meetingId)).for("update");
    if (!current || current.status !== "processing") return { meeting: current ?? null, changed: false, deliveryId: null };
    const payload = { speakers: t.speakers, segments: t.segments, text: t.text };
    const segmentsJson = sql`${JSON.stringify(payload)}::text::jsonb`;
    await tx.insert(transcripts).values({ meetingId, language: t.language, durationSeconds: t.duration_seconds, segmentsJson, provider })
      .onConflictDoUpdate({ target: transcripts.meetingId, set: { language: t.language, durationSeconds: t.duration_seconds, segmentsJson, provider } });
    const [completed] = await tx.update(meetings).set({ status: "completed", completedAt: new Date(), ...extra })
      .where(and(eq(meetings.id, meetingId), eq(meetings.status, "processing"))).returning();
    if (!completed) return { meeting: null, changed: false, deliveryId: null };
    const intent = webhookDeliveryValues(completed, "meeting.completed", {
      meetingId, language: t.language, durationSeconds: t.duration_seconds, segmentsJson: payload, provider, createdAt: new Date(),
    });
    if (intent) await tx.execute(sql`
      INSERT INTO webhook_deliveries (id, meeting_id, event_id, event_type, endpoint, payload, attempt, status, next_attempt_at)
      VALUES (${intent.id}, ${intent.meetingId}, ${intent.eventId}, ${intent.eventType}, ${intent.endpoint}, ${intent.payload}, 0, 'pending', ${intent.nextAttemptAt})
      ON CONFLICT (meeting_id, event_type) DO NOTHING
    `);
    return { meeting: completed, changed: true, deliveryId: intent?.id ?? null };
  });
  // The intent is already committed; a Redis outage must not turn completed canonical text into a
  // failed meeting.  Worker reconciliation will wake this pending delivery later.
  if (result.deliveryId) await wakeWebhookDelivery(ctx, result.deliveryId, new Date()).catch(() => {
    ctx.log.warn("completion webhook wakeup deferred", { meetingId, stage: "webhook_wakeup" });
  });
  return result;
}

/** Idempotent stop: cancels before admission, otherwise asks Vexa to leave and moves to processing. */
export async function stopMeeting(ctx: AppContext, meeting: MeetingRow): Promise<MeetingRow> {
  const status = meeting.status as MeetingStatus;
  if (isTerminal(status) || status === "processing") return meeting;
  meeting = await recordCapture(ctx, meeting, { stop_requested_at: new Date().toISOString(), stop_requested_by: "user" });
  ctx.log.info("bot stop requested", { meetingId: meeting.id, status, botId: meeting.vexaBotId });
  if (meeting.platform === "signal") await stopInSignal(ctx, meeting);
  else await stopInVexa(ctx, meeting);
  if (status === "in_progress") {
    const { meeting: updated } = await transition(ctx, meeting, "processing");
    await ctx.queue.push({ type: "meeting.poll", meetingId: meeting.id });
    return updated;
  }
  const { meeting: updated } = await transition(ctx, meeting, "cancelled");
  return updated;
}

/**
 * Re-run finalization for a failed meeting whose capture-provider row is still retained.
 * The compare-and-set makes concurrent calls idempotent: only the caller that moves failed →
 * processing enqueues a poll. Completed and already-processing meetings are successful no-ops.
 */
export async function recoverMeeting(ctx: AppContext, meeting: MeetingRow): Promise<MeetingRow> {
  const status = meeting.status as MeetingStatus;
  if (status === "completed") return meeting;
  if (status === "processing") {
    // Repairs the crash window between the failed → processing commit and Redis delivery. A
    // duplicate poll is safe: transcript storage is an upsert and webhooks require the winning
    // terminal state transition.
    await ctx.queue.push({ type: "meeting.poll", meetingId: meeting.id });
    return meeting;
  }
  if (status !== "failed") {
    throw new ApiError("invalid_request", "Only failed meetings can be recovered.");
  }
  const hasRetainedCapture = meeting.platform === "signal" ? !!meeting.signalSessionId : !!meeting.vexaPlatform && !!meeting.vexaNativeMeetingId;
  if (!hasRetainedCapture) {
    throw new ApiError("invalid_request", "This meeting has no retained capture-provider record to recover.");
  }
  const [updated] = await ctx.db
    .update(meetings)
    .set({
      status: "processing",
      errorCode: null,
      errorMessage: null,
    })
    .where(and(eq(meetings.id, meeting.id), eq(meetings.projectId, meeting.projectId), eq(meetings.status, "failed")))
    .returning();
  if (!updated) return (await getMeetingById(ctx, meeting.id)) ?? meeting;
  try {
    await ctx.queue.push({ type: "meeting.poll", meetingId: meeting.id });
  } catch (error) {
    // Do not strand a meeting in processing when Redis is unavailable. A queue write is atomic; in
    // the ambiguous response-lost case, a delivered poll sees the restored terminal state and exits,
    // while the caller can safely retry recovery later.
    await ctx.db
      .update(meetings)
      .set({
        status: "failed",
        errorCode: meeting.errorCode,
        errorMessage: meeting.errorMessage,
      })
      .where(and(eq(meetings.id, meeting.id), eq(meetings.projectId, meeting.projectId), eq(meetings.status, "processing")));
    throw error;
  }
  return updated;
}

async function stopInVexa(ctx: AppContext, meeting: MeetingRow) {
  if (!meeting.vexaPlatform || !meeting.vexaNativeMeetingId) return;
  try {
    await ctx.vexa.stopBot(meeting.vexaPlatform, meeting.vexaNativeMeetingId);
  } catch (e) {
    if (e instanceof VexaHttpError && e.notFound) return;
    ctx.log.warn("vexa stopBot failed", { stage: "stop_provider", code: "provider_unavailable" });
  }
}

async function stopInSignal(ctx: AppContext, meeting: MeetingRow) {
  if (!meeting.signalSessionId) return;
  try { await ctx.signal.leave(meeting.signalSessionId); }
  catch { ctx.log.warn("signal leave failed", { stage: "stop_signal", code: "provider_unavailable" }); }
}

/**
 * Removes our record + transcript and asks Vexa to delete its meeting (404-tolerant). Vexa v0.12 only
 * deletes PLANNED rows and answers 409 for anything the bot lifecycle touched — we log that ("retained
 * by capture provider") and still remove our data; purging Vexa's copy is a documented gap.
 */
export async function deleteMeeting(ctx: AppContext, meeting: MeetingRow): Promise<void> {
  await fenceAttributedDeletion(ctx, meeting.id);
  try {
    if (meeting.platform === "signal") {
      if (!isTerminal(meeting.status as MeetingStatus)) await stopInSignal(ctx, meeting);
      if (meeting.signalSessionId) await ctx.signal.remove(meeting.signalSessionId).catch(() => {});
      await ctx.db.delete(meetings).where(eq(meetings.id, meeting.id));
      return;
    }
    if (meeting.vexaPlatform && meeting.vexaNativeMeetingId) {
      if (!isTerminal(meeting.status as MeetingStatus)) await stopInVexa(ctx, meeting);
      try {
        await ctx.vexa.deleteMeeting(meeting.vexaPlatform, meeting.vexaNativeMeetingId);
      } catch (e) {
        if (e instanceof VexaHttpError && e.conflict && meeting.vexaMeetingId != null) {
          // Attributed ranges are provider-owned evidence.  Retain the complete local ledger until
          // Vexa confirms deletion so a retry cannot silently orphan or destroy that evidence.
          throw new ApiError("provider_unavailable", "Could not confirm deletion from the capture provider");
        } else if (e instanceof VexaHttpError && e.conflict) {
          ctx.log.warn("vexa retains meeting row (409: bot lifecycle owns it)", { stage: "delete_provider", code: "provider_conflict" });
        } else if (!(e instanceof VexaHttpError && e.notFound)) {
          ctx.log.warn("vexa deleteMeeting failed", { stage: "delete_provider", code: "provider_unavailable" });
          throw new ApiError("provider_unavailable", "Could not delete the meeting from the capture provider");
        }
      }
    }
    await ctx.db.delete(meetings).where(eq(meetings.id, meeting.id));
  } catch (error) {
    await ctx.db.update(meetings).set({ dispatchBlocked: false }).where(eq(meetings.id, meeting.id));
    throw error;
  }
}

/** Claim deletion only after any admitted attributed request has settled. */
async function fenceAttributedDeletion(ctx: AppContext, meetingId: string): Promise<void> {
  for (;;) {
    const waiting = await ctx.db.transaction(async (tx) => {
      const [current] = await tx.select().from(meetings).where(eq(meetings.id, meetingId)).for("update");
      if (!current || current.dispatchBlocked) return false;
      const active = await tx.select({ id: attributedBatches.id }).from(attributedBatches)
        .where(and(eq(attributedBatches.meetingId, meetingId), isNotNull(attributedBatches.dispatchToken))).for("update");
      if (active.length) return true;
      await tx.update(meetings).set({ dispatchBlocked: true }).where(eq(meetings.id, meetingId));
      return false;
    });
    if (!waiting) return;
    await Bun.sleep(10);
  }
}

// ---- serialization ----

export function serializeMeeting(m: MeetingRow, transcript: TranscriptRow | null | undefined) {
  const status = m.status as MeetingStatus;
  return {
    id: m.id,
    object: "meeting",
    status,
    platform: m.platform as Platform,
    meeting_url: m.meetingUrl,
    bot: { name: m.botName, joined_at: m.startedAt?.toISOString() ?? null },
    transcript: { status: transcriptStatus(status, !!transcript) },
    created_at: m.createdAt.toISOString(),
    started_at: m.startedAt?.toISOString() ?? null,
    ended_at: m.endedAt?.toISOString() ?? null,
    completed_at: m.completedAt?.toISOString() ?? null,
    metadata: m.metadata ?? {},
    ...(m.captureDiagnostics ? { capture: m.captureDiagnostics } : {}),
    ...(transcript ? transcriptProviderFields(transcript) : {}),
    ...(status === "failed" && m.errorCode
      ? { error: { type: errorTypeFor(m.errorCode as ErrorCode), code: m.errorCode, message: m.errorMessage ?? "" } }
      : {}),
  };
}

/** The provider that produced the stored Vexa transcript. */
export function transcriptProviderFields(t: TranscriptRow) {
  return {
    transcript_provider: t.provider,
  };
}

function transcriptStatus(status: MeetingStatus, hasTranscript: boolean) {
  if (hasTranscript) return "completed";
  if (status === "processing") return "processing";
  if (status === "failed" || status === "cancelled") return "unavailable";
  return "pending";
}

export function serializeTranscript(m: MeetingRow, t: TranscriptRow) {
  // jsonb drivers return objects for new rows. Earlier writers double-encoded this value, so
  // accept a legacy JSON string on reads until those rows are naturally replaced.
  const value = typeof t.segmentsJson === "string" ? JSON.parse(t.segmentsJson) : t.segmentsJson;
  const body = value as { speakers: unknown[]; segments: unknown[]; text: string };
  return {
    meeting_id: m.id,
    status: "completed",
    language: t.language,
    duration_seconds: t.durationSeconds,
    provider: t.provider,
    ...(m.captureDiagnostics ? { capture: m.captureDiagnostics } : {}),
    speakers: body.speakers,
    segments: body.segments,
    text: body.text,
    created_at: t.createdAt.toISOString(),
  };
}
