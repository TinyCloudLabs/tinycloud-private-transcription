import type { AppContext } from "../context.ts";
import type { MeetingRow } from "../db/schema.ts";
import { ApiError } from "../domain/errors.ts";
import type { Platform } from "../domain/platform.ts";
import { isTerminal, mapVexaFailure, mapVexaStatus, type MeetingStatus } from "../domain/state.ts";
import { VexaHttpError } from "../providers/vexa/client.ts";
import { adaptVexaSegments, completionReasonOf } from "../providers/vexa/adapter.ts";
import { toVexaPlatform } from "../providers/vexa/platform-map.ts";
import { failMeeting, getMeetingById, storeTranscript, transition } from "../services/meetings.ts";
import { enqueueMeetingWebhook } from "../webhooks/dispatcher.ts";
import { observeCapture, recordCapture } from "../services/capture.ts";

const MAX_START_ATTEMPTS = 3;

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
      // Vexa performs transcription, including when its deployment is configured to use Tinfoil.
      // TinyCloud persists the completed Vexa segments and never re-transcribes a recording.
      transcribe_enabled: true,
      // Vexa otherwise applies its ten-minute deployment fallback. Pin every TinyCloud meeting to
      // our configurable audio-silence window. This can expire with humans still connected;
      // participant presence does not veto Vexa's silence verdict.
      automatic_leave: { max_time_left_alone: ctx.config.vexa.maxTimeLeftAloneMs },
    });
    const vexaNativeMeetingId = created.native_meeting_id ?? meeting.vexaNativeMeetingId;
    const dispatched = await recordCapture(ctx, meeting, {
      silence_timeout_ms: ctx.config.vexa.maxTimeLeftAloneMs,
      live_transcription_requested: true,
    });
    const { meeting: updated, changed } = await transition(ctx, dispatched, "joining", {
      vexaPlatform: created.platform ?? vexaPlatform,
      vexaNativeMeetingId,
      vexaBotId: created.bot_container_id ?? String(created.id),
    });
    if (changed) {
      ctx.log.info("bot dispatched", { meetingId, botId: updated.vexaBotId, vexaMeetingId: created.id, platform: meeting.platform, provider: ctx.transcription.name, ...updated.captureDiagnostics });
      await ctx.queue.push({ type: "meeting.poll", meetingId }, ctx.config.vexa.pollIntervalMs);
      // Worker-side join deadline: Vexa's own awaiting_admission timeout is opaque; without this a
      // never-admitted bot leaves the meeting in joining/waiting_for_admission forever.
      await ctx.queue.push({ type: "meeting.join_deadline", meetingId }, ctx.config.joinTimeoutSeconds * 1000);
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

/**
 * Job: meeting.join_deadline — fires JOIN_TIMEOUT_SECONDS after the bot was dispatched. A meeting
 * still not admitted by then is failed (waiting_room_timeout when it reached the waiting room,
 * meeting_join_failed otherwise), its Vexa bot is stopped, and meeting.failed is emitted.
 */
export async function handleJoinDeadline(ctx: AppContext, meetingId: string): Promise<void> {
  let meeting = await getMeetingById(ctx, meetingId);
  if (!meeting) return;
  const status = meeting.status as MeetingStatus;
  if (status !== "joining" && status !== "waiting_for_admission") return;
  meeting = await recordCapture(ctx, meeting, { stop_requested_at: new Date().toISOString(), stop_requested_by: "join_deadline" });
  ctx.log.warn("join deadline exceeded; failing meeting", { meetingId, status, joinTimeoutSeconds: ctx.config.joinTimeoutSeconds });
  if (meeting.vexaPlatform && meeting.vexaNativeMeetingId) {
    await ctx.vexa.stopBot(meeting.vexaPlatform, meeting.vexaNativeMeetingId).catch((e) => {
      if (!(e instanceof VexaHttpError && e.notFound)) ctx.log.warn("vexa stopBot failed at join deadline", { meetingId, error: String(e) });
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
  if (!meeting.vexaPlatform || !meeting.vexaNativeMeetingId) return;

  let vexa;
  try {
    vexa = await ctx.vexa.getTranscript(meeting.vexaPlatform, meeting.vexaNativeMeetingId);
  } catch (e) {
    if (e instanceof VexaHttpError && e.notFound) {
      meeting = await recordCapture(ctx, meeting, { provider_record_missing_at: new Date().toISOString() });
      ctx.log.warn("capture provider record missing", { meetingId, botId: meeting.vexaBotId });
      const { meeting: failed } = await failMeeting(ctx, meeting, "capture_failed", "The capture provider lost track of this meeting.");
      await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
      return;
    }
    ctx.log.warn("vexa poll failed; will retry", { meetingId, error: String(e) });
    await ctx.queue.push({ type: "meeting.poll", meetingId }, ctx.config.vexa.pollIntervalMs);
    return;
  }

  meeting = await observeCapture(ctx, meeting, vexa);

  // completion_reason lives under `data` on transcript rows (top-level only on MeetingResponse rows).
  const reason = completionReasonOf(vexa);
  const mapped = mapVexaStatus(vexa.status);

  if (vexa.status !== "completed" && mapped !== "failed") {
    const { meeting: updated } = await transition(ctx, meeting, mapped);
    meeting = updated;
    await ctx.queue.push({ type: "meeting.poll", meetingId }, ctx.config.vexa.pollIntervalMs);
    return;
  }

  // Vexa owns the STT windows and speaker attribution. Private transcription only normalizes and
  // persists Vexa's completed segments; it must never re-fetch or re-transcribe recordings.
  let segments: ReturnType<typeof adaptVexaSegments>;
  try {
    segments = adaptVexaSegments(vexa); // deduped by turn, epoch → meeting-relative seconds
  } catch (e) {
    // A malformed Vexa transcript has to end the meeting here. The worker loop logs and drops a
    // thrown job without re-queueing it, so letting this escape would strand the meeting in a
    // non-terminal state with no webhook, forever.
    ctx.log.error("vexa returned an invalid transcript", { meetingId, error: String(e) });
    const { meeting: failed, changed } = await failMeeting(ctx, meeting, "transcription_failed", "The capture provider returned an invalid transcript.");
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
    return;
  }
  const hasLiveWords = segments.some((segment) => segment.text.trim().length > 0);
  if (!hasLiveWords) {
    const f = reason ? mapVexaFailure(reason) : { code: "capture_failed" as const, message: "No usable audio was captured for this meeting." };
    const { meeting: failed, changed } = await failMeeting(ctx, meeting, f.code, f.message);
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
    return;
  }

  ({ meeting } = await transition(ctx, meeting, "processing"));
  ctx.log.debug("vexa meeting completed; finalizing", { meetingId: meeting.id, vexaSegments: segments.length });
  await finalize(ctx, meeting, segments);
}

async function finalize(
  ctx: AppContext,
  meeting: MeetingRow,
  vexaSegments: ReturnType<typeof adaptVexaSegments>,
) {
  const input = {
    meetingId: meeting.id,
    language: meeting.language,
    vexaSegments,
  };
  try {
    const transcript = await ctx.transcription.transcribe(input);
    if (!transcript.text.trim()) {
      throw new ApiError("transcription_failed", "Transcription provider returned no words");
    }
    await storeTranscript(ctx, meeting.id, transcript, "vexa");
    const { meeting: done, changed } = await transition(ctx, meeting, "completed");
    if (changed) await enqueueMeetingWebhook(ctx, done, "meeting.completed");
  } catch (e) {
    ctx.log.error("transcription failed", { meetingId: meeting.id, error: String(e) });
    const { meeting: failed, changed } = await failMeeting(
      ctx,
      meeting,
      e instanceof ApiError ? e.code : "transcription_failed",
      "Transcription could not be completed for this meeting.",
    );
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
  }
}
