import type { AppContext } from "../context.ts";
import type { MeetingRow } from "../db/schema.ts";
import { ApiError } from "../domain/errors.ts";
import type { Platform } from "../domain/platform.ts";
import { isTerminal, mapVexaFailure, mapVexaStatus, type MeetingStatus } from "../domain/state.ts";
import { VexaHttpError } from "../providers/vexa/client.ts";
import { adaptVexaSegments, completionReasonOf } from "../providers/vexa/adapter.ts";
import { validateLegacyVexaTranscriptCoverage } from "../providers/vexa/fallback-coverage.ts";
import type { VexaRecording, VexaTranscriptionResponse } from "../providers/vexa/types.ts";
import { toVexaPlatform } from "../providers/vexa/platform-map.ts";
import {
  TranscriptionFallbackError,
  TranscriptionTransportFenceLost,
  type AudioBlob,
} from "../providers/transcription/types.ts";
import { VexaNativeProvider } from "../providers/transcription/vexa-native.ts";
import { failMeeting, getMeetingById, storeTranscript, transition } from "../services/meetings.ts";
import { enqueueMeetingWebhook } from "../webhooks/dispatcher.ts";
import { and, eq, isNull } from "drizzle-orm";
import { meetings } from "../db/schema.ts";
import { meetingLogFields, protectedCorrelation, safeProviderName } from "../log.ts";
import type { Job } from "./queue.ts";
import { startMeetingFencedCall } from "./meeting-call-fence.ts";

const MAX_START_ATTEMPTS = 3;
const MAX_TRANSCRIPTION_ATTEMPTS = 3;
const TRANSCRIPTION_RETRY_BASE_MS = 30_000;

class LegacyMeetingCallFenceLost extends Error {}

async function startLegacyMeetingCall<T>(
  ctx: AppContext,
  meetingId: string,
  invoke: () => Promise<T>,
): Promise<T> {
  const started = await startMeetingFencedCall(
    ctx.db,
    meetingId,
    async (_tx, meeting) => meeting.activeRecoveryOperationId === null ? true : null,
    invoke,
  );
  if (started.kind !== "started") throw new LegacyMeetingCallFenceLost();
  return started.response;
}

/** Serialize every post-I/O legacy Redis enqueue against the durable delete fence. */
async function pushMeetingJobIfLive(
  ctx: AppContext,
  meetingId: string,
  job: Job,
  delayMs: number,
  transcriptionAttempts?: number,
): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [live] = await tx.select({ id: meetings.id }).from(meetings).where(and(
      eq(meetings.id, meetingId),
      isNull(meetings.deletedAt),
    )).for("update");
    if (!live) return false;
    if (transcriptionAttempts !== undefined) {
      await tx.update(meetings).set({ transcriptionAttempts }).where(eq(meetings.id, meetingId));
    }
    await ctx.queue.push(job, delayMs);
    return true;
  });
}

/** Recovery-v2 owns its finalization in the durable outbox; only initial/legacy rows may enter here. */
export function legacyFinalizerMayHandleMeeting(
  meeting: Pick<MeetingRow, "activeRecoveryOperationId">,
): boolean {
  return meeting.activeRecoveryOperationId === null;
}

/** Job: meeting.start — ask Vexa to send a bot. */
export async function handleMeetingStart(ctx: AppContext, meetingId: string, attempt = 1): Promise<void> {
  const meeting = await getMeetingById(ctx, meetingId);
  if (!meeting || meeting.status !== "queued") return;
  const vexaPlatform = toVexaPlatform(meeting.platform as Platform);
  try {
    const created = await startLegacyMeetingCall(ctx, meeting.id, () => ctx.vexa.createBot({
      platform: vexaPlatform,
      native_meeting_id: meeting.vexaNativeMeetingId,
      meeting_url: meeting.meetingUrl,
      bot_name: meeting.botName ?? undefined,
      language: meeting.language ?? undefined,
      // Vexa otherwise applies its ten-minute deployment fallback. Pin every TinyCloud meeting to
      // our configurable remote-participant audio silence window so both platforms release a bot
      // after the last human leaves.
      automatic_leave: { max_time_left_alone: ctx.config.vexa.maxTimeLeftAloneMs },
      // Batch providers (Tinfoil) transcribe the persisted recording: ask for it explicitly (Vexa's
      // default is true, but a deployment can flip RECORDING_ENABLED off). Do not also run Vexa's
      // live Whisper path: one long Google Meet can otherwise fan out enough abandoned requests to
      // saturate the single CPU worker before the authoritative batch transcription begins.
      ...(needsRecording(ctx) ? { recording_enabled: true, transcribe_enabled: false } : {}),
    }));
    const vexaNativeMeetingId = created.native_meeting_id ?? meeting.vexaNativeMeetingId;
    const { meeting: updated, changed } = await transition(ctx, meeting, "joining", {
      vexaPlatform: created.platform ?? vexaPlatform,
      vexaNativeMeetingId,
      vexaBotId: created.bot_container_id ?? String(created.id),
    });
    if (changed) {
      await pushMeetingJobIfLive(ctx, meetingId, { type: "meeting.poll", meetingId }, ctx.config.vexa.pollIntervalMs);
      // Worker-side join deadline: Vexa's own awaiting_admission timeout is opaque; without this a
      // never-admitted bot leaves the meeting in joining/waiting_for_admission forever.
      await pushMeetingJobIfLive(ctx, meetingId, { type: "meeting.join_deadline", meetingId }, ctx.config.joinTimeoutSeconds * 1000);
    } else if (updated.status === "cancelled" && vexaNativeMeetingId) {
      // Stopped while we were dispatching the bot: don't leave it orphaned in Vexa.
      await startLegacyMeetingCall(
        ctx,
        meeting.id,
        () => ctx.vexa.stopBot(created.platform ?? vexaPlatform, vexaNativeMeetingId),
      ).catch(() => {});
    }
  } catch (e) {
    if (e instanceof LegacyMeetingCallFenceLost) return;
    await handleStartError(ctx, meeting, e, attempt);
  }
}

async function handleStartError(ctx: AppContext, meeting: MeetingRow, e: unknown, attempt: number) {
  const retryable = e instanceof ApiError && (e.code === "provider_unavailable" || e.code === "provider_timeout");
  const vexa5xx = e instanceof VexaHttpError && e.status >= 500;
  if ((retryable || vexa5xx) && attempt < MAX_START_ATTEMPTS) {
    ctx.log.warn("capture_start_retry", {
      ...meetingLogFields(meeting.id),
      attempt,
      errorClass: providerErrorClass(e),
    });
    await pushMeetingJobIfLive(
      ctx,
      meeting.id,
      { type: "meeting.start", meetingId: meeting.id, attempt: attempt + 1 },
      1_000 * attempt,
    );
    return;
  }
  ctx.log.error("capture_start_failed", {
    ...meetingLogFields(meeting.id),
    errorClass: providerErrorClass(e),
  });
  const code = e instanceof ApiError ? e.code : e instanceof VexaHttpError && e.status === 409 ? "meeting_join_failed" : "provider_unavailable";
  const message =
    code === "meeting_join_failed"
      ? "A bot is already in this meeting or the meeting could not be joined."
      : e instanceof ApiError
        ? e.message
        : "Meeting capture provider is unavailable.";
  const { meeting: failed, changed } = await failMeeting(ctx, meeting, code, message);
  if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
}

/**
 * Job: meeting.join_deadline — fires JOIN_TIMEOUT_SECONDS after the bot was dispatched. A meeting
 * still not admitted by then is failed (waiting_room_timeout when it reached the waiting room,
 * meeting_join_failed otherwise), its Vexa bot is stopped, and meeting.failed is emitted.
 */
export async function handleJoinDeadline(ctx: AppContext, meetingId: string): Promise<void> {
  const meeting = await getMeetingById(ctx, meetingId);
  if (!meeting) return;
  const status = meeting.status as MeetingStatus;
  if (status !== "joining" && status !== "waiting_for_admission") return;
  ctx.log.warn("join_deadline_exceeded", {
    ...meetingLogFields(meetingId),
    status,
    joinTimeoutSeconds: ctx.config.joinTimeoutSeconds,
  });
  if (meeting.vexaPlatform && meeting.vexaNativeMeetingId) {
    await startLegacyMeetingCall(
      ctx,
      meeting.id,
      () => ctx.vexa.stopBot(meeting.vexaPlatform!, meeting.vexaNativeMeetingId!),
    ).catch((error) => {
      if (error instanceof LegacyMeetingCallFenceLost) return;
      if (!(error instanceof VexaHttpError && error.notFound)) {
        ctx.log.warn("capture_stop_failed_at_join_deadline", {
          ...meetingLogFields(meetingId),
          errorClass: providerErrorClass(error),
        });
      }
    });
  }
  const f =
    status === "waiting_for_admission"
      ? { code: "waiting_room_timeout" as const, message: "The bot was not admitted to the meeting in time." }
      : { code: "meeting_join_failed" as const, message: "The bot could not join the meeting in time." };
  const { meeting: failed, changed } = await failMeeting(ctx, meeting, f.code, f.message);
  if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
}

/** Job: meeting.poll — sync status from Vexa; finalize when the bot has left. */
export async function handleMeetingPoll(ctx: AppContext, meetingId: string): Promise<void> {
  let meeting = await getMeetingById(ctx, meetingId);
  if (!meeting || isTerminal(meeting.status as MeetingStatus)) return;
  if (!legacyFinalizerMayHandleMeeting(meeting)) return;
  if (!meeting.vexaPlatform || !meeting.vexaNativeMeetingId) return;
  const vexaPlatform = meeting.vexaPlatform;
  const vexaNativeMeetingId = meeting.vexaNativeMeetingId;

  let vexa;
  try {
    vexa = await startLegacyMeetingCall(
      ctx,
      meeting.id,
      () => ctx.vexa.getTranscript(vexaPlatform, vexaNativeMeetingId),
    );
  } catch (e) {
    if (e instanceof LegacyMeetingCallFenceLost) return;
    if (e instanceof VexaHttpError && e.notFound) {
      const { meeting: failed, changed } = await failMeeting(ctx, meeting, "capture_failed", "The capture provider lost track of this meeting.");
      if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
      return;
    }
    ctx.log.warn("capture_poll_retry", {
      ...meetingLogFields(meetingId),
      errorClass: providerErrorClass(e),
    });
    await pushMeetingJobIfLive(ctx, meetingId, { type: "meeting.poll", meetingId }, ctx.config.vexa.pollIntervalMs);
    return;
  }

  // completion_reason lives under `data` on transcript rows (top-level only on MeetingResponse rows).
  const reason = completionReasonOf(vexa);
  const mapped = mapVexaStatus(vexa.status);

  if (vexa.status !== "completed" && mapped !== "failed") {
    const { meeting: updated } = await transition(ctx, meeting, mapped);
    meeting = updated;
    await pushMeetingJobIfLive(ctx, meetingId, { type: "meeting.poll", meetingId }, ctx.config.vexa.pollIntervalMs);
    return;
  }

  // A terminal bot state describes how capture ended, not whether all captured media was lost. In
  // particular, left_alone/evicted/failed can retain a complete recording. Always salvage that
  // recording before deciding this meeting failed.
  const segments = adaptVexaSegments(vexa); // deduped by turn, epoch → meeting-relative seconds
  const hasLiveWords = segments.some((segment) => segment.text.trim().length > 0);
  const lifecycleDuration = vexa.start_time && vexa.end_time
    ? (Date.parse(vexa.end_time) - Date.parse(vexa.start_time)) / 1_000
    : 0;
  const finalizedDurationSec = Math.max(
    Number.isFinite(lifecycleDuration) && lifecycleDuration > 0 ? lifecycleDuration : 0,
    ...segments.map((segment) => segment.end),
  );
  const currentMeetingId = meeting.id;
  let cachedAudio: AudioBlob | null | undefined;
  const fetchAudio = async () => {
    if (cachedAudio !== undefined) return cachedAudio;
    ctx.log.debug("capture_recording_fetch_started", meetingLogFields(currentMeetingId));
    cachedAudio = await fetchVexaAudio(ctx, currentMeetingId, vexa);
    if (cachedAudio) {
      ctx.log.debug("capture_recording_fetch_completed", {
        ...meetingLogFields(currentMeetingId),
        bytes: cachedAudio.bytes.length,
        mediaClass: cachedAudio.contentType.startsWith("audio/") ? "audio" : "other",
      });
    }
    return cachedAudio;
  };

  // With no live segments, a batch provider needs a usable recording to produce anything. This
  // preflight also prevents the old fallback path from storing an empty "completed" transcript.
  let usableAudio = true;
  if (!hasLiveWords && needsRecording(ctx)) {
    try {
      usableAudio = !!(await fetchAudio());
    } catch (error) {
      if (error instanceof LegacyMeetingCallFenceLost) return;
      const failure = mapRecordingFetchError(error);
      const attempts = meeting.transcriptionAttempts + 1;
      if (failure.retryable && attempts < MAX_TRANSCRIPTION_ATTEMPTS) {
        ctx.log.warn("capture_recording_retry", {
          ...meetingLogFields(meetingId),
          attempts,
          errorClass: providerErrorClass(error),
        });
        await pushMeetingJobIfLive(
          ctx,
          meetingId,
          { type: "meeting.poll", meetingId },
          TRANSCRIPTION_RETRY_BASE_MS * attempts,
          attempts,
        );
        return;
      }
      ctx.log.error("capture_recording_failed", {
        ...meetingLogFields(meetingId),
        attempts,
        errorClass: providerErrorClass(error),
      });
      const { meeting: failed, changed } = await failMeeting(ctx, meeting, failure.code, failure.message);
      if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
      return;
    }
  }
  if (!hasLiveWords && (!needsRecording(ctx) || !usableAudio)) {
    const f = needsRecording(ctx)
      ? { code: "recording_absent" as const, message: "No retained recording is available for transcription." }
      : reason
        ? mapVexaFailure(reason)
        : { code: "capture_failed" as const, message: "No usable audio was captured for this meeting." };
    const { meeting: failed, changed } = await failMeeting(ctx, meeting, f.code, f.message);
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
    return;
  }

  ({ meeting } = await transition(ctx, meeting, "processing"));
  ctx.log.debug("meeting_finalization_started", {
    ...meetingLogFields(meeting.id),
    vexaSegments: segments.length,
    recordings: vexa.recordings?.length ?? 0,
  });
  await finalize(ctx, meeting, segments, finalizedDurationSec, fetchAudio);
}

/** True for providers that transcribe persisted audio (anything but the WhisperLive passthrough). */
const needsRecording = (ctx: AppContext) => ctx.transcription.name !== "vexa";

function mapRecordingFetchError(error: unknown): {
  code: "recording_absent" | "recording_fetch_transient" | "recording_undecodable" | "recording_silent" | "transcription_failed";
  message: string;
  retryable: boolean;
} {
  if (error instanceof VexaHttpError) {
    if (error.notFound) {
      return { code: "recording_absent", message: "No retained recording is available for transcription.", retryable: false };
    }
    if (error.status === 429 || error.status >= 500) {
      return { code: "recording_fetch_transient", message: "The retained recording is temporarily unavailable.", retryable: true };
    }
    return { code: "transcription_failed", message: "The retained meeting audio could not be loaded for transcription.", retryable: false };
  }
  if (error instanceof ApiError) {
    if (error.code === "provider_unavailable" || error.code === "provider_timeout" || error.code === "recording_fetch_transient") {
      return { code: "recording_fetch_transient", message: "The retained recording is temporarily unavailable.", retryable: true };
    }
    if (error.code === "recording_absent") {
      return { code: "recording_absent", message: "No retained recording is available for transcription.", retryable: false };
    }
    if (error.code === "recording_undecodable") {
      return { code: "recording_undecodable", message: "The retained recording could not be decoded.", retryable: false };
    }
    if (error.code === "recording_silent") {
      return { code: "recording_silent", message: "The retained recording contains no usable audio.", retryable: false };
    }
  }
  return { code: "transcription_failed", message: "The retained meeting audio could not be loaded for transcription.", retryable: false };
}

const isRetryableTranscriptionError = (error: unknown) =>
  error instanceof ApiError &&
  (error.code === "provider_unavailable" || error.code === "provider_timeout" || error.code === "recording_fetch_transient");

async function finalize(
  ctx: AppContext,
  meeting: MeetingRow,
  vexaSegments: ReturnType<typeof adaptVexaSegments>,
  finalizedDurationSec: number,
  fetchAudio: () => Promise<AudioBlob | null>,
) {
  const primary = ctx.transcription.name;
  let audioMissing = false;
  const input = {
    meetingId: meeting.id,
    language: meeting.language,
    vexaSegments,
    fetchAudio: async () => {
      try {
        const audio = await fetchAudio();
        if (!audio) audioMissing = true;
        return audio;
      } catch (error) {
        const failure = mapRecordingFetchError(error);
        throw new ApiError(failure.code, failure.message);
      }
    },
    startTransportAttempt: async <T>(invoke: () => Promise<T>) => {
      const started = await startMeetingFencedCall(
        ctx.db,
        meeting.id,
        async (_tx, live) => live.activeRecoveryOperationId === null ? true : null,
        invoke,
      );
      if (started.kind !== "started") throw new TranscriptionTransportFenceLost();
      return { response: started.response };
    },
  };
  const ownPositiveNumber = (value: unknown, key: string): number | null => {
    if (!value || typeof value !== "object") return null;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && "value" in descriptor && typeof descriptor.value === "number"
        && Number.isFinite(descriptor.value) && descriptor.value > 0
        ? descriptor.value
        : null;
    } catch {
      return null;
    }
  };
  const ownPositiveInteger = (value: unknown, key: string): number | null => {
    const number = ownPositiveNumber(value, key);
    return number !== null && Number.isSafeInteger(number) ? number : null;
  };
  const ceilingMilliseconds = (seconds: number): number | null => {
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const value = Math.ceil(seconds * 1_000);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  const canFallback = (error: unknown) => {
    const stats = Object.getOwnPropertyDescriptor(ctx.transcription, "lastStats")?.value;
    const detail = error instanceof TranscriptionFallbackError
      ? Object.getOwnPropertyDescriptor(error, "detail")?.value
      : null;
    const providerDurationMs = ownPositiveInteger(stats, "audio_duration_ms")
      ?? ceilingMilliseconds(ownPositiveNumber(stats, "audio_seconds") ?? 0);
    const failureDurationMs = ownPositiveInteger(detail, "audio_duration_ms")
      ?? ceilingMilliseconds(ownPositiveNumber(detail, "audio_seconds") ?? 0);
    const actualDurationMs = Math.max(
      ceilingMilliseconds(finalizedDurationSec) ?? 0,
      providerDurationMs ?? 0,
      failureDurationMs ?? 0,
    );
    return needsRecording(ctx)
      && validateLegacyVexaTranscriptCoverage(vexaSegments, actualDurationMs / 1_000).kind === "accepted";
  };
  let fallbackInfo: { from: string; reason: string } | null = null;
  const fallback = async (reason: string, error: unknown) => {
    ctx.log.warn("falling back to vexa-native transcript", {
      ...meetingLogFields(meeting.id),
      provider: safeProviderName(primary),
      reason: safeFallbackReason(reason),
      errorClass: providerErrorClass(error),
    });
    const transcript = await startLegacyMeetingCall(
      ctx,
      meeting.id,
      () => new VexaNativeProvider().transcribe(input),
    );
    transcript.segments = transcript.segments.map((segment) => ({ ...segment, provenance: "vexa_fallback" as const }));
    fallbackInfo = { from: primary, reason };
    ctx.log.info("transcript finalized", {
      ...meetingLogFields(meeting.id),
      provider: "vexa",
      fallback_from: safeProviderName(primary),
      fallback_reason: safeFallbackReason(reason),
      segments: transcript.segments.length,
    });
    return transcript;
  };
  try {
    let transcript;
    let provider = primary;
    try {
      // Preserve the legacy orchestration handoff for provider-neutral ordering. Concrete batch
      // transports still reacquire the authoritative fence through input.startTransportAttempt at
      // every paid/network attempt; this wrapper cannot authorize later chunks or retries.
      transcript = await startLegacyMeetingCall(ctx, meeting.id, () => ctx.transcription.transcribe(input));
      const stats = safeProviderStats((ctx.transcription as { lastStats?: Record<string, unknown> }).lastStats);
      ctx.log.info("transcript finalized", {
        ...meetingLogFields(meeting.id),
        provider: safeProviderName(provider),
        segments: transcript.segments.length,
        ...(stats ? { stats } : {}),
      });
    } catch (e) {
      const retryable = isRetryableTranscriptionError(e);
      const attempts = meeting.transcriptionAttempts + 1;
      if (retryable && attempts < MAX_TRANSCRIPTION_ATTEMPTS) throw e; // retried below
      if (!canFallback(e)) {
        if (needsRecording(ctx) && vexaSegments.some((segment) => segment.text.trim().length > 0)
          && (audioMissing || retryable || e instanceof TranscriptionFallbackError)) {
          throw new ApiError("coverage_incomplete", "Complete fallback coverage is unavailable");
        }
        throw e;
      }
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
    if (!transcript.text.trim()) {
      throw new ApiError("transcription_failed", "Transcription provider returned no words");
    }
    await storeTranscript(ctx, meeting.id, transcript, provider, fallbackInfo);
    const { meeting: done, changed } = await transition(ctx, meeting, "completed");
    if (changed) await enqueueMeetingWebhook(ctx, done, "meeting.completed");
  } catch (e) {
    if (e instanceof LegacyMeetingCallFenceLost || e instanceof TranscriptionTransportFenceLost) return;
    const retryable = isRetryableTranscriptionError(e);
    const attempts = meeting.transcriptionAttempts + 1;
    if (retryable && attempts < MAX_TRANSCRIPTION_ATTEMPTS) {
      ctx.log.warn("transcription_retry_scheduled", {
        ...meetingLogFields(meeting.id),
        attempts,
        errorClass: providerErrorClass(e),
      });
      await pushMeetingJobIfLive(
        ctx,
        meeting.id,
        { type: "meeting.poll", meetingId: meeting.id },
        TRANSCRIPTION_RETRY_BASE_MS * attempts,
        attempts,
      );
      return;
    }
    ctx.log.error("transcription_failed", {
      ...meetingLogFields(meeting.id),
      errorClass: providerErrorClass(e),
    });
    const terminalCode = retryable
      ? (e as ApiError).code
      : e instanceof ApiError
        ? e.code
        : e instanceof TranscriptionFallbackError && e.reason === "undecodable"
          ? "recording_undecodable"
          : e instanceof TranscriptionFallbackError && e.reason === "silent_recording"
            ? "recording_silent"
            : "transcription_failed";
    const { meeting: failed, changed } = await failMeeting(
      ctx,
      meeting,
      terminalCode,
      "Transcription could not be completed for this meeting.",
    );
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
  }
}

/** Below this the opus master is almost certainly silence (run 1 of the capture rig: 9 KB / 38 s ≈ 240 B/s; real speech ≈ 5 KB/s). */
const MIN_AUDIO_BYTES_PER_SECOND = 1000;

/**
 * Persisted meeting audio for the Tinfoil batch path (`recording_enabled` default true): the recording
 * list comes with the transcript row (`recordings[]`, else GET /recordings filtered by meeting_id),
 * `GET /recordings/{id}/master?type=audio` assembles master.webm, `raw_url` streams the bytes.
 * Returns null when no recording is persisted. A recording that is present but below the bounded
 * audio sanity threshold is classified separately as recording_silent.
 * Content sanity check: a master far below speech bitrate is treated as the known "silent tap" failure
 * (docs/vexa-findings.md) rather than sent to Tinfoil.
 */
async function fetchVexaAudio(
  ctx: AppContext,
  meetingId: string,
  vexa: VexaTranscriptionResponse,
): Promise<AudioBlob | null> {
  let recordings: VexaRecording[] = (vexa.recordings ?? []).filter((r) => r.meeting_id === vexa.id);
  if (recordings.length === 0) {
    recordings = (await startLegacyMeetingCall(ctx, meetingId, () => ctx.vexa.listRecordings()))
      .recordings.filter((r) => r.meeting_id === vexa.id);
  }
  const durationSec =
    vexa.start_time && vexa.end_time ? (Date.parse(vexa.end_time) - Date.parse(vexa.start_time)) / 1000 : null;
  let sawSilentRecording = false;
  for (const rec of recordings) {
    if (!rec.media_files?.some((f) => f.type === "audio")) continue;
    const master = await startLegacyMeetingCall(ctx, meetingId, () => ctx.vexa.recordingMaster(rec.id, "audio"));
    if (!master.raw_url) continue;
    const { bytes, contentType } = await startLegacyMeetingCall(ctx, meetingId, () => ctx.vexa.fetchBytes(master.raw_url!));
    if (bytes.length === 0) continue;
    if (durationSec && durationSec > 5 && bytes.length / durationSec < MIN_AUDIO_BYTES_PER_SECOND) {
      sawSilentRecording = true;
      ctx.log.warn("capture_recording_silent", {
        recordingCorrelation: protectedCorrelation("recording", rec.id),
        providerMeetingCorrelation: protectedCorrelation("recording", vexa.id),
        bytes: bytes.length,
        durationSec,
      });
      continue;
    }
    return { bytes, filename: "meeting.webm", contentType: contentType.startsWith("audio/") ? contentType : "audio/webm" };
  }
  if (sawSilentRecording) throw new ApiError("recording_silent", "The retained recording contains no usable audio");
  return null;
}

function providerErrorClass(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  if (error instanceof VexaHttpError) return "capture_http_error";
  if (error instanceof TranscriptionFallbackError) return "transcription_fallback";
  return "operation_failed";
}

const SAFE_FALLBACK_REASONS = new Set([
  "no_usable_recording",
  "undecodable",
  "silent_recording",
  "turns_failed",
  "no_turns",
  "provider_unavailable_after_retries",
]);

const safeFallbackReason = (reason: string): string => SAFE_FALLBACK_REASONS.has(reason) ? reason : "provider_failure";

const SAFE_STAT_KEYS = ["audio_seconds", "audio_duration_ms", "turns", "transcribed", "skipped_short", "failed", "calls"] as const;

function safeProviderStats(value: Record<string, unknown> | null | undefined): Record<string, string | number> | null {
  if (!value || typeof value !== "object") return null;
  const stats: Record<string, string | number> = {};
  if (value.mode === "turns" || value.mode === "whole") stats.mode = value.mode;
  for (const key of SAFE_STAT_KEYS) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) stats[key] = candidate;
  }
  return Object.keys(stats).length > 0 ? stats : null;
}
