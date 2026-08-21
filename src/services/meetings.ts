import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { AppContext } from "../context.ts";
import { meetings, transcripts, type MeetingRow, type TranscriptRow } from "../db/schema.ts";
import { ApiError, type ErrorCode, errorTypeFor } from "../domain/errors.ts";
import { newMeetingId } from "../domain/ids.ts";
import { detectPlatform, type Platform } from "../domain/platform.ts";
import { canTransition, isTerminal, type MeetingStatus } from "../domain/state.ts";
import type { NormalizedTranscript } from "../domain/transcript.ts";
import { VexaHttpError } from "../providers/vexa/client.ts";

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
  const requestHash = hashCreateRequest(input);
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
  const detected = detectPlatform(input.meeting_url, input.platform);
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
      meetingUrl: input.meeting_url,
      platform: detected.platform,
      status: "queued",
      botName: input.bot_name ?? null,
      language: input.language ?? null,
      webhookUrl: input.webhook_url ?? null,
      vexaNativeMeetingId: detected.nativeMeetingId,
      metadata: input.metadata ?? {},
      idempotencyKey,
      requestHash,
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
  const [row] = await ctx.db
    .update(meetings)
    .set(patch)
    .where(and(eq(meetings.id, meeting.id), eq(meetings.status, meeting.status)))
    .returning();
  // If another writer moved it first, re-read and report unchanged.
  if (!row) return { meeting: (await getMeetingById(ctx, meeting.id)) ?? meeting, changed: false };
  return { meeting: row, changed: true };
}

export async function failMeeting(ctx: AppContext, meeting: MeetingRow, code: ErrorCode, message: string) {
  return transition(ctx, meeting, "failed", { errorCode: code, errorMessage: message });
}

export async function storeTranscript(
  ctx: AppContext,
  meetingId: string,
  t: NormalizedTranscript,
  provider: string,
  fallback: { from: string; reason: string } | null = null,
) {
  const row = {
    language: t.language,
    durationSeconds: t.duration_seconds,
    segmentsJson: { speakers: t.speakers, segments: t.segments, text: t.text },
    provider,
    fallbackFrom: fallback?.from ?? null,
    fallbackReason: fallback?.reason ?? null,
  };
  await ctx.db
    .insert(transcripts)
    .values({ meetingId, ...row })
    .onConflictDoUpdate({ target: transcripts.meetingId, set: row });
}

/** Idempotent stop: cancels before admission, otherwise asks Vexa to leave and moves to processing. */
export async function stopMeeting(ctx: AppContext, meeting: MeetingRow): Promise<MeetingRow> {
  const status = meeting.status as MeetingStatus;
  if (isTerminal(status) || status === "processing") return meeting;
  await stopInVexa(ctx, meeting);
  if (status === "in_progress") {
    const { meeting: updated } = await transition(ctx, meeting, "processing");
    await ctx.queue.push({ type: "meeting.poll", meetingId: meeting.id });
    return updated;
  }
  const { meeting: updated } = await transition(ctx, meeting, "cancelled");
  return updated;
}

/**
 * Re-run finalization for a failed meeting whose capture-provider row/recording is still retained.
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
  if (!meeting.vexaPlatform || !meeting.vexaNativeMeetingId) {
    throw new ApiError("invalid_request", "This meeting has no retained capture-provider record to recover.");
  }
  const [updated] = await ctx.db
    .update(meetings)
    .set({
      status: "processing",
      errorCode: null,
      errorMessage: null,
      transcriptionAttempts: 0,
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
        transcriptionAttempts: meeting.transcriptionAttempts,
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
    ctx.log.warn("vexa stopBot failed", { meetingId: meeting.id, error: String(e) });
  }
}

/**
 * Removes our record + transcript and asks Vexa to delete its meeting (404-tolerant). Vexa v0.12 only
 * deletes PLANNED rows and answers 409 for anything the bot lifecycle touched — we log that ("retained
 * by capture provider") and still remove our data; purging Vexa's copy is a documented gap.
 */
export async function deleteMeeting(ctx: AppContext, meeting: MeetingRow): Promise<void> {
  if (meeting.vexaPlatform && meeting.vexaNativeMeetingId) {
    if (!isTerminal(meeting.status as MeetingStatus)) await stopInVexa(ctx, meeting);
    try {
      await ctx.vexa.deleteMeeting(meeting.vexaPlatform, meeting.vexaNativeMeetingId);
    } catch (e) {
      if (e instanceof VexaHttpError && e.conflict) {
        ctx.log.warn("vexa retains meeting row (409: bot lifecycle owns it)", { meetingId: meeting.id, vexaNativeMeetingId: meeting.vexaNativeMeetingId });
      } else if (!(e instanceof VexaHttpError && e.notFound)) {
        ctx.log.warn("vexa deleteMeeting failed", { meetingId: meeting.id, error: String(e) });
        throw new ApiError("provider_unavailable", "Could not delete the meeting from the capture provider");
      }
    }
  }
  await ctx.db.delete(meetings).where(eq(meetings.id, meeting.id));
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
    ...(transcript ? transcriptProviderFields(transcript) : {}),
    ...(status === "failed" && m.errorCode
      ? { error: { type: errorTypeFor(m.errorCode as ErrorCode), code: m.errorCode, message: m.errorMessage ?? "" } }
      : {}),
  };
}

/** `transcript_provider` (+ fallback provenance when the configured provider fell back). */
export function transcriptProviderFields(t: TranscriptRow) {
  return {
    transcript_provider: t.provider,
    ...(t.fallbackFrom ? { fallback_from: t.fallbackFrom, fallback_reason: t.fallbackReason } : {}),
  };
}

function transcriptStatus(status: MeetingStatus, hasTranscript: boolean) {
  if (hasTranscript) return "completed";
  if (status === "processing") return "processing";
  if (status === "failed" || status === "cancelled") return "unavailable";
  return "pending";
}

export function serializeTranscript(m: MeetingRow, t: TranscriptRow) {
  const body = t.segmentsJson as { speakers: unknown[]; segments: unknown[]; text: string };
  return {
    meeting_id: m.id,
    status: "completed",
    language: t.language,
    duration_seconds: t.durationSeconds,
    provider: t.provider,
    ...(t.fallbackFrom ? { fallback_from: t.fallbackFrom, fallback_reason: t.fallbackReason } : {}),
    speakers: body.speakers,
    segments: body.segments,
    text: body.text,
    created_at: t.createdAt.toISOString(),
  };
}
