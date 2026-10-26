import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { config as processConfig } from "../config.ts";
import { isAssistantReply } from "../domain/hallucination.ts";
import { installFatalLogHandlers } from "../log.ts";
import { providerDispatchSlots, transcriptionAdmission, transcriptionAttempts, transcriptionProviderBlocks, transcriptionRegions, transcriptionResults, transcriptions, transcriptionWorkers, type TranscriptionRow } from "../db/schema.ts";
import { pcmToWav } from "../providers/transcription/audio.ts";
import { decodeChannelToPcm, PCM_RATE, readPcmRange } from "./audio.ts";
import type { BatchContext } from "./context.ts";
import { detectDiarizedSpeech, UNKNOWN_SPEAKER, type SpeakerSegment } from "./diarize.ts";
import type { JobErrorCode } from "./errors.ts";
import { isSimulatedCrash } from "./faults.ts";
import { fenceGuard, holdFence, LostFence, type DbOrTx, type Fence } from "./fence.ts";
import { cleanupJobFiles, recoverStaleClaims, releaseDeadSlot, runSweep, terminalize, workerLive } from "./ledger.ts";
import type { ProviderOutcome } from "./provider.ts";
import { ensureStorageRoot, jobDir, removeJobEntry, workDirName } from "./storage.ts";
import { detectSpeech, frameEnergies, summarizeVad, VAD, type Detection, type Region, type VadStats } from "./vad.ts";

export interface Claim {
  job: TranscriptionRow;
  fence: Fence;
}

/**
 * Claims the oldest queued job, but only while no job is processing: one job end-to-end at a time,
 * service-wide. Serialized on the admission row; `closed` admission stops new claims.
 */
export async function claimNext(ctx: BatchContext): Promise<Claim | null> {
  if (!ctx.provider) return null;
  await recoverStaleClaims(ctx);
  return ctx.db.transaction(async (tx) => {
    const [admission] = await tx.select({ mode: transcriptionAdmission.mode }).from(transcriptionAdmission).where(eq(transcriptionAdmission.id, 1)).for("update");
    if (!admission || admission.mode === "closed") return null;
    const [busy] = await tx.select({ id: transcriptions.id }).from(transcriptions).where(eq(transcriptions.status, "processing")).limit(1);
    if (busy) return null;
    const [next] = await tx.select({ id: transcriptions.id }).from(transcriptions)
      .where(and(eq(transcriptions.status, "queued"), eq(transcriptions.tombstoned, false),
        sql`not exists (${tx.select({ one: sql`1` }).from(transcriptionProviderBlocks)
          .where(and(eq(transcriptionProviderBlocks.transcriptionId, transcriptions.id), gt(transcriptionProviderBlocks.nextAttemptAt, new Date())))})`))
      .orderBy(asc(transcriptions.uploadedAt), asc(transcriptions.id)).limit(1).for("update", { skipLocked: true });
    if (!next) return null;
    const token = crypto.randomUUID();
    const [job] = await tx.update(transcriptions).set({
      status: "processing",
      claimToken: token,
      claimOwnerId: ctx.workerId,
      claimHeartbeatAt: sql`now()`,
      generation: sql`${transcriptions.generation} + 1`,
      claimCount: sql`${transcriptions.claimCount} + 1`,
      processingStartedAt: sql`coalesce(${transcriptions.processingStartedAt}, now())`,
      updatedAt: sql`now()`,
    }).where(and(eq(transcriptions.id, next.id), eq(transcriptions.status, "queued"), eq(transcriptions.tombstoned, false))).returning();
    if (!job) return null;
    return { job, fence: { id: job.id, token, generation: job.generation } };
  });
}

const sleepUnless = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted || ms <= 0) return resolve();
  const timer = setTimeout(done, ms);
  function done() {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  }
  signal.addEventListener("abort", done, { once: true });
});

/** Fenced terminal failure; returns false (and changes nothing) when the fence was already lost. */
async function failClaim(
  ctx: BatchContext,
  db: DbOrTx,
  fence: Fence,
  code: JobErrorCode,
  message: string,
  completion: { metrics?: Partial<FinishedMetrics>; segments?: number | null } = {},
): Promise<boolean> {
  const row = await terminalize(db, fence.id, fenceGuard(fence), "failed", { code, message });
  if (!row) return false;
  logJobFinished(ctx, row, "failed", code, {
    tinfoil_calls: row.tinfoilCalls ?? null,
    tinfoil_audio_seconds: row.tinfoilAudioSeconds === null ? null : Math.round(row.tinfoilAudioSeconds * 1000) / 1000,
    voiced_seconds: null,
    dropped_above_floor_pct: row.vadDroppedAboveFloorPct ?? null,
    vad_fallback: row.vadFallback ?? null,
    ...completion.metrics,
  }, completion.segments ?? null);
  return true;
}

type FinishedMetrics = {
  tinfoil_calls: number | null;
  tinfoil_audio_seconds: number | null;
  voiced_seconds: number | null;
  dropped_above_floor_pct: number | null;
  vad_fallback: boolean | null;
};

function logJobFinished(
  ctx: BatchContext,
  job: TranscriptionRow,
  status: "completed" | "failed",
  code: string | null,
  metrics: FinishedMetrics,
  segments: number | null,
) {
  ctx.log.info("batch job finished", {
    job_id: job.id,
    outcome: status === "completed" ? "completed" : code === "no_speech" ? "no_speech" : "failed",
    code,
    duration_seconds: job.durationSeconds,
    ...metrics,
    segments,
    content_type: job.contentType,
  });
}

/**
 * Runs one claimed job to a terminal state. Every database write is fenced (holdFence / fenceGuard);
 * losing the fence at any boundary stops the job without writing content, and this claim's files are
 * cleaned up again. A renewal timer keeps the claim fresh, and aborts the pipeline when the fence is lost.
 */
export async function processClaim(ctx: BatchContext, claim: Claim): Promise<void> {
  const { job, fence } = claim;
  const abort = new AbortController();
  let renewing = false;
  const renewal = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      await holdFence(ctx.db, fence);
    } catch (error) {
      if (error instanceof LostFence) abort.abort();
    } finally {
      renewing = false;
    }
  }, ctx.config.worker.claimRenewSeconds * 1000);
  try {
    await runPipeline(ctx, job, fence, abort.signal);
  } catch (error) {
    if (isSimulatedCrash(error)) throw error;
    if (error instanceof LostFence || abort.signal.aborted) {
      ctx.log.warn("batch claim fenced out", { transcriptionId: job.id, stage: "fence" });
    } else {
      ctx.log.error("batch job failed unexpectedly", { transcriptionId: job.id, stage: "pipeline", code: "processing_failed" });
      await failClaim(ctx, ctx.db, fence, "processing_failed", "Processing failed");
    }
    // Re-run cleanup after losing the fence: this claim may have written files after the canceller's pass.
    await removeJobEntry(ctx.config.uploadDir, job.id, workDirName(fence.generation));
    await cleanupJobFiles(ctx, job.id);
  } finally {
    clearInterval(renewal);
  }
}

async function runPipeline(ctx: BatchContext, job: TranscriptionRow, fence: Fence, signal: AbortSignal) {
  const root = ctx.config.uploadDir;
  await ctx.faults.hit("worker.after_claim", { id: job.id });
  const dir = jobDir(root, job.id);
  const work = join(dir, workDirName(fence.generation));
  try {
    // Never recursive: if deletion removed the job directory, this fails instead of resurrecting it.
    await mkdir(work, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await holdFence(ctx.db, fence); // throws LostFence when the directory went away because of cancel/delete
    await failClaim(ctx, ctx.db, fence, "processing_failed", "The uploaded recording is missing");
    await cleanupJobFiles(ctx, job.id);
    return;
  }

  // 1. Decode per channel to 16 kHz PCM on disk (.tmp → rename).
  const plan: (number | null)[] = job.channelMode === "separate" && job.channels === 2 ? [0, 1] : [null];
  const pcm = plan.map((_, index) => join(work, `ch${index}.pcm`));
  for (const [index, channel] of plan.entries()) {
    await decodeChannelToPcm(join(dir, job.audioFile!), `${pcm[index]}.tmp`, channel, ctx.config.limits.acceptedMaxDurationSeconds, signal, ctx.config.ffmpegPath);
  }
  await ctx.faults.hit("worker.after_decode", { id: job.id });
  await holdFence(ctx.db, fence);
  for (const path of pcm) await rename(`${path}.tmp`, path);
  await ctx.faults.hit("worker.after_rename", { id: job.id });
  await holdFence(ctx.db, fence);

  // 2. VAD regions (speaker turns for a diarized job), inserted in one fenced transaction (kept across re-claims) with
  //    the coverage they leave: the share of non-silent audio that is not sent, and whether the VAD fell back.
  let regions = await ctx.db.select().from(transcriptionRegions).where(eq(transcriptionRegions.transcriptionId, job.id))
    .orderBy(asc(transcriptionRegions.startMs), asc(transcriptionRegions.channel));
  if (regions.length === 0) {
    const detected = job.diarize ? await diarizeTurns(ctx, job, fence, pcm[0]!, signal) : await vadRegions(ctx, job, fence, pcm);
    if (detected === null) return;
    if (detected.regions.length === 0) {
      if (await failClaim(ctx, ctx.db, fence, "no_speech", "No speech was detected in the recording", {
        metrics: {
          tinfoil_calls: 0, tinfoil_audio_seconds: 0, voiced_seconds: 0,
          dropped_above_floor_pct: detected.droppedAboveFloorPct, vad_fallback: detected.fallback,
        },
        segments: 0,
      })) await cleanupJobFiles(ctx, job.id);
      else throw new LostFence(job.id);
      return;
    }
    await ctx.db.transaction(async (tx) => {
      await holdFence(tx, fence);
      await insertRegions(tx, fence, detected.regions);
      await ctx.faults.hit("worker.regions_inserted", { id: job.id });
      // Bind JSON as text before casting: Bun.SQL otherwise re-encodes Drizzle's JSON string as a JSONB string.
      await tx.update(transcriptions).set({ vadDroppedAboveFloorPct: detected.droppedAboveFloorPct, vadFallback: detected.fallback,
        vadStats: sql`${JSON.stringify(detected.stats)}::text::jsonb` }).where(fenceGuard(fence));
    });
    regions = await ctx.db.select().from(transcriptionRegions).where(eq(transcriptionRegions.transcriptionId, job.id))
      .orderBy(asc(transcriptionRegions.startMs), asc(transcriptionRegions.channel));
  }
  await ctx.faults.hit("worker.after_regions", { id: job.id });

  // 3. One provider call at a time, through the durable single-slot arbiter.
  const state = { rateLimitStreak: 0 };
  for (const region of regions) {
    if (region.status !== "pending") continue;
    const outcome = await dispatchRegion(ctx, job, fence, region, pcm[region.channel]!, signal, state);
    if (outcome === "terminal") {
      await cleanupJobFiles(ctx, job.id);
      return;
    }
    if (outcome === "blocked") {
      // Released to `queued` with a durable not-before. The audio stays (a queued job's upload is never swept); only this
      // claim's decoded PCM goes, the next claim decodes again.
      await removeJobEntry(ctx.config.uploadDir, job.id, workDirName(fence.generation));
      return;
    }
  }

  // 4. Assemble from the database and commit the terminal state (fenced).
  await ctx.faults.hit("worker.before_assemble", { id: job.id });
  await assemble(ctx, job, fence);
  await ctx.faults.hit("worker.after_terminal", { id: job.id });
  await cleanupJobFiles(ctx, job.id);
}

/**
 * Rows per INSERT. Postgres binds at most 65,535 parameters per statement; a region row binds about ten, so a 2 h
 * stereo recording's worst case (~12,000 regions) needs several statements. The caller runs them all in one transaction.
 */
export const REGION_INSERT_CHUNK = 1_000;

/** Inserts every detected region (ordinal = index) in chunks, inside the caller's fenced transaction. */
export async function insertRegions(tx: DbOrTx, fence: Fence, detected: { channel: number; speaker?: number | null; startMs: number; endMs: number }[]) {
  for (let from = 0; from < detected.length; from += REGION_INSERT_CHUNK) {
    await tx.insert(transcriptionRegions).values(detected.slice(from, from + REGION_INSERT_CHUNK).map((region, index) => ({
      transcriptionId: fence.id, ordinal: from + index, channel: region.channel, speaker: region.speaker ?? null, startMs: region.startMs, endMs: region.endMs, status: "pending", generation: fence.generation,
    })));
  }
}

interface DetectedRegions {
  regions: (Region & { channel: number; speaker: number | null })[];
  droppedAboveFloorPct: number;
  fallback: boolean;
  stats: VadStats;
}

const percent = (part: number, whole: number) => whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;

/** Both paths guard the final sent coverage before persisting regions or dispatching any audio. */
async function guardCoverage(ctx: BatchContext, job: TranscriptionRow, fence: Fence,
  detections: readonly Pick<Detection, "fallback" | "primaryDroppedShare" | "covered" | "droppedFrames" | "aboveFloorFrames">[]): Promise<boolean> {
  if (detections.some((d) => d.fallback)) {
    ctx.log.warn("batch VAD fell back to the floor threshold", {
      transcriptionId: job.id, stage: "vad", primaryDroppedAboveFloorPct: Math.max(...detections.map((d) => percent(d.primaryDroppedShare, 1))),
    });
  }
  if (detections.every((d) => d.covered)) return true;
  const dropped = detections.reduce((sum, d) => sum + d.droppedFrames, 0);
  const aboveFloor = detections.reduce((sum, d) => sum + d.aboveFloorFrames, 0);
  ctx.log.error("batch VAD could not cover the recording", { transcriptionId: job.id, stage: "vad", droppedAboveFloorPct: percent(dropped, aboveFloor), alert: true });
  if (await failClaim(ctx, ctx.db, fence, "processing_failed", "Speech detection could not cover the recording")) await cleanupJobFiles(ctx, job.id);
  else throw new LostFence(job.id);
  return false;
}

/**
 * VAD regions of every channel through the coverage guard (`detectSpeech`). A channel whose relative threshold leaves
 * too much non-silent audio unsent falls back to the floor, logged. If even that leaves too much unsent, the job fails
 * processing_failed, fenced, and this returns null: a partial transcript is never completed.
 */
async function vadRegions(ctx: BatchContext, job: TranscriptionRow, fence: Fence, pcm: string[]): Promise<DetectedRegions | null> {
  const energies = await Promise.all(pcm.map((path) => frameEnergies(path)));
  const vad = { ...VAD, quiet: { ...VAD.quiet, enabled: ctx.config.vad.quietMode } };
  const detections = energies.map((e) => detectSpeech(e, vad));
  const dropped = detections.reduce((sum, d) => sum + d.droppedFrames, 0);
  const aboveFloor = detections.reduce((sum, d) => sum + d.aboveFloorFrames, 0);
  const fallback = detections.some((d) => d.fallback);
  if (!await guardCoverage(ctx, job, fence, detections)) return null;
  const regions = detections.flatMap((d, channel) => d.regions.map((region) => ({ ...region, channel, speaker: null })))
    .sort((a, b) => a.startMs - b.startMs || a.channel - b.channel);
  const stats = detections.length === 1 ? detections[0]!.stats
    : summarizeVad(detections.map((d, channel) => ({ energies: energies[channel]!, regions: d.regions, mode: d.stats.vad_mode })), vad);
  return { regions, droppedAboveFloorPct: percent(dropped, aboveFloor), fallback, stats };
}

/**
 * Speaker turns of the mono mix (channel 0), extended by the ordinary VAD's selected coverage when needed.
 * Diarization failure or insufficient final coverage fails processing_failed before any dispatch.
 * The fallback flag and coverage stats describe the selected mode and final sent turns.
 */
async function diarizeTurns(ctx: BatchContext, job: TranscriptionRow, fence: Fence, pcmPath: string, signal: AbortSignal): Promise<DetectedRegions | null> {
  let segments: SpeakerSegment[];
  try {
    if (!ctx.diarizer) throw new Error("diarization is not available");
    segments = await ctx.diarizer.diarize(pcmPath, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    // A cancel or delete removes the PCM before the renewal timer notices: that is a lost fence, not an operator fault.
    await holdFence(ctx.db, fence);
    ctx.log.error("batch diarization failed", { transcriptionId: job.id, stage: "diarize", installed: ctx.diarizer !== null, alert: true });
    if (await failClaim(ctx, ctx.db, fence, "processing_failed", "Speaker diarization failed")) await cleanupJobFiles(ctx, job.id);
    else throw new LostFence(job.id);
    return null;
  }
  const energies = await frameEnergies(pcmPath);
  const vad = { ...VAD, quiet: { ...VAD.quiet, enabled: ctx.config.vad.quietMode } };
  const detection = detectDiarizedSpeech(segments, energies, vad);
  if (!await guardCoverage(ctx, job, fence, [detection])) return null;
  return {
    regions: detection.turns.map((turn) => ({ ...turn, channel: 0 })),
    droppedAboveFloorPct: percent(detection.droppedFrames, detection.aboveFloorFrames),
    fallback: detection.fallback,
    stats: detection.stats,
  };
}

type Admission = { kind: "admitted"; attemptId: string } | { kind: "capacity" } | { kind: "settled" };

/**
 * One transaction: prove the fence, take the single dispatch slot, and commit a `started` attempt. Only
 * then may the caller send the request, with no await in between. A slot still held by a dead process's
 * attempt is reclaimed (that attempt is ambiguous and never re-sent).
 */
async function admitDispatch(ctx: BatchContext, fence: Fence, regionOrdinal: number): Promise<Admission> {
  return ctx.db.transaction(async (tx) => {
    await holdFence(tx, fence);
    const [region] = await tx.select().from(transcriptionRegions)
      .where(and(eq(transcriptionRegions.transcriptionId, fence.id), eq(transcriptionRegions.ordinal, regionOrdinal))).for("update");
    if (!region || region.status !== "pending") return { kind: "settled" };
    const [slot] = await tx.select().from(providerDispatchSlots).where(eq(providerDispatchSlots.id, 1)).for("update");
    if (!slot) throw new Error("provider_dispatch_slots row is missing (migration 0017 not applied)");
    if (slot.attemptId) {
      // Held by another attempt. While its owner process lives, that request may still be in flight, so wait.
      // Reclaiming from a dead owner is defense in depth: recoverStaleClaims normally terminalizes that
      // attempt's job (provider_outcome_unknown) and frees the slot first, but it keeps the slot while the
      // owner's process heartbeat is still fresh, so a slot can outlive a stale claim and be found here. The
      // attempt belongs to a different, already-terminal job, so this write is not fenced by our claim; it is a
      // CAS on that attempt still being `started`, and the request is never re-sent.
      if (slot.ownerId && await workerLive(ctx, tx, slot.ownerId)) return { kind: "capacity" };
      await tx.update(transcriptionAttempts).set({ status: "ambiguous", outcome: "owner_lost", completedAt: sql`now()` })
        .where(and(eq(transcriptionAttempts.id, slot.attemptId), eq(transcriptionAttempts.status, "started")));
      await releaseDeadSlot(ctx, tx, [slot.attemptId]);
      return { kind: "capacity" };
    }
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(transcriptionAttempts)
      .where(and(eq(transcriptionAttempts.transcriptionId, fence.id), eq(transcriptionAttempts.regionOrdinal, regionOrdinal))) as [{ count: number }];
    const ordinal = Number(count) + 1;
    const attemptId = `${fence.id}:r${regionOrdinal}:a${ordinal}`;
    await tx.insert(transcriptionAttempts).values({ id: attemptId, transcriptionId: fence.id, regionOrdinal, ordinal, generation: fence.generation, status: "started" });
    await tx.update(providerDispatchSlots).set({ attemptId, transcriptionId: fence.id, ownerId: ctx.workerId, claimedAt: sql`now()` }).where(eq(providerDispatchSlots.id, 1));
    await tx.update(transcriptions).set({ tinfoilCalls: sql`${transcriptions.tinfoilCalls} + 1` }).where(fenceGuard(fence));
    return { kind: "admitted", attemptId };
  });
}

type RegionRow = typeof transcriptionRegions.$inferSelect;

async function dispatchRegion(
  ctx: BatchContext,
  job: TranscriptionRow,
  fence: Fence,
  region: RegionRow,
  pcmPath: string,
  signal: AbortSignal,
  state: { rateLimitStreak: number },
): Promise<"done" | "terminal" | "blocked"> {
  const w = ctx.config.worker;
  let notSent = 0;
  for (;;) {
    if (signal.aborted) throw new LostFence(fence.id);
    const wav = pcmToWav(await readPcmRange(pcmPath, region.startMs, region.endMs), PCM_RATE);
    await ctx.faults.hit("worker.before_dispatch", { id: job.id });
    const admission = await admitDispatch(ctx, fence, region.ordinal);
    if (admission.kind === "settled") return "done";
    if (admission.kind === "capacity") {
      await sleepUnless(1_000, signal);
      continue;
    }
    // No await is permitted between the committed admission above and the paid request.
    let outcome: ProviderOutcome;
    try {
      outcome = await ctx.provider!.transcribe(wav, `${job.id}-${region.ordinal}.wav`, job.language);
    } catch (error) {
      if (isSimulatedCrash(error)) throw error;
      outcome = { kind: "ambiguous", reason: "client_error" };
    }
    await ctx.faults.hit("worker.after_response", { id: job.id });
    const settled = await settleDispatch(ctx, fence, region, admission.attemptId, outcome, state, notSent);
    if (settled === "lost") throw new LostFence(fence.id);
    if (settled === "done" || settled === "terminal" || settled === "blocked") return settled;
    if (outcome.kind === "rate_limited") {
      const seconds = Math.min(outcome.retryAfterSeconds ?? w.retryAfterDefaultSeconds, w.retryAfterMaxSeconds);
      await sleepUnless(seconds * 1000, signal);
    } else {
      notSent++;
      await sleepUnless(w.notSentBackoffMs * 2 ** (notSent - 1), signal);
    }
  }
}

const ATTEMPT_STATUS: Record<ProviderOutcome["kind"], string> = {
  ok: "succeeded",
  rate_limited: "rate_limited",
  not_sent: "not_sent",
  rejected: "rejected",
  blocked: "blocked",
  misconfigured: "rejected",
  ambiguous: "ambiguous",
};

/** Coded token per blocking status; 429 only reaches it after maxConsecutiveRateLimits consecutive rate limits. */
const BLOCK_REASON: Record<number, string> = { 401: "unauthorized", 402: "payment_required", 403: "forbidden", 429: "rate_limited" };

const LOGGABLE_REASON = /^[A-Za-z0-9_]{1,40}$/;

/** Only a short coded token may reach the log (`timeout`, `http_502`, `ECONNRESET`); anything free-form collapses to `other`. */
function loggableReason(detail: string | null): string | null {
  if (detail === null) return null;
  return LOGGABLE_REASON.test(detail) ? detail : "other";
}

/**
 * Settles one admitted attempt. The attempt's metadata and the slot release are always recorded (no
 * content). Everything else — region text, counters, terminal transitions — is written only while the
 * fence holds; a late response after cancel/delete/timeout is discarded without writing content.
 */
async function settleDispatch(
  ctx: BatchContext,
  fence: Fence,
  region: RegionRow,
  attemptId: string,
  outcome: ProviderOutcome,
  state: { rateLimitStreak: number },
  notSent: number,
): Promise<"done" | "retry" | "terminal" | "blocked" | "lost"> {
  const w = ctx.config.worker;
  const detail = outcome.kind === "ambiguous" || outcome.kind === "not_sent" ? outcome.reason
    : outcome.kind === "rejected" || outcome.kind === "misconfigured" || outcome.kind === "blocked" ? `http_${outcome.status}` : null;
  const seen = { newlyBlockedStatus: null as number | null, recoveredJobs: 0, droppedRegions: 0 };
  const result = await ctx.db.transaction(async (tx) => {
    let lost = false;
    try {
      await holdFence(tx, fence);
    } catch (error) {
      if (!(error instanceof LostFence)) throw error;
      lost = true;
    }
    await tx.update(transcriptionAttempts).set({ status: lost && outcome.kind === "ok" ? "discarded" : ATTEMPT_STATUS[outcome.kind], outcome: detail, completedAt: sql`now()` })
      .where(and(eq(transcriptionAttempts.id, attemptId), eq(transcriptionAttempts.status, "started")));
    await tx.update(providerDispatchSlots).set({ attemptId: null, transcriptionId: null, ownerId: null, claimedAt: null })
      .where(and(eq(providerDispatchSlots.id, 1), eq(providerDispatchSlots.attemptId, attemptId)));
    if (lost) return "lost" as const;

    const regionWhere = and(eq(transcriptionRegions.transcriptionId, fence.id), eq(transcriptionRegions.ordinal, region.ordinal));
    const fail = async (code: JobErrorCode, message: string, regionStatus: "failed" | "ambiguous") => {
      await tx.update(transcriptionRegions).set({ status: regionStatus }).where(regionWhere);
      const row = await terminalize(tx, fence.id, fenceGuard(fence), "failed", { code, message });
      return row ? { kind: "terminal" as const, row } : "lost" as const;
    };
    /**
     * The provider refused before processing (nothing was done or billed), so the job waits instead of failing: release
     * the claim (back to `queued`, regions kept) with a durable not-before from the capped backoff. Neither the not-sent
     * nor the rate-limit counter, nor the claim count, is consumed. Past the give-up window it fails provider_unavailable.
     */
    const block = async (status: number) => {
      const [current] = await tx.select().from(transcriptionProviderBlocks).where(eq(transcriptionProviderBlocks.transcriptionId, fence.id));
      const now = Date.now();
      const since = current?.blockedSince ?? new Date(now);
      const deadline = since.getTime() + w.providerBlockMaxSeconds * 1000;
      if (now >= deadline) {
        await tx.delete(transcriptionProviderBlocks).where(eq(transcriptionProviderBlocks.transcriptionId, fence.id));
        return fail("provider_unavailable", "The transcription provider stayed unavailable for too long", "failed");
      }
      const schedule = w.providerBlockBackoffSeconds;
      const attempts = current?.attempts ?? 0;
      const delayMs = schedule[Math.min(attempts, schedule.length - 1)]! * 1000;
      const [released] = await tx.update(transcriptions).set({
        status: "queued",
        claimToken: null,
        claimOwnerId: null,
        claimHeartbeatAt: null,
        generation: sql`${transcriptions.generation} + 1`,
        claimCount: sql`greatest(${transcriptions.claimCount} - 1, 0)`,
        // The processing ceiling measures one attempt window; the next claim sets it again.
        processingStartedAt: null,
        updatedAt: sql`now()`,
      }).where(fenceGuard(fence)).returning({ id: transcriptions.id });
      if (!released) return "lost" as const;
      const wait = { blockedSince: since, nextAttemptAt: new Date(Math.min(now + delayMs, deadline)), attempts: attempts + 1, lastStatus: status };
      await tx.insert(transcriptionProviderBlocks).values({ transcriptionId: fence.id, ...wait })
        .onConflictDoUpdate({ target: transcriptionProviderBlocks.transcriptionId, set: wait });
      if (current?.lastStatus !== status) seen.newlyBlockedStatus = status;
      return "blocked" as const;
    };
    switch (outcome.kind) {
      case "ok": {
        state.rateLimitStreak = 0;
        // An audio LLM can answer the audio like a chat assistant (TC-2119). A region that is wholly such a reply is not speech:
        // it completes with empty text, so assembly never publishes it and a job with nothing else ends no_speech.
        const ungrounded = isAssistantReply(outcome.text);
        if (ungrounded) seen.droppedRegions = 1;
        await tx.update(transcriptionRegions).set({ status: "completed", text: ungrounded ? "" : outcome.text }).where(regionWhere);
        await tx.update(transcriptions).set({ tinfoilAudioSeconds: sql`${transcriptions.tinfoilAudioSeconds} + ${(region.endMs - region.startMs) / 1000}` }).where(fenceGuard(fence));
        // A successful dispatch proves the provider works again: every waiting job is released at once, logged once.
        const cleared = await tx.delete(transcriptionProviderBlocks)
          .where(inArray(transcriptionProviderBlocks.transcriptionId, tx.select({ id: transcriptions.id }).from(transcriptions).where(inArray(transcriptions.status, ["queued", "processing"]))))
          .returning({ id: transcriptionProviderBlocks.transcriptionId });
        seen.recoveredJobs = cleared.length;
        return "done" as const;
      }
      case "rate_limited":
        state.rateLimitStreak++;
        if (state.rateLimitStreak >= w.maxConsecutiveRateLimits) {
          state.rateLimitStreak = 0;
          return block(429);
        }
        return "retry" as const;
      case "blocked":
        return block(outcome.status);
      case "not_sent":
        if (notSent + 1 >= w.maxNotSentAttempts) return fail("provider_unavailable", "The transcription provider could not be reached", "failed");
        return "retry" as const;
      case "rejected":
        return fail("transcription_failed", "The transcription provider rejected a segment of the recording", "failed");
      case "misconfigured":
        ctx.log.error("batch provider rejected the service credential or model", { transcriptionId: fence.id, status: outcome.status, stage: "dispatch", alert: true });
        return fail("provider_unavailable", "The transcription provider is unavailable", "failed");
      case "ambiguous":
        return fail("provider_outcome_unknown", "A transcription request had an uncertain outcome; it is not retried to avoid a duplicate paid request", "ambiguous");
    }
  });
  if (seen.newlyBlockedStatus !== null) {
    // Error + alert: the first occurrence is the page. Coded tokens only; the provider's response body is never read.
    ctx.log.error("batch provider blocked", { transcriptionId: fence.id, http_status: seen.newlyBlockedStatus, reason: BLOCK_REASON[seen.newlyBlockedStatus], stage: "dispatch", alert: true });
  }
  // Count only; the dropped text is never logged.
  if (seen.droppedRegions > 0) ctx.log.warn("batch region ungrounded", { transcriptionId: fence.id, dropped_regions: seen.droppedRegions, stage: "dispatch" });
  if (seen.recoveredJobs > 0) ctx.log.warn("batch provider recovered", { delayed_jobs: seen.recoveredJobs, stage: "dispatch" });
  if (typeof result === "object") {
    logJobFinished(ctx, result.row, "failed", result.row.errorCode, {
      tinfoil_calls: result.row.tinfoilCalls,
      tinfoil_audio_seconds: result.row.tinfoilAudioSeconds === null || result.row.tinfoilAudioSeconds === undefined ? null : Math.round(result.row.tinfoilAudioSeconds * 1000) / 1000,
      voiced_seconds: null,
      dropped_above_floor_pct: result.row.vadDroppedAboveFloorPct,
      vad_fallback: result.row.vadFallback,
    }, null);
    ctx.log.warn("batch job failed at dispatch", { transcriptionId: fence.id, outcome: outcome.kind, stage: "dispatch", reason: loggableReason(detail) });
    return "terminal";
  }
  return result;
}

/** Builds the transcript from committed region rows and commits `completed` (or `no_speech`), fenced. */
async function assemble(ctx: BatchContext, job: TranscriptionRow, fence: Fence) {
  const committed = await ctx.db.transaction(async (tx) => {
    await holdFence(tx, fence);
    const regions = await tx.select().from(transcriptionRegions).where(eq(transcriptionRegions.transcriptionId, job.id))
      .orderBy(asc(transcriptionRegions.startMs), asc(transcriptionRegions.channel));
    if (regions.some((region) => region.status !== "completed")) throw new Error("assembly with unsettled regions");
    const [stats] = await tx.select({ calls: transcriptions.tinfoilCalls, seconds: transcriptions.tinfoilAudioSeconds, dropped: transcriptions.vadDroppedAboveFloorPct, fallback: transcriptions.vadFallback, vad: transcriptions.vadStats })
      .from(transcriptions).where(eq(transcriptions.id, job.id));
    const voicedMs = regions.reduce((sum, region) => sum + region.endMs - region.startMs, 0);
    const channels = job.channelMode === "separate" && job.channels === 2 ? [0, 1] : [0];
    const spoken = regions.filter((region) => (region.text ?? "").trim() !== "");
    // Known speakers keep their first-appearance ids and names; Unknown takes the next available id.
    const order = new Map<number, number>();
    if (job.diarize) {
      for (const region of spoken) if (region.speaker !== UNKNOWN_SPEAKER && !order.has(region.speaker!)) order.set(region.speaker!, order.size);
      if (spoken.some((region) => region.speaker === UNKNOWN_SPEAKER)) order.set(UNKNOWN_SPEAKER, order.size);
    }
    const speakers = job.diarize
      ? [...order].map(([speaker, n]) => ({ id: `speaker_${n}`, name: speaker === UNKNOWN_SPEAKER ? "Unknown speaker" : `Speaker ${n + 1}`, channel: 0 }))
      : channels.map((channel) => ({ id: `channel_${channel}`, name: job.channelLabels[channel] ?? `Speaker ${channel + 1}`, channel }));
    const segments = spoken.map((region, index) => ({
      id: `seg_${String(index + 1).padStart(4, "0")}`,
      speaker_id: job.diarize ? `speaker_${order.get(region.speaker!)}` : `channel_${region.channel}`,
      channel: region.channel,
      start: region.startMs / 1000,
      end: region.endMs / 1000,
      text: region.text!.trim(),
    }));
    const metrics = {
      tinfoil_calls: stats?.calls ?? null,
      tinfoil_audio_seconds: stats?.seconds === null || stats?.seconds === undefined ? null : Math.round(stats.seconds * 1000) / 1000,
      voiced_seconds: voicedMs / 1000,
      dropped_above_floor_pct: stats?.dropped ?? null,
      vad_fallback: stats?.fallback ?? null,
    };
    if (segments.length === 0) {
      return {
        row: await terminalize(tx, job.id, fenceGuard(fence), "failed", { code: "no_speech", message: "No speech was recognized in the recording" }),
        segments: 0,
        metrics,
      };
    }

    const name = new Map(speakers.map((speaker) => [speaker.id, speaker.name]));
    await tx.insert(transcriptionResults).values({
      transcriptionId: job.id,
      resultJson: {
        language: job.language,
        duration_seconds: job.durationSeconds,
        provider: "tinfoil",
        model: ctx.provider!.model,
        channels: channels.length,
        diarized: job.diarize,
        speakers,
        segments,
        text: segments.map((segment) => `${name.get(segment.speaker_id)}: ${segment.text}`).join("\n"),
        stats: {
          tinfoil_calls: stats!.calls,
          tinfoil_audio_seconds: Math.round(stats!.seconds * 1000) / 1000,
          // VAD coverage (TC-1045). The last two are null for a job whose regions were detected before they were recorded.
          voiced_seconds: voicedMs / 1000,
          dropped_above_floor_pct: stats!.dropped,
          vad_fallback: stats!.fallback,
          // Old jobs lack these measurements; do not invent a mode or diagnostics for saved regions.
          ...(stats!.vad ?? {}),
        },
      },
    });
    return {
      row: await terminalize(tx, job.id, fenceGuard(fence), "completed", null, {
        transcriptExpiresAt: new Date(Date.now() + ctx.config.retention.transcriptTtlSeconds * 1000),
      }),
      segments: segments.length,
      metrics,
    };
  });
  if (!committed.row) throw new LostFence(job.id);
  logJobFinished(ctx, job, committed.row.status === "completed" ? "completed" : "failed", committed.row.errorCode, committed.metrics, committed.segments);
}

export async function recordWorkerHeartbeat(ctx: BatchContext, observedAt = new Date()) {
  await ctx.db.insert(transcriptionWorkers).values({ id: ctx.workerId, observedAt })
    .onConflictDoUpdate({ target: transcriptionWorkers.id, set: { observedAt } });
}

export interface BatchWorkerHandle {
  stop(): Promise<void>;
}

/** The worker process loop: heartbeat, periodic sweep, and one claimed job at a time. */
export function startBatchWorker(ctx: BatchContext, opts: { sweep?: boolean } = {}): BatchWorkerHandle {
  let running = true;
  const beat = () => recordWorkerHeartbeat(ctx).catch(() => ctx.log.error("batch worker heartbeat failed", { stage: "heartbeat" }));
  void beat();
  const heartbeat = setInterval(beat, ctx.config.worker.heartbeatSeconds * 1000);
  let sweeping = false;
  const sweep = async () => {
    if (sweeping || opts.sweep === false) return;
    sweeping = true;
    try {
      await runSweep(ctx);
    } catch {
      ctx.log.error("batch sweep failed", { stage: "sweep" });
    } finally {
      sweeping = false;
    }
  };
  void sweep();
  const sweeper = setInterval(sweep, ctx.config.retention.sweepIntervalMs);
  const loop = (async () => {
    while (running) {
      try {
        const claim = await claimNext(ctx);
        if (!claim) {
          await Bun.sleep(ctx.config.worker.pollIntervalMs);
          continue;
        }
        await processClaim(ctx, claim);
      } catch (error) {
        if (isSimulatedCrash(error)) break;
        ctx.log.error("batch worker iteration failed", { stage: "loop" });
        await Bun.sleep(ctx.config.worker.pollIntervalMs);
      }
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      clearInterval(heartbeat);
      clearInterval(sweeper);
      while (sweeping) await Bun.sleep(10);
      // Readiness drops immediately rather than after the stale window.
      await recordWorkerHeartbeat(ctx, new Date(0)).catch(() => {});
    },
  };
}

if (import.meta.main) {
  installFatalLogHandlers();
  if (processConfig.role !== "batch") throw new Error("src/uploads/worker.ts runs only with PTX_ROLE=batch");
  const { createBatchContext } = await import("../roles/batch.ts");
  const ctx = createBatchContext();
  await ensureStorageRoot(ctx.config.uploadDir);
  ctx.log.info("batch worker started", { providerConfigured: ctx.provider !== null, diarization: ctx.diarizer !== null });
  const worker = startBatchWorker(ctx);
  const shutdown = async () => {
    await worker.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
