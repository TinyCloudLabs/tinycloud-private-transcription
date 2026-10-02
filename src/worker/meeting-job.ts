import type { AppContext } from "../context.ts";
import type { MeetingRow } from "../db/schema.ts";
import { ApiError } from "../domain/errors.ts";
import type { Platform } from "../domain/platform.ts";
import { isTerminal, mapVexaFailure, mapVexaStatus, type MeetingStatus } from "../domain/state.ts";
import { VexaHttpError } from "../providers/vexa/client.ts";
import { adaptVexaSegments, completionReasonOf } from "../providers/vexa/adapter.ts";
import { toVexaPlatform } from "../providers/vexa/platform-map.ts";
import { completeMeetingWithTranscript, failMeeting, getMeetingById, transition } from "../services/meetings.ts";
import { enqueueMeetingWebhook } from "../webhooks/dispatcher.ts";
import { observeCapture, recordCapture } from "../services/capture.ts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { attributedTranscriptionRuns, meetings } from "../db/schema.ts";
import { normalizeSegments } from "../domain/transcript.ts";
import { openSignalCapability } from "../providers/signal/capability.ts";
import { AttributedStagingError, markAttributedRecovery, resumeAttributedRun, stageAttributedManifest, type AttributedStageOutcome } from "../services/attributed-transcription.ts";
import type { VexaAttributedAudioManifest, VexaTranscriptionResponse } from "../providers/vexa/types.ts";
import type { Job } from "./queue.ts";

const MAX_START_ATTEMPTS = 3;
const MAX_RECOVERY_ATTEMPTS = 3;
const usesAttributedCapture = (ctx: AppContext, meeting: MeetingRow) => ctx.config.attributedTranscriptionEnabled && meeting.platform === "google_meet";
// The only Vexa container shape we retain is its documented opaque runtime handle. Provider
// responses are untrusted: URLs, text, and arbitrary identifiers must never become SQL data.
const safeVexaBotId = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 128 && /^[a-z0-9][a-z0-9._:-]*$/i.test(value) && !/private|credential|secret|token|https?:/i.test(value) ? value : undefined;
const safeProviderNativeId = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-z0-9][a-z0-9.@-]{0,127}$/i.test(value) && !/private|credential|secret|token|https?:/i.test(value) ? value : undefined;
const safeVexaMeetingId = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : undefined;

// The TTL bounds how long an orphaned lease (worker crash, dropped job) can suppress wakeup
// reconciliation before expiry re-arms it — it never bounds how long a job may run, because the
// owning job renews it continuously (see handleMeetingPoll). Three poll intervals keeps repairs at
// ~3x the normal wakeup latency while giving each renewal two missed-beat margin, independent of
// the Vexa request timeout (15 s by default) since renewal covers provider stalls too.
const pollLeaseTtlMs = (ctx: AppContext) => ctx.config.vexa.pollIntervalMs * 3;

/**
 * Starts a poll chain for a freshly dispatched capture. The lease is claimed before the delayed
 * job lands so the job already owns the chain; a live lease means a chain is polling already and
 * needs no wakeup. If Redis blips mid-claim a tokenless job is still pushed — it no-ops on a live
 * lease and claims an expired one itself. After pushing, ownership is re-verified so a wakeup that
 * raced in between cannot ride the fresh chain's tail.
 */
async function startPollChain(ctx: AppContext, meetingId: string, delayMs: number): Promise<void> {
  const token = crypto.randomUUID();
  const claimed = await ctx.queue.claimPollLease(meetingId, token, pollLeaseTtlMs(ctx)).catch(() => null);
  if (claimed === false) return;
  const job: Job = { type: "meeting.poll", meetingId, ...(claimed ? { pollToken: token } : {}) };
  await ctx.queue.push(job, delayMs);
  if (claimed && !(await ctx.queue.renewPollLease(meetingId, token, delayMs + pollLeaseTtlMs(ctx)).catch(() => false))) {
    await ctx.queue.removeDelayed(job).catch(() => {});
  }
}

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
      // Keep the established Vexa contract untouched unless the new producer was explicitly
      // selected.  A disabled flag is a compatibility boundary, not a partial rollout.
      ...(usesAttributedCapture(ctx, meeting)
        ? { transcribe_enabled: false, recording_enabled: true, attributed_audio_enabled: true }
        : { transcribe_enabled: true, ...(ctx.transcriptRecovery ? { recording_enabled: true } : {}) }),
      // Vexa otherwise applies its ten-minute deployment fallback. Pin every TinyCloud meeting to
      // our configurable audio-silence window. This can expire with humans still connected;
      // participant presence does not veto Vexa's silence verdict.
      automatic_leave: { max_time_left_alone: ctx.config.vexa.maxTimeLeftAloneMs },
    });
    // Prefer our already-validated, request-derived identity. A provider-derived replacement is
    // retained only when it is a narrow opaque identifier, never arbitrary returned text/URLs.
    const vexaNativeMeetingId = created.native_meeting_id === meeting.vexaNativeMeetingId
      ? meeting.vexaNativeMeetingId
      : safeProviderNativeId(created.native_meeting_id) ?? meeting.vexaNativeMeetingId;
    // Attributed audio is addressed by Vexa's numeric row id.  Do not put an untrusted provider
    // handle in SQL and never fall back to a value which can later enter an API/webhook payload.
    const vexaMeetingId = usesAttributedCapture(ctx, meeting) ? safeVexaMeetingId(created.id) : undefined;
    if (usesAttributedCapture(ctx, meeting) && !vexaMeetingId) throw new ApiError("provider_unavailable", "Capture provider returned an invalid meeting identity.");
    const dispatched = await recordCapture(ctx, meeting, {
      silence_timeout_ms: ctx.config.vexa.maxTimeLeftAloneMs,
      live_transcription_requested: !usesAttributedCapture(ctx, meeting),
    });
    const { meeting: updated, changed } = await transition(ctx, dispatched, "joining", {
      // Platform is request-derived and allowlisted. A provider response must not replace it.
      vexaPlatform,
      vexaNativeMeetingId,
      ...(vexaMeetingId ? { vexaMeetingId } : {}),
      ...(safeVexaBotId(created.bot_container_id) ? { vexaBotId: safeVexaBotId(created.bot_container_id) } : {}),
    });
    if (changed) {
      ctx.log.info("bot dispatched", { meetingId, stage: "dispatch_admitted" });
      await startPollChain(ctx, meetingId, ctx.config.vexa.pollIntervalMs);
      // Worker-side join deadline: Vexa's own awaiting_admission timeout is opaque; without this a
      // never-admitted bot leaves the meeting in joining/waiting_for_admission forever.
      await ctx.queue.push({ type: "meeting.join_deadline", meetingId }, ctx.config.joinTimeoutSeconds * 1000);
    } else if (updated.status === "cancelled" && vexaNativeMeetingId) {
      // Stopped while we were dispatching the bot: don't leave it orphaned in Vexa.
      await ctx.vexa.stopBot(vexaPlatform, vexaNativeMeetingId).catch(() => {});
    }
  } catch (e) {
    await handleStartError(ctx, meeting, e, attempt);
  }
}

async function handleStartError(ctx: AppContext, meeting: MeetingRow, e: unknown, attempt: number) {
  const retryable = e instanceof ApiError && (e.code === "provider_unavailable" || e.code === "provider_timeout");
  const vexa5xx = e instanceof VexaHttpError && e.status >= 500;
  if ((retryable || vexa5xx) && attempt < MAX_START_ATTEMPTS) {
    ctx.log.warn("vexa createBot failed, retrying", { meetingId: meeting.id, attempt, stage: "create", code: e instanceof ApiError ? e.code : "provider_error" });
    await ctx.queue.push({ type: "meeting.start", meetingId: meeting.id, attempt: attempt + 1 }, 1_000 * attempt);
    return;
  }
  ctx.log.error("vexa createBot failed", { meetingId: meeting.id, stage: "create", code: e instanceof ApiError ? e.code : "provider_error" });
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
      if (!(e instanceof VexaHttpError && e.notFound)) ctx.log.warn("vexa stopBot failed at join deadline", { meetingId, stage: "join_deadline_stop", code: "provider_error" });
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
export async function handleMeetingPoll(ctx: AppContext, meetingId: string, recoveryAttempt = 1, pollToken?: string, stagingAttempt = 0): Promise<void> {
  // One live poll chain per meeting. Claim before anything else (including the meeting read):
  // every millisecond between pop and claim eats the lease TTL the previous hop reserved, and a
  // chain job that finds the meeting gone or finished still frees the lease it carried so a
  // recover/stop wakeup inside the TTL window is not swallowed as a duplicate of a dead chain.
  const token = pollToken ?? crypto.randomUUID();
  if (!(await ctx.queue.claimPollLease(meetingId, token, pollLeaseTtlMs(ctx)))) return;
  let chainAlive = false;
  const continuePoll = async (delayMs: number, attempt = recoveryAttempt, nextStagingAttempt = 0) => {
    // Re-verify and extend ownership to cover the delay plus the next job's own TTL before the
    // push lands. If the lease was lost (or Redis is down), letting this hop fail is cheaper than
    // spawning a chain that cannot renew: the job exits chainless and reconciliation re-arms it.
    if (await ctx.queue.renewPollLease(meetingId, token, delayMs + pollLeaseTtlMs(ctx))) {
      const job: Job = { type: "meeting.poll", meetingId, recoveryAttempt: attempt, ...(nextStagingAttempt ? { stagingAttempt: nextStagingAttempt } : {}), pollToken: token };
      await ctx.queue.push(job, delayMs);
      // Re-verify after the push; a wakeup cannot claim a live lease, so failure here means the
      // lease was already lost and the just-pushed hop must not survive as a zombie chain.
      if (await ctx.queue.renewPollLease(meetingId, token, delayMs + pollLeaseTtlMs(ctx))) {
        chainAlive = true;
        return;
      }
      await ctx.queue.removeDelayed(job).catch(() => {});
    }
    ctx.log.warn("poll chain lost its lease; not re-enqueueing", { meetingId, stage: "poll", code: "lease_lost" });
  };
  // Renewal while the job works keeps the lease alive through provider stalls longer than the TTL
  // (Vexa calls may take up to the request timeout) and through queue backpressure. A failed beat
  // only means Redis or ownership is gone; continuePoll's own renewal is the authoritative gate.
  const renewal = setInterval(() => {
    ctx.queue.renewPollLease(meetingId, token, pollLeaseTtlMs(ctx)).catch(() => {});
  }, Math.max(10, Math.floor(pollLeaseTtlMs(ctx) / 3)));
  try {
    const meeting = await getMeetingById(ctx, meetingId);
    if (!meeting || isTerminal(meeting.status as MeetingStatus)) return;
    await pollMeeting(ctx, meeting, recoveryAttempt, continuePoll, stagingAttempt);
  } finally {
    clearInterval(renewal);
    // No continuation was enqueued: free the lease so heartbeat reconciliation can start a fresh
    // chain on the next heartbeat instead of waiting out the TTL.
    if (!chainAlive) await ctx.queue.releasePollLease(meetingId, token).catch(() => {});
  }
}

type ContinuePoll = (delayMs: number, attempt?: number, nextStagingAttempt?: number) => Promise<void>;

async function pollMeeting(ctx: AppContext, meeting: MeetingRow, recoveryAttempt: number, continuePoll: ContinuePoll, stagingAttempt = 0): Promise<void> {
  if (meeting.platform === "signal") return handleSignalPoll(ctx, meeting, continuePoll);
  if (!meeting.vexaPlatform || !meeting.vexaNativeMeetingId) return;

  let vexa;
  try {
    vexa = await ctx.vexa.getTranscript(meeting.vexaPlatform, meeting.vexaNativeMeetingId);
  } catch (e) {
    if (e instanceof VexaHttpError && e.notFound) {
      meeting = await recordCapture(ctx, meeting, { provider_record_missing_at: new Date().toISOString() });
      ctx.log.warn("capture provider record missing", { meetingId: meeting.id, stage: "poll", code: "provider_not_found" });
      const { meeting: failed } = await failMeeting(ctx, meeting, "capture_failed", "The capture provider lost track of this meeting.");
      await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
      return;
    }
    ctx.log.warn("vexa poll failed; will retry", { meetingId: meeting.id, stage: "poll", code: e instanceof ApiError ? e.code : "provider_error" });
    await continuePoll(ctx.config.vexa.pollIntervalMs);
    return;
  }

  meeting = await observeCapture(ctx, meeting, vexa);

  // completion_reason lives under `data` on transcript rows (top-level only on MeetingResponse rows).
  const reason = completionReasonOf(vexa);
  const mapped = mapVexaStatus(vexa.status);

  const failureStage = vexa.data?.failure_stage;
  // Explicit provider evidence outranks our local state. Local in_progress/processing is only a
  // fallback when Vexa omitted failure_stage entirely (including manual recovery of an old row).
  const failedAfterAdmission = mapped === "failed" && (
    failureStage === "active"
    || (failureStage == null && (meeting.status === "in_progress" || meeting.status === "processing"))
  );
  if (mapped === "failed" && !failedAfterAdmission) {
    const f = mapVexaFailure(reason);
    const { meeting: failed, changed } = await failMeeting(ctx, meeting, f.code, f.message);
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
    return;
  }

  if (vexa.status !== "completed" && mapped !== "failed") {
    const { meeting: updated } = await transition(ctx, meeting, mapped);
    meeting = updated;
    await continuePoll(ctx.config.vexa.pollIntervalMs);
    return;
  }

  if (usesAttributedCapture(ctx, meeting)) {
    await handleAttributedCompletion(ctx, meeting, vexa, recoveryAttempt, stagingAttempt, continuePoll);
    return;
  }


  // Feature-off is the pre-existing native/recovery finalization path.
  let segments: ReturnType<typeof adaptVexaSegments>;
  try {
    segments = adaptVexaSegments(vexa);
  } catch {
    const { meeting: failed, changed } = await failMeeting(ctx, meeting, "transcription_failed", "The capture provider returned an invalid transcript.");
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
    return;
  }
  const hasLiveWords = segments.some((segment) => segment.text.trim().length > 0);
  const recover = !!ctx.transcriptRecovery && isMateriallyIncomplete(vexa, segments);
  if (!hasLiveWords && !recover) {
    const failure = reason ? mapVexaFailure(reason) : { code: "capture_failed" as const, message: "No usable audio was captured for this meeting." };
    const { meeting: failed, changed } = await failMeeting(ctx, meeting, failure.code, failure.message);
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
    return;
  }
  ({ meeting } = await transition(ctx, meeting, "processing"));
  await finalize(ctx, meeting, vexa, segments, recover, recoveryAttempt, continuePoll);
}
/**
 * Attributed finalization. A committed run is always resumed on its own ledger and never
 * re-sent to the paid provider. Whole-recording recovery is only reachable once no run exists
 * AND the manifest is verifiably non-stageable (open after bounded retries, invalid, missing
 * capability or capture identity); the durable `fallback` marker is committed under the same
 * advisory lock as staging so the two paths cannot interleave (TC-559).
 */
const MAX_STAGING_ATTEMPTS = 3;
const STAGING_RETRYABLE = new Set(["open", "transport", "db"]);

async function handleAttributedCompletion(ctx: AppContext, meeting: MeetingRow, vexa: VexaTranscriptionResponse, recoveryAttempt: number, stagingAttempt: number, continuePoll: ContinuePoll) {
  ({ meeting } = await transition(ctx, meeting, "processing"));
  const vexaMeetingId = meeting.vexaMeetingId;
  if (!vexaMeetingId) {
    // Without the capture identity no manifest can be verified at all.
    const outcome = await markAttributedRecovery(ctx, meeting.id, null);
    if (outcome === "ineligible") return;
    if (outcome === "resumed") { await resumeAttributedRun(ctx, meeting.id); return; }
    return recoverFromRecording(ctx, meeting, vexa, recoveryAttempt, continuePoll);
  }
  const [existing] = await ctx.db.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meeting.id));
  if (existing) {
    if (existing.status === "fallback") return recoverFromRecording(ctx, meeting, vexa, recoveryAttempt, continuePoll);
    if (existing.status !== "processing") return;
    // The ledger already owns this meeting; a re-staged or conflicting manifest is never
    // verified again and never falls back to the recording.
    return resumeAttributedRun(ctx, meeting.id);
  }
  let fetched: VexaAttributedAudioManifest;
  try {
    fetched = await ctx.vexa.getAttributedAudio(vexaMeetingId);
  } catch (e) {
    if (stagingAttempt + 1 < MAX_STAGING_ATTEMPTS) {
      ctx.log.warn("attributed manifest fetch failed; retrying", { meetingId: meeting.id, stage: "attributed_staging", staging_attempt: stagingAttempt + 1, code: e instanceof ApiError || e instanceof VexaHttpError ? "transport" : "db" });
      await continuePoll(ctx.config.vexa.pollIntervalMs, recoveryAttempt, stagingAttempt + 1);
      return;
    }
    ctx.log.error("attributed manifest staging failed", { meetingId: meeting.id, stage: "attributed_staging", code: e instanceof ApiError || e instanceof VexaHttpError ? "transport" : "db" });
    const outcome = await markAttributedRecovery(ctx, meeting.id, null);
    if (outcome === "ineligible") return;
    if (outcome === "resumed") { await resumeAttributedRun(ctx, meeting.id); return; }
    return recoverFromRecording(ctx, meeting, vexa, recoveryAttempt, continuePoll);
  }
  let outcome: AttributedStageOutcome | "ineligible" | "fallback";
  try {
    // Sealed producer evidence is the preferred enabled-path source of canonical text.
    outcome = await stageAttributedManifest(ctx, meeting.id, vexaMeetingId, fetched, vexa.data?.attributed_audio_capability);
  } catch (e) {
    const reason = e instanceof AttributedStagingError ? e.reason : "db";
    if (STAGING_RETRYABLE.has(reason) && stagingAttempt + 1 < MAX_STAGING_ATTEMPTS) {
      ctx.log.warn("attributed manifest not stageable yet; retrying", { meetingId: meeting.id, stage: "attributed_staging", staging_attempt: stagingAttempt + 1, code: reason });
      await continuePoll(ctx.config.vexa.pollIntervalMs, recoveryAttempt, stagingAttempt + 1);
      return;
    }
    ctx.log.error("attributed manifest staging failed", { meetingId: meeting.id, stage: "attributed_staging", code: reason });
    outcome = await markAttributedRecovery(ctx, meeting.id, fetched);
  }
  if (outcome === "ineligible") return;
  if (outcome === "resumed") { await resumeAttributedRun(ctx, meeting.id); return; }
  if (outcome === "staged") return;
  return recoverFromRecording(ctx, meeting, vexa, recoveryAttempt, continuePoll);
}

/** Completes the meeting from the retained mixed recording when no attributed run exists. */
async function recoverFromRecording(ctx: AppContext, meeting: MeetingRow, vexa: VexaTranscriptionResponse, recoveryAttempt: number, continuePoll: ContinuePoll) {
  if (meeting.status !== "processing") return;
  if (!ctx.transcriptRecovery) {
    const { meeting: failed, changed } = await failMeeting(ctx, meeting, "transcription_failed", "Attributed source evidence could not be reconciled.");
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
    return;
  }
  let segments: ReturnType<typeof adaptVexaSegments>;
  try {
    segments = adaptVexaSegments(vexa);
  } catch {
    segments = [];
  }
  await finalize(ctx, meeting, vexa, segments, true, recoveryAttempt, continuePoll, true);
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
    ctx.log.info("signal capture dispatched", { meetingId: meeting.id, stage: "dispatch_admitted" });
    await startPollChain(ctx, meeting.id, ctx.config.vexa.pollIntervalMs);
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

async function handleSignalPoll(ctx: AppContext, meeting: MeetingRow, continuePoll: (delayMs: number) => Promise<void>) {
  if (!meeting.signalSessionId) return;
  try {
    const snapshot = await ctx.signal.status(meeting.signalSessionId);
    if (snapshot.status === "joining" || snapshot.status === "waiting_for_admission" || snapshot.status === "in_progress") {
      const { meeting: updated } = await transition(ctx, meeting, snapshot.status);
      await continuePoll(ctx.config.vexa.pollIntervalMs);
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
    await completeMeetingWithTranscript(ctx, meeting.id, transcript, "signal", { signalCapability: null });
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
  recover: boolean,
  recoveryAttempt: number,
  continuePoll: (delayMs: number, attempt?: number) => Promise<void>,
  degraded = false,
) {
  const input = {
    meetingId: meeting.id,
    language: meeting.language,
    vexaSegments,
    fetchAudio: () => fetchVexaAudio(ctx, vexa),
  };
  try {
    const provider = recover ? ctx.transcriptRecovery! : ctx.transcription;
    const transcript = await provider.transcribe(input);
    if (degraded) transcript.partial = true;
    if (!transcript.text.trim()) {
      throw new ApiError("transcription_failed", "Transcription provider returned no words");
    }
    await completeMeetingWithTranscript(ctx, meeting.id, transcript, provider.name);
  } catch (e) {
    if (recover && e instanceof RecoveryRecordingNotReadyError && recoveryAttempt < MAX_RECOVERY_ATTEMPTS) {
      ctx.log.warn("vexa recording is not ready; retrying recovery", { meetingId: meeting.id, recoveryAttempt });
      await continuePoll(ctx.config.vexa.pollIntervalMs * recoveryAttempt, recoveryAttempt + 1);
      return;
    }
    if (recover && vexaSegments.some((segment) => segment.text.trim().length > 0)) {
      ctx.log.warn("recording recovery exhausted; preserving vexa transcript", { meetingId: meeting.id, recoveryAttempt, stage: "recording_recovery", code: "provider_error" });
      const transcript = await ctx.transcription.transcribe(input);
      if (degraded) transcript.partial = true;
      if (transcript.text.trim()) {
        await completeMeetingWithTranscript(ctx, meeting.id, transcript, ctx.transcription.name);
        return;
      }
    }
    if (recover && e instanceof RecoveryRecordingNotReadyError) {
      const failure = mapVexaFailure(completionReasonOf(vexa));
      ctx.log.error("recording recovery exhausted without retained audio", { meetingId: meeting.id, recoveryAttempt });
      const { meeting: failed, changed } = await failMeeting(ctx, meeting, failure.code, failure.message);
      if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
      return;
    }
    ctx.log.error("transcription failed", { meetingId: meeting.id, stage: "transcription", code: e instanceof ApiError ? e.code : "provider_error" });
    const { meeting: failed, changed } = await failMeeting(
      ctx,
      meeting,
      "transcription_failed",
      "Transcription could not be completed for this meeting.",
    );
    if (changed) await enqueueMeetingWebhook(ctx, failed, "meeting.failed");
  }
}

const MATERIAL_GAP_SECONDS = 15;
const MATERIAL_GAP_RATIO = 0.2;
const MIN_MATERIAL_COVERAGE_RATIO = 0.2;

/**
 * Terminal duration is the coverage boundary. A single uncovered interval is material only when it
 * exceeds both 15 seconds and 20% of the recording. As a conservative backstop for distributed
 * loss, merged word intervals covering less than 20% of a recording are also incomplete when more
 * than 15 seconds are uncovered. This avoids treating ordinary pauses as loss while catching sparse
 * fragments whose individual gaps remain below the ratio threshold.
 */
export function isMateriallyIncomplete(vexa: VexaTranscriptionResponse, segments: ReturnType<typeof adaptVexaSegments>) {
  const words = segments.filter((segment) => segment.text.trim().length > 0);
  // Empty native output is never evidence of silence. Recovery decodes the actual recording before
  // making that determination, including for short calls and rows with missing terminal timestamps.
  if (words.length === 0) return true;
  const start = vexa.start_time ? Date.parse(vexa.start_time) : NaN;
  const end = vexa.end_time ? Date.parse(vexa.end_time) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  const duration = (end - start) / 1000;
  const ordered = words
    .map((segment) => ({ start: Math.max(0, Math.min(duration, segment.start)), end: Math.max(0, Math.min(duration, segment.end)) }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (ordered.length === 0) return true;

  const merged: { start: number; end: number }[] = [];
  for (const interval of ordered) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }

  let previousEnd = 0;
  let largestGap = 0;
  let covered = 0;
  for (const interval of merged) {
    largestGap = Math.max(largestGap, interval.start - previousEnd);
    covered += interval.end - interval.start;
    previousEnd = interval.end;
  }
  largestGap = Math.max(largestGap, duration - previousEnd);
  const uncovered = duration - covered;
  return (largestGap > MATERIAL_GAP_SECONDS && largestGap / duration > MATERIAL_GAP_RATIO)
    || (uncovered > MATERIAL_GAP_SECONDS && covered / duration < MIN_MATERIAL_COVERAGE_RATIO);
}

async function fetchVexaAudio(ctx: AppContext, vexa: VexaTranscriptionResponse) {
  try {
    const recordings = await ctx.vexa.listRecordings();
    const recording = recordings.recordings.find((candidate) => candidate.meeting_id === vexa.id && candidate.media_files.some((file) => file.type === "audio"));
    if (!recording) throw new RecoveryRecordingNotReadyError();
    const master = await ctx.vexa.recordingMaster(recording.id);
    if (!master.raw_url) throw new RecoveryRecordingNotReadyError();
    const { bytes, contentType } = await ctx.vexa.fetchBytes(master.raw_url);
    if (!bytes.length) throw new RecoveryRecordingNotReadyError();
    return { bytes, filename: "meeting.webm", contentType };
  } catch (error) {
    if (error instanceof RecoveryRecordingNotReadyError || isRetryableRecordingFetchError(error)) {
      throw new RecoveryRecordingNotReadyError();
    }
    throw error;
  }
}

class RecoveryRecordingNotReadyError extends Error {
  constructor() {
    super("The retained recording is not ready");
    this.name = "RecoveryRecordingNotReadyError";
  }
}

const isRetryableRecordingFetchError = (error: unknown) =>
  (error instanceof ApiError && (error.code === "provider_unavailable" || error.code === "provider_timeout"))
  || (error instanceof VexaHttpError && (error.notFound || error.status === 429 || error.status >= 500));
