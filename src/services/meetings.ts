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

export async function storeTranscript(ctx: AppContext, meetingId: string, t: NormalizedTranscript) {
  await ctx.db
    .insert(transcripts)
    .values({
      meetingId,
      language: t.language,
      durationSeconds: t.duration_seconds,
      segmentsJson: { speakers: t.speakers, segments: t.segments, text: t.text },
    })
    .onConflictDoUpdate({
      target: transcripts.meetingId,
      set: { language: t.language, durationSeconds: t.duration_seconds, segmentsJson: { speakers: t.speakers, segments: t.segments, text: t.text } },
    });
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
    ...(status === "failed" && m.errorCode
      ? { error: { type: errorTypeFor(m.errorCode as ErrorCode), code: m.errorCode, message: m.errorMessage ?? "" } }
      : {}),
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
    speakers: body.speakers,
    segments: body.segments,
    text: body.text,
    created_at: t.createdAt.toISOString(),
  };
}
