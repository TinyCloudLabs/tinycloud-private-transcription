import type { AppContext } from "../context.ts";
import type { MeetingRow } from "../db/schema.ts";
import { ApiError } from "../domain/errors.ts";
import type { Platform } from "../domain/platform.ts";
import { isTerminal, mapVexaFailure, mapVexaStatus, type MeetingStatus } from "../domain/state.ts";
import { VexaHttpError } from "../providers/vexa/client.ts";
import { adaptVexaSegments, completionReasonOf } from "../providers/vexa/adapter.ts";
import type { VexaRecording, VexaTranscriptionResponse } from "../providers/vexa/types.ts";
import { toVexaPlatform } from "../providers/vexa/platform-map.ts";
import { TranscriptionFallbackError, type AudioBlob } from "../providers/transcription/types.ts";
import { VexaNativeProvider } from "../providers/transcription/vexa-native.ts";
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
      // Batch providers (Tinfoil) transcribe the persisted recording: ask for it explicitly (Vexa's
      // default is true, but a deployment can flip RECORDING_ENABLED off).
      ...(needsRecording(ctx) ? { recording_enabled: true } : {}),
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

  // completion_reason lives under `data` on transcript rows (top-level only on MeetingResponse rows).
  const reason = completionReasonOf(vexa);
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
  const segments = adaptVexaSegments(vexa); // deduped by turn, epoch → meeting-relative seconds
  if (segments.length === 0 && reason && reason !== "stopped") {
    const f = mapVexaFailure(reason);
    const { meeting: failed } = await failMeeting(ctx, meeting, f.code, f.message);
    await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
    return;
  }

  ({ meeting } = await transition(ctx, meeting, "processing"));
  await finalize(ctx, meeting, vexa, segments);
}

/** True for providers that transcribe persisted audio (anything but the WhisperLive passthrough). */
const needsRecording = (ctx: AppContext) => ctx.transcription.name !== "vexa";

async function finalize(ctx: AppContext, meeting: MeetingRow, vexa: VexaTranscriptionResponse, vexaSegments: ReturnType<typeof adaptVexaSegments>) {
  const primary = ctx.transcription.name;
  let audioMissing = false;
  const input = {
    meetingId: meeting.id,
    language: meeting.language,
    vexaSegments,
    fetchAudio: async () => {
      const audio = await fetchVexaAudio(ctx, vexa);
      if (!audio) audioMissing = true;
      return audio;
    },
  };
  // Vexa's live segments are always a valid transcript: a batch provider that cannot run (no/silent
  // recording, most turns failed, provider outage after our retries) degrades to them instead of failing.
  const canFallback = () => needsRecording(ctx) && vexaSegments.length > 0;
  const fallback = async (reason: string, error: unknown) => {
    ctx.log.warn("falling back to vexa-native transcript", { meetingId: meeting.id, provider: primary, reason, error: String(error) });
    const transcript = await new VexaNativeProvider().transcribe(input);
    ctx.log.info("transcript finalized", { meetingId: meeting.id, provider: "vexa", fallback_from: primary, fallback_reason: reason, segments: transcript.segments.length });
    return transcript;
  };
  try {
    let transcript;
    let provider = primary;
    try {
      transcript = await ctx.transcription.transcribe(input);
      const stats = (ctx.transcription as { lastStats?: Record<string, unknown> }).lastStats;
      ctx.log.info("transcript finalized", { meetingId: meeting.id, provider, segments: transcript.segments.length, ...(stats ? { stats } : {}) });
    } catch (e) {
      const retryable = e instanceof ApiError && (e.code === "provider_unavailable" || e.code === "provider_timeout");
      const attempts = meeting.transcriptionAttempts + 1;
      if (retryable && attempts < MAX_TRANSCRIPTION_ATTEMPTS) throw e; // retried below
      if (!canFallback()) throw e;
      if (audioMissing) {
        transcript = await fallback("no_usable_recording", e);
      } else if (e instanceof TranscriptionFallbackError) {
        transcript = await fallback(e.reason, e);
      } else if (retryable) {
        transcript = await fallback("provider_unavailable_after_retries", e);
      } else {
        throw e;
      }
      provider = "vexa";
    }
    await storeTranscript(ctx, meeting.id, transcript, provider);
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

/** Below this the opus master is almost certainly silence (run 1 of the capture rig: 9 KB / 38 s ≈ 240 B/s; real speech ≈ 5 KB/s). */
const MIN_AUDIO_BYTES_PER_SECOND = 1000;

/**
 * Persisted meeting audio for the Tinfoil batch path (`recording_enabled` default true): the recording
 * list comes with the transcript row (`recordings[]`, else GET /recordings filtered by meeting_id),
 * `GET /recordings/{id}/master?type=audio` assembles master.webm, `raw_url` streams the bytes.
 * Returns null when nothing usable is persisted (Tinfoil provider then fails with transcription_failed).
 * Content sanity check: a master far below speech bitrate is treated as the known "silent tap" failure
 * (docs/vexa-findings.md) rather than sent to Tinfoil.
 */
async function fetchVexaAudio(ctx: AppContext, vexa: VexaTranscriptionResponse): Promise<AudioBlob | null> {
  try {
    let recordings: VexaRecording[] = (vexa.recordings ?? []).filter((r) => r.meeting_id === vexa.id);
    if (recordings.length === 0) {
      recordings = (await ctx.vexa.listRecordings()).recordings.filter((r) => r.meeting_id === vexa.id);
    }
    const durationSec =
      vexa.start_time && vexa.end_time ? (Date.parse(vexa.end_time) - Date.parse(vexa.start_time)) / 1000 : null;
    for (const rec of recordings) {
      if (!rec.media_files?.some((f) => f.type === "audio")) continue;
      const master = await ctx.vexa.recordingMaster(rec.id, "audio");
      if (!master.raw_url) continue;
      const { bytes, contentType } = await ctx.vexa.fetchBytes(master.raw_url);
      if (bytes.length === 0) continue;
      if (durationSec && durationSec > 5 && bytes.length / durationSec < MIN_AUDIO_BYTES_PER_SECOND) {
        ctx.log.warn("vexa recording looks silent; skipping", { vexaMeetingId: vexa.id, recordingId: rec.id, bytes: bytes.length, durationSec });
        continue;
      }
      return { bytes, filename: "meeting.webm", contentType: contentType.startsWith("audio/") ? contentType : "audio/webm" };
    }
  } catch (e) {
    ctx.log.warn("could not fetch vexa recording", { vexaMeetingId: vexa.id, error: String(e) });
  }
  return null;
}
