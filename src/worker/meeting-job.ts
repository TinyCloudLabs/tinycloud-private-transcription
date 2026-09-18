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
import { and, eq, isNull, sql } from "drizzle-orm";
import { meetings } from "../db/schema.ts";
import { normalizeSegments } from "../domain/transcript.ts";
import { openSignalCapability } from "../providers/signal/capability.ts";
import type { VexaTranscriptionResponse } from "../providers/vexa/types.ts";

const MAX_START_ATTEMPTS = 3;

/** Job: meeting.start — ask Vexa to send a bot. */
export async function handleMeetingStart(ctx: AppContext, meetingId: string, attempt = 1): Promise<void> {
  const meeting = await getMeetingById(ctx, meetingId);
  if (!meeting || meeting.status !== "queued") return;
  if (meeting.platform === "signal") return handleSignalStart(ctx, meeting, attempt);
  const vexaPlatform = toVexaPlatform(meeting.platform as Exclude<Platform, "signal">);
  try {
    const created = await ctx.vexa.createBot({
      platform: vexaPlatform,
      native_meeting_id: meeting.vexaNativeMeetingId,
      meeting_url: meeting.meetingUrl,
      bot_name: meeting.botName ?? undefined,
      language: meeting.language ?? undefined,
      // Vexa remains the primary transcription provider.
      transcribe_enabled: true,
      // Retain audio only on deployments which have the recovery provider configured.
      ...(ctx.transcriptRecovery ? { recording_enabled: true } : {}),
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
  if (meeting.platform === "signal" && meeting.signalSessionId) {
    await ctx.signal.leave(meeting.signalSessionId).catch(() => {});
  } else if (meeting.vexaPlatform && meeting.vexaNativeMeetingId) {
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
  if (meeting.platform === "signal") return handleSignalPoll(ctx, meeting);
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

  if (mapped === "failed") {
    const f = mapVexaFailure(reason);
    const { meeting: failed, changed } = await failMeeting(ctx, meeting, f.code, f.message);
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
    return;
  }

  if (vexa.status !== "completed") {
    const { meeting: updated } = await transition(ctx, meeting, mapped);
    meeting = updated;
    await ctx.queue.push({ type: "meeting.poll", meetingId }, ctx.config.vexa.pollIntervalMs);
    return;
  }

  // Vexa owns the normal timeline and attribution. A retained recording is only read when that
  // timeline is materially incomplete, so teardown losses can be recovered without replacing good
  // Vexa speaker metadata.
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
  if (!hasLiveWords && reason && reason !== "stopped") {
    const f = reason ? mapVexaFailure(reason) : { code: "capture_failed" as const, message: "No usable audio was captured for this meeting." };
    const { meeting: failed, changed } = await failMeeting(ctx, meeting, f.code, f.message);
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
    return;
  }
  if (!hasLiveWords && !ctx.transcriptRecovery) {
    const { meeting: failed, changed } = await failMeeting(ctx, meeting, "capture_failed", "No usable audio was captured for this meeting.");
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
    return;
  }

  ({ meeting } = await transition(ctx, meeting, "processing"));
  ctx.log.debug("vexa meeting completed; finalizing", { meetingId: meeting.id, vexaSegments: segments.length });
  await finalize(ctx, meeting, vexa, segments);
}

async function handleSignalStart(ctx: AppContext, meeting: MeetingRow, attempt: number) {
  try {
    if (!meeting.signalCapability) throw new ApiError("capture_failed", "Signal call capability is unavailable.");
    const capability = meeting.signalCapability;
    const reserved = await reserveSignalSeat(ctx, meeting.id);
    // A full rig is a queue, not a failure: wait for a seat until the join deadline would elapse.
    if (!reserved) return await requeueForSignalSeat(ctx, meeting, attempt, "capacity");
    meeting = reserved;
    // Reconstruct at the last possible boundary; never emit this URL in a log or persisted field.
    const callUrl = `${meeting.meetingUrl}#${openSignalCapability(capability, ctx.config.signal.capabilityKey)}`;
    let created;
    try {
      created = await ctx.signal.start({ meetingId: meeting.id, callUrl, botName: meeting.botName ?? undefined, language: meeting.language ?? undefined });
    } catch (error) {
      // The worker is the authority on its own seats and provisioning. When it says "busy" or "not
      // ready", give the PTX seat back rather than holding it against a capture that never started.
      if (error instanceof ApiError && (error.code === "provider_unavailable" || error.code === "provider_timeout") && (await releaseSignalSeat(ctx, meeting.id))) {
        return await requeueForSignalSeat(ctx, meeting, attempt, error.code);
      }
      throw error;
    }
    const [updated] = await ctx.db.update(meetings).set({ signalSessionId: created.sessionId }).where(and(eq(meetings.id, meeting.id), eq(meetings.status, "joining"))).returning();
    if (!updated) {
      // Stopped or deleted while we were dispatching: don't leave the seat held in the worker.
      await ctx.signal.leave(created.sessionId).catch(() => {});
      await ctx.signal.remove(created.sessionId).catch(() => {});
      return;
    }
    ctx.log.info("signal capture dispatched", { meetingId: meeting.id, sessionId: created.sessionId, platform: "signal" });
    await ctx.queue.push({ type: "meeting.poll", meetingId: meeting.id }, ctx.config.vexa.pollIntervalMs);
    await ctx.queue.push({ type: "meeting.join_deadline", meetingId: meeting.id }, ctx.config.joinTimeoutSeconds * 1000);
  } catch (error) {
    const { meeting: failed, changed } = await failMeeting(ctx, meeting, error instanceof ApiError ? error.code : "provider_unavailable", "Signal capture could not be started.");
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
  }
}

/**
 * Bounded wait for a Signal seat. Attempts are spaced by the poll interval and stop once they would
 * exceed JOIN_TIMEOUT_SECONDS, at which point the meeting fails as provider_unavailable — the same
 * deadline a dispatched meeting gets for admission.
 */
async function requeueForSignalSeat(ctx: AppContext, meeting: MeetingRow, attempt: number, reason: string) {
  const delayMs = Math.max(ctx.config.vexa.pollIntervalMs, 1_000);
  if (attempt * delayMs < ctx.config.joinTimeoutSeconds * 1000) {
    ctx.log.info("waiting for a signal capture seat", { meetingId: meeting.id, attempt, reason });
    await ctx.queue.push({ type: "meeting.start", meetingId: meeting.id, attempt: attempt + 1 }, delayMs);
    return;
  }
  const fresh = (await getMeetingById(ctx, meeting.id)) ?? meeting;
  const { meeting: failed, changed } = await failMeeting(ctx, fresh, "provider_unavailable", "No Signal capture seat became available in time.");
  if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
}

/** Hands a reserved-but-unused seat back to the queue. Only safe while no worker session exists. */
async function releaseSignalSeat(ctx: AppContext, meetingId: string): Promise<boolean> {
  const released = await ctx.db
    .update(meetings)
    .set({ status: "queued" })
    .where(and(eq(meetings.id, meetingId), eq(meetings.status, "joining"), isNull(meetings.signalSessionId)))
    .returning();
  return released.length > 0;
}

/** Serializes check-and-reserve so concurrent queued jobs cannot oversubscribe Signal Desktop seats. */
async function reserveSignalSeat(ctx: AppContext, meetingId: string): Promise<MeetingRow | null> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ptx-signal-capture-capacity'))`);
    const capacity = await tx.execute<{ running: string }>(sql`
      select count(*)::text as running from ${meetings}
      where ${meetings.platform} = 'signal'
        and ${meetings.status} in ('joining', 'waiting_for_admission', 'in_progress', 'processing')
    `);
    if (Number(capacity[0]?.running ?? 0) >= ctx.config.signal.maxConcurrentCalls) return null;
    const [reserved] = await tx.update(meetings).set({ status: "joining" }).where(and(eq(meetings.id, meetingId), eq(meetings.status, "queued"))).returning();
    return reserved ?? null;
  });
}

async function handleSignalPoll(ctx: AppContext, meeting: MeetingRow) {
  if (!meeting.signalSessionId) return;
  try {
    const snapshot = await ctx.signal.status(meeting.signalSessionId);
    if (snapshot.status === "joining" || snapshot.status === "waiting_for_admission" || snapshot.status === "in_progress") {
      const { meeting: updated } = await transition(ctx, meeting, snapshot.status);
      await ctx.queue.push({ type: "meeting.poll", meetingId: meeting.id }, ctx.config.vexa.pollIntervalMs);
      return;
    }
    if (snapshot.status === "failed") {
      const { meeting: failed, changed } = await failMeeting(ctx, meeting, snapshot.errorCode ?? "capture_failed", "Signal capture ended before transcription completed.");
      if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
      return;
    }
    const transcript = normalizeSegments((snapshot.segments ?? []).map((segment) => ({ ...segment, speaker: "Unknown", speakerKey: "unknown", attribution: "unknown" })), meeting.language);
    if (!transcript.text.trim()) throw new ApiError("transcription_failed", "Signal capture returned no words.");
    // A poll can observe only a terminal worker snapshot; preserve PTX's ordered lifecycle even
    // when Signal Desktop joined and left between polls.
    if (meeting.status === "joining" || meeting.status === "waiting_for_admission") ({ meeting } = await transition(ctx, meeting, "in_progress"));
    ({ meeting } = await transition(ctx, meeting, "processing"));
    await storeTranscript(ctx, meeting.id, transcript, "signal");
    const { meeting: done, changed } = await transition(ctx, meeting, "completed", { signalCapability: null });
    if (changed) await enqueueMeetingWebhook(ctx, done, "meeting.completed");
  } catch (error) {
    // Do not stringify worker errors here: a malformed local-worker error can include the call URL.
    ctx.log.warn("signal capture finalization failed", { meetingId: meeting.id });
    const { meeting: failed, changed } = await failMeeting(ctx, meeting, error instanceof ApiError ? error.code : "capture_failed", "Signal capture could not be completed.");
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
  }
}

async function finalize(
  ctx: AppContext,
  meeting: MeetingRow,
  vexa: VexaTranscriptionResponse,
  vexaSegments: ReturnType<typeof adaptVexaSegments>,
) {
  const input = {
    meetingId: meeting.id,
    language: meeting.language,
    vexaSegments,
    fetchAudio: () => fetchVexaAudio(ctx, vexa),
  };
  try {
    const recover = !!ctx.transcriptRecovery && isMateriallyIncomplete(vexa, vexaSegments);
    const provider = recover ? ctx.transcriptRecovery! : ctx.transcription;
    const transcript = await provider.transcribe(input);
    if (!transcript.text.trim()) {
      throw new ApiError("transcription_failed", "Transcription provider returned no words");
    }
    await storeTranscript(ctx, meeting.id, transcript, provider.name);
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

/**
 * A large uncovered tail is evidence that Vexa lost its final transcript chunks. We deliberately
 * use the meeting's terminal timestamps, not summed speech time: silence between turns is not a
 * missing timeline, and a fixed grace window prevents short complete meetings from being treated
 * as incomplete merely because their last words precede teardown.
 */
export function isMateriallyIncomplete(vexa: VexaTranscriptionResponse, segments: ReturnType<typeof adaptVexaSegments>) {
  const start = vexa.start_time ? Date.parse(vexa.start_time) : NaN;
  const end = vexa.end_time ? Date.parse(vexa.end_time) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  const duration = (end - start) / 1000;
  // A missing/empty transcript alone is not duration evidence. In particular, do not send a short
  // silent meeting through recovery merely because it has no words.
  if (duration <= 15) return false;
  const words = segments.filter((segment) => segment.text.trim().length > 0);
  if (words.length === 0) return true;
  const finalWordEnd = Math.min(duration, Math.max(...words.map((segment) => segment.end)));
  const uncoveredTail = duration - finalWordEnd;
  return uncoveredTail > 15 && finalWordEnd / duration < 0.8;
}

async function fetchVexaAudio(ctx: AppContext, vexa: VexaTranscriptionResponse) {
  const recordings = await ctx.vexa.listRecordings();
  const recording = recordings.recordings.find((candidate) => candidate.meeting_id === vexa.id && candidate.media_files.some((file) => file.type === "audio"));
  if (!recording) return null;
  const master = await ctx.vexa.recordingMaster(recording.id);
  if (!master.raw_url) return null;
  const { bytes, contentType } = await ctx.vexa.fetchBytes(master.raw_url);
  return bytes.length ? { bytes, filename: "meeting.webm", contentType } : null;
}
