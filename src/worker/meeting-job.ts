import type { AppContext } from "../context.ts";
import type { MeetingRow } from "../db/schema.ts";
import { ApiError } from "../domain/errors.ts";
import type { Platform } from "../domain/platform.ts";
import { isTerminal, mapVexaFailure, mapVexaStatus, type MeetingStatus } from "../domain/state.ts";
import { VexaHttpError } from "../providers/vexa/client.ts";
import { toVexaPlatform } from "../providers/vexa/platform-map.ts";
import type { AudioBlob } from "../providers/transcription/types.ts";
import { failMeeting, getMeetingById, storeTranscript, transition } from "../services/meetings.ts";
import { enqueueMeetingWebhook } from "../webhooks/dispatcher.ts";
import { eq } from "drizzle-orm";
import { meetings } from "../db/schema.ts";

const MAX_START_ATTEMPTS = 3;
const MAX_TRANSCRIPTION_ATTEMPTS = 3;
const TRANSCRIPTION_RETRY_BASE_MS = 30_000;

/** Job: meeting.start — ask Vexa to send a bot. */
export async function handleMeetingStart(ctx: AppContext, meetingId: string, attempt = 1): Promise<void> {
  const meeting = await getMeetingById(ctx, meetingId);
  if (!meeting || meeting.status !== "queued") return;
  const vexaPlatform = toVexaPlatform(meeting.platform as Platform);
  try {
    const created = await ctx.vexa.createBot({
      platform: vexaPlatform,
      native_meeting_id: meeting.vexaNativeMeetingId,
      meeting_url: meeting.meetingUrl,
      bot_name: meeting.botName ?? undefined,
      language: meeting.language ?? undefined,
    });
    const vexaNativeMeetingId = created.native_meeting_id ?? meeting.vexaNativeMeetingId;
    const { meeting: updated, changed } = await transition(ctx, meeting, "joining", {
      vexaPlatform: created.platform ?? vexaPlatform,
      vexaNativeMeetingId,
      vexaBotId: created.bot_container_id ?? String(created.id),
    });
    if (changed) {
      await ctx.queue.push({ type: "meeting.poll", meetingId }, ctx.config.vexa.pollIntervalMs);
    } else if (updated.status === "cancelled" && vexaNativeMeetingId) {
      // Stopped while we were dispatching the bot: don't leave it orphaned in Vexa.
      await ctx.vexa.stopBot(created.platform ?? vexaPlatform, vexaNativeMeetingId).catch(() => {});
    }
  } catch (e) {
    await handleStartError(ctx, meeting, e, attempt);
  }
}

async function handleStartError(ctx: AppContext, meeting: MeetingRow, e: unknown, attempt: number) {
  const retryable = e instanceof ApiError && (e.code === "provider_unavailable" || e.code === "provider_timeout");
  const vexa5xx = e instanceof VexaHttpError && e.status >= 500;
  if ((retryable || vexa5xx) && attempt < MAX_START_ATTEMPTS) {
    ctx.log.warn("vexa createBot failed, retrying", { meetingId: meeting.id, attempt, error: String(e) });
    await ctx.queue.push({ type: "meeting.start", meetingId: meeting.id, attempt: attempt + 1 }, 1_000 * attempt);
    return;
  }
  ctx.log.error("vexa createBot failed", { meetingId: meeting.id, error: String(e), detail: e instanceof VexaHttpError ? e.detail : undefined });
  const code = e instanceof ApiError ? e.code : e instanceof VexaHttpError && e.status === 409 ? "meeting_join_failed" : "provider_unavailable";
  const message =
    code === "meeting_join_failed"
      ? "A bot is already in this meeting or the meeting could not be joined."
      : e instanceof ApiError
        ? e.message
        : "Meeting capture provider is unavailable.";
  const { meeting: failed } = await failMeeting(ctx, meeting, code, message);
  await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
}

/** Job: meeting.poll — sync status from Vexa; finalize when the bot has left. */
export async function handleMeetingPoll(ctx: AppContext, meetingId: string): Promise<void> {
  let meeting = await getMeetingById(ctx, meetingId);
  if (!meeting || isTerminal(meeting.status as MeetingStatus)) return;
  if (!meeting.vexaPlatform || !meeting.vexaNativeMeetingId) return;

  let vexa;
  try {
    vexa = await ctx.vexa.getTranscript(meeting.vexaPlatform, meeting.vexaNativeMeetingId);
  } catch (e) {
    if (e instanceof VexaHttpError && e.notFound) {
      const { meeting: failed } = await failMeeting(ctx, meeting, "capture_failed", "The capture provider lost track of this meeting.");
      await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
      return;
    }
    ctx.log.warn("vexa poll failed; will retry", { meetingId, error: String(e) });
    await ctx.queue.push({ type: "meeting.poll", meetingId }, ctx.config.vexa.pollIntervalMs);
    return;
  }

  const reason = (vexa.data?.completion_reason as string | null | undefined) ?? null;
  const mapped = mapVexaStatus(vexa.status);

  if (mapped === "failed") {
    const f = mapVexaFailure(reason);
    const { meeting: failed } = await failMeeting(ctx, meeting, f.code, f.message);
    await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
    return;
  }

  if (vexa.status !== "completed") {
    const { meeting: updated } = await transition(ctx, meeting, mapped);
    meeting = updated;
    await ctx.queue.push({ type: "meeting.poll", meetingId }, ctx.config.vexa.pollIntervalMs);
    return;
  }

  // Bot has left. A "completed" with a failure-ish reason and no audio is a failure for us.
  if (vexa.segments.length === 0 && reason && reason !== "stopped") {
    const f = mapVexaFailure(reason);
    const { meeting: failed } = await failMeeting(ctx, meeting, f.code, f.message);
    await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
    return;
  }

  ({ meeting } = await transition(ctx, meeting, "processing"));
  await finalize(ctx, meeting, vexa.segments, vexa.id);
}

async function finalize(ctx: AppContext, meeting: MeetingRow, vexaSegments: Parameters<AppContext["transcription"]["transcribe"]>[0]["vexaSegments"], vexaMeetingId: number) {
  try {
    const transcript = await ctx.transcription.transcribe({
      meetingId: meeting.id,
      language: meeting.language,
      vexaSegments,
      fetchAudio: () => fetchVexaAudio(ctx, vexaMeetingId),
    });
    await storeTranscript(ctx, meeting.id, transcript);
    const { meeting: done } = await transition(ctx, meeting, "completed");
    await enqueueMeetingWebhook(ctx, done, "meeting.completed");
  } catch (e) {
    const retryable = e instanceof ApiError && (e.code === "provider_unavailable" || e.code === "provider_timeout");
    const attempts = meeting.transcriptionAttempts + 1;
    if (retryable && attempts < MAX_TRANSCRIPTION_ATTEMPTS) {
      ctx.log.warn("transcription provider unavailable; staying in processing", { meetingId: meeting.id, attempts });
      await ctx.db.update(meetings).set({ transcriptionAttempts: attempts }).where(eq(meetings.id, meeting.id));
      await ctx.queue.push({ type: "meeting.poll", meetingId: meeting.id }, TRANSCRIPTION_RETRY_BASE_MS * attempts);
      return;
    }
    ctx.log.error("transcription failed", { meetingId: meeting.id, error: String(e) });
    const { meeting: failed } = await failMeeting(
      ctx,
      meeting,
      retryable ? "transcription_failed" : e instanceof ApiError ? e.code : "transcription_failed",
      "Transcription could not be completed for this meeting.",
    );
    await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
  }
}

/**
 * GUESS: Vexa /recordings shape is untyped in the frozen contract. Returns null when no audio
 * is persisted, which makes the Tinfoil provider fail with transcription_failed.
 */
async function fetchVexaAudio(ctx: AppContext, vexaMeetingId: number): Promise<AudioBlob | null> {
  try {
    const list = await ctx.vexa.listRecordings(vexaMeetingId);
    for (const rec of list.recordings ?? []) {
      for (const f of rec.media_files ?? []) {
        const url = f.download_url ?? f.url;
        if (!url || (f.content_type && !f.content_type.startsWith("audio/"))) continue;
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) continue;
        return { bytes: new Uint8Array(await res.arrayBuffer()), filename: "meeting.wav", contentType: f.content_type ?? "audio/wav" };
      }
    }
  } catch (e) {
    ctx.log.warn("could not fetch vexa recording", { vexaMeetingId, error: String(e) });
  }
  return null;
}
