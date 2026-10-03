import { and, asc, eq, sql } from "drizzle-orm";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { config as processConfig } from "../config.ts";
import { providerDispatchSlots, transcriptionAdmission, transcriptionAttempts, transcriptionRegions, transcriptionResults, transcriptions, transcriptionWorkers, type TranscriptionRow } from "../db/schema.ts";
import { pcmToWav } from "../providers/transcription/audio.ts";
import { decodeChannelToPcm, PCM_RATE, readPcmRange } from "./audio.ts";
import type { BatchContext } from "./context.ts";
import { speakerTurns, type SpeakerSegment } from "./diarize.ts";
import type { JobErrorCode } from "./errors.ts";
import { isSimulatedCrash } from "./faults.ts";
import { fenceGuard, holdFence, LostFence, type DbOrTx, type Fence } from "./fence.ts";
import { cleanupJobFiles, recoverStaleClaims, releaseDeadSlot, runSweep, terminalize, workerLive } from "./ledger.ts";
import type { ProviderOutcome } from "./provider.ts";
import { ensureStorageRoot, jobDir, removeJobEntry, workDirName } from "./storage.ts";
import { detectRegions, frameEnergies } from "./vad.ts";

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
      .where(and(eq(transcriptions.status, "queued"), eq(transcriptions.tombstoned, false)))
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
async function failClaim(ctx: BatchContext, db: DbOrTx, fence: Fence, code: JobErrorCode, message: string): Promise<boolean> {
  return !!(await terminalize(db, fence.id, fenceGuard(fence), "failed", { code, message }));
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
    await decodeChannelToPcm(join(dir, job.audioFile!), `${pcm[index]}.tmp`, channel, ctx.config.limits.maxDurationSeconds, signal, ctx.config.ffmpegPath);
  }
  await ctx.faults.hit("worker.after_decode", { id: job.id });
  await holdFence(ctx.db, fence);
  for (const path of pcm) await rename(`${path}.tmp`, path);
  await ctx.faults.hit("worker.after_rename", { id: job.id });
  await holdFence(ctx.db, fence);

  // 2. VAD regions (speaker turns for a diarized job), inserted in one fenced transaction (kept across re-claims).
  let regions = await ctx.db.select().from(transcriptionRegions).where(eq(transcriptionRegions.transcriptionId, job.id))
    .orderBy(asc(transcriptionRegions.startMs), asc(transcriptionRegions.channel));
  if (regions.length === 0) {
    const detected = job.diarize
      ? await diarizeTurns(ctx, job, fence, pcm[0]!, signal)
      : (await Promise.all(pcm.map(async (path, channel) => (await detectRegions(path)).map((region) => ({ ...region, channel, speaker: null })))))
        .flat().sort((a, b) => a.startMs - b.startMs || a.channel - b.channel);
    if (detected === null) return;
    if (detected.length === 0) {
      if (await failClaim(ctx, ctx.db, fence, "no_speech", "No speech was detected in the recording")) await cleanupJobFiles(ctx, job.id);
      else throw new LostFence(job.id);
      return;
    }
    await ctx.db.transaction(async (tx) => {
      await holdFence(tx, fence);
      await insertRegions(tx, fence, detected);
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

/**
 * Speaker turns of the mono mix (channel 0). A job whose diarization cannot run (the stage failed, or was switched off
 * after the job was accepted) fails processing_failed, fenced, and this returns null.
 */
async function diarizeTurns(ctx: BatchContext, job: TranscriptionRow, fence: Fence, pcmPath: string, signal: AbortSignal) {
  let segments: SpeakerSegment[];
  try {
    if (!ctx.diarizer) throw new Error("diarization is not available");
    segments = await ctx.diarizer.diarize(pcmPath, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    ctx.log.error("batch diarization failed", { transcriptionId: job.id, stage: "diarize", installed: ctx.diarizer !== null, alert: true });
    if (await failClaim(ctx, ctx.db, fence, "processing_failed", "Speaker diarization failed")) await cleanupJobFiles(ctx, job.id);
    else throw new LostFence(job.id);
    return null;
  }
  return speakerTurns(segments, await frameEnergies(pcmPath)).map((turn) => ({ ...turn, channel: 0 }));
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
): Promise<"done" | "terminal"> {
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
    if (settled === "done" || settled === "terminal") return settled;
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
  misconfigured: "rejected",
  ambiguous: "ambiguous",
};

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
): Promise<"done" | "retry" | "terminal" | "lost"> {
  const w = ctx.config.worker;
  const detail = outcome.kind === "ambiguous" || outcome.kind === "not_sent" ? outcome.reason
    : outcome.kind === "rejected" || outcome.kind === "misconfigured" ? `http_${outcome.status}` : null;
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
      await terminalize(tx, fence.id, fenceGuard(fence), "failed", { code, message });
      return "terminal" as const;
    };
    switch (outcome.kind) {
      case "ok":
        state.rateLimitStreak = 0;
        await tx.update(transcriptionRegions).set({ status: "completed", text: outcome.text }).where(regionWhere);
        await tx.update(transcriptions).set({ tinfoilAudioSeconds: sql`${transcriptions.tinfoilAudioSeconds} + ${(region.endMs - region.startMs) / 1000}` }).where(fenceGuard(fence));
        return "done" as const;
      case "rate_limited":
        state.rateLimitStreak++;
        if (state.rateLimitStreak >= w.maxConsecutiveRateLimits) return fail("provider_unavailable", "The transcription provider kept rejecting requests (rate limited)", "failed");
        return "retry" as const;
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
  if (result === "terminal") ctx.log.warn("batch job failed at dispatch", { transcriptionId: fence.id, outcome: outcome.kind, stage: "dispatch" });
  return result;
}

/** Builds the transcript from committed region rows and commits `completed` (or `no_speech`), fenced. */
async function assemble(ctx: BatchContext, job: TranscriptionRow, fence: Fence) {
  const committed = await ctx.db.transaction(async (tx) => {
    await holdFence(tx, fence);
    const regions = await tx.select().from(transcriptionRegions).where(eq(transcriptionRegions.transcriptionId, job.id))
      .orderBy(asc(transcriptionRegions.startMs), asc(transcriptionRegions.channel));
    if (regions.some((region) => region.status !== "completed")) throw new Error("assembly with unsettled regions");
    const channels = job.channelMode === "separate" && job.channels === 2 ? [0, 1] : [0];
    const spoken = regions.filter((region) => (region.text ?? "").trim() !== "");
    // A diarized job's speakers are numbered by first appearance among the turns with text: speaker_0, speaker_1, …
    const order = new Map<number, number>();
    if (job.diarize) for (const region of spoken) if (!order.has(region.speaker!)) order.set(region.speaker!, order.size);
    const speakers = job.diarize
      ? [...order.values()].map((n) => ({ id: `speaker_${n}`, name: `Speaker ${n + 1}`, channel: 0 }))
      : channels.map((channel) => ({ id: `channel_${channel}`, name: job.channelLabels[channel] ?? `Speaker ${channel + 1}`, channel }));
    const segments = spoken.map((region, index) => ({
      id: `seg_${String(index + 1).padStart(4, "0")}`,
      speaker_id: job.diarize ? `speaker_${order.get(region.speaker!)}` : `channel_${region.channel}`,
      channel: region.channel,
      start: region.startMs / 1000,
      end: region.endMs / 1000,
      text: region.text!.trim(),
    }));
    if (segments.length === 0) {
      return terminalize(tx, job.id, fenceGuard(fence), "failed", { code: "no_speech", message: "No speech was recognized in the recording" });
    }
    const [stats] = await tx.select({ calls: transcriptions.tinfoilCalls, seconds: transcriptions.tinfoilAudioSeconds }).from(transcriptions).where(eq(transcriptions.id, job.id));
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
        stats: { tinfoil_calls: stats!.calls, tinfoil_audio_seconds: Math.round(stats!.seconds * 1000) / 1000 },
      },
    });
    return terminalize(tx, job.id, fenceGuard(fence), "completed", null, {
      transcriptExpiresAt: new Date(Date.now() + ctx.config.retention.transcriptTtlSeconds * 1000),
    });
  });
  if (!committed) throw new LostFence(job.id);
  ctx.log.info("batch job finished", { transcriptionId: job.id, status: committed.status, code: committed.errorCode, stage: "assemble" });
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
