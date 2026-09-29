import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { providerDispatchSlots, transcriptionAttempts, transcriptionCapabilities, transcriptionRegions, transcriptionResults, transcriptions, transcriptionTenantUsage, transcriptionWorkers, type TranscriptionRow } from "../db/schema.ts";
import type { BatchContext } from "./context.ts";
import { isSimulatedCrash } from "./faults.ts";
import type { DbOrTx } from "./fence.ts";
import type { JobErrorCode } from "./errors.ts";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { audioName, jobDir, listJobDirs, listJobEntries, removeJobArtifacts, removeJobEntry, tempUploadName, workDirName } from "./storage.ts";

export const ACTIVE_STATUSES = ["awaiting_upload", "queued", "processing"] as const;
export const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;
export const isActive = (status: string) => (ACTIVE_STATUSES as readonly string[]).includes(status);

const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);

/**
 * The only way a job becomes terminal. In one statement it records the terminal state AND
 * deletion_state='pending' (the ledger entry) before any file is unlinked, bumps the fencing generation,
 * and drops every claim and upload lease; its capabilities are deleted in the same transaction. `guard`
 * is the caller's compare-and-swap. Returns null when the guard lost.
 *
 * A failed or cancelled job has no transcript to serve, so any region text it already holds (partial
 * content) is deleted right away and transcript_deleted_at is recorded; only a completed job keeps text,
 * until DELETE or its 24 h expiry. The sweeper re-runs this for a job whose caller died in between.
 */
export async function terminalize(
  tx: DbOrTx,
  id: string,
  guard: SQL,
  status: "completed" | "failed" | "cancelled",
  error: { code: JobErrorCode; message: string } | null,
  extra: Partial<typeof transcriptions.$inferInsert> = {},
): Promise<TranscriptionRow | null> {
  const [row] = await tx.update(transcriptions).set({
    status,
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
    terminalAt: sql`now()`,
    deletionState: "pending",
    generation: sql`${transcriptions.generation} + 1`,
    claimToken: null,
    claimOwnerId: null,
    claimHeartbeatAt: null,
    uploadLeaseToken: null,
    uploadLeaseStartedAt: null,
    uploadLeaseHeartbeatAt: null,
    uploadLeaseHardExpiresAt: null,
    updatedAt: sql`now()`,
    ...extra,
  }).where(and(eq(transcriptions.id, id), inArray(transcriptions.status, [...ACTIVE_STATUSES]), guard)).returning();
  if (!row) return null;
  await tx.delete(transcriptionCapabilities).where(eq(transcriptionCapabilities.transcriptionId, id));
  if (status !== "completed") await deleteTranscriptContent(tx, id);
  return row;
}

/**
 * Unlinks every artifact of a terminal job, verifies ENOENT, then records files_deleted. Safe to call
 * any number of times, from any process; a failed unlink stays pending for the sweeper.
 */
export async function cleanupJobFiles(ctx: BatchContext, id: string): Promise<boolean> {
  const [row] = await ctx.db.select({ deletionState: transcriptions.deletionState }).from(transcriptions).where(eq(transcriptions.id, id));
  if (!row || row.deletionState !== "pending") return false;
  let verified = false;
  try {
    verified = await removeJobArtifacts(ctx.config.uploadDir, id);
    await ctx.faults.hit("deletion.after_unlink", { id });
  } catch (error) {
    if (isSimulatedCrash(error)) throw error;
    verified = false;
  }
  if (!verified) {
    // Bookkeeping only, but still a compare-and-swap: it counts only while the deletion is pending.
    await ctx.db.update(transcriptions).set({ deletionAttempts: sql`${transcriptions.deletionAttempts} + 1` })
      .where(and(eq(transcriptions.id, id), eq(transcriptions.deletionState, "pending")));
    ctx.log.error("batch artifact deletion failed", { transcriptionId: id, stage: "deletion", alert: true });
    return false;
  }
  const [done] = await ctx.db.update(transcriptions).set({ deletionState: "files_deleted", filesDeletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(transcriptions.id, id), eq(transcriptions.deletionState, "pending"), inArray(transcriptions.status, [...TERMINAL_STATUSES])))
    .returning({ id: transcriptions.id });
  return !!done;
}

/** Age in seconds of the oldest terminal job whose files are not yet verified deleted (0 when none). */
export async function retentionLagSeconds(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ oldest: sql<Date | null>`min(${transcriptions.terminalAt})` }).from(transcriptions)
    .where(eq(transcriptions.deletionState, "pending"));
  const oldest = row?.oldest ? new Date(row.oldest) : null;
  return oldest ? Math.max(0, Math.floor((Date.now() - oldest.getTime()) / 1000)) : 0;
}

export async function workerLive(ctx: BatchContext, db: DbOrTx = ctx.db, ownerId?: string): Promise<boolean> {
  const rows = await db.select({ id: transcriptionWorkers.id }).from(transcriptionWorkers)
    .where(and(sql`${transcriptionWorkers.observedAt} >= ${secondsAgo(ctx.config.worker.workerStaleSeconds)}`, ownerId ? eq(transcriptionWorkers.id, ownerId) : undefined))
    .limit(1);
  return rows.length > 0;
}

/**
 * Recovers processing jobs whose claim heartbeat is stale. A job with a
 * `started` provider attempt had a paid call in flight when its owner died: that attempt is ambiguous and
 * is never re-sent, so the job fails provider_outcome_unknown. Otherwise no call was in flight and the
 * job is requeued (regions and completed results are kept), up to maxClaims.
 */
export async function recoverStaleClaims(ctx: BatchContext): Promise<void> {
  const stale = await ctx.db.select({ id: transcriptions.id }).from(transcriptions)
    .where(and(eq(transcriptions.status, "processing"), or(isNull(transcriptions.claimHeartbeatAt), lt(transcriptions.claimHeartbeatAt, secondsAgo(ctx.config.worker.claimStaleSeconds)))));
  for (const candidate of stale) {
    // A live processClaim renews its claim every claimRenewSeconds even during a provider call, so a stale
    // claim means the claim holder stopped (crashed or exited abnormally) whether or not its process lives.
    const terminal = await ctx.db.transaction(async (tx) => {
      const [job] = await tx.select().from(transcriptions).where(eq(transcriptions.id, candidate.id)).for("update");
      if (!job || job.status !== "processing" || (job.claimHeartbeatAt && job.claimHeartbeatAt > secondsAgo(ctx.config.worker.claimStaleSeconds))) return null;
      const started = await tx.select().from(transcriptionAttempts)
        .where(and(eq(transcriptionAttempts.transcriptionId, job.id), eq(transcriptionAttempts.status, "started")));
      const guard = and(eq(transcriptions.generation, job.generation))!;
      if (started.length > 0) {
        await tx.update(transcriptionAttempts).set({ status: "ambiguous", outcome: "owner_lost", completedAt: sql`now()` })
          .where(and(eq(transcriptionAttempts.transcriptionId, job.id), eq(transcriptionAttempts.status, "started")));
        await tx.update(transcriptionRegions).set({ status: "ambiguous" })
          .where(and(eq(transcriptionRegions.transcriptionId, job.id), inArray(transcriptionRegions.ordinal, started.map((a) => a.regionOrdinal))));
        await releaseDeadSlot(ctx, tx, started.map((a) => a.id));
        return terminalize(tx, job.id, guard, "failed", { code: "provider_outcome_unknown", message: "The worker stopped while a transcription request was in flight; it is not retried to avoid a duplicate paid request" });
      }
      if (job.claimCount >= ctx.config.worker.maxClaims) {
        return terminalize(tx, job.id, guard, "failed", { code: "processing_failed", message: "Processing was interrupted too many times" });
      }
      await tx.update(transcriptions).set({ status: "queued", generation: sql`${transcriptions.generation} + 1`, claimToken: null, claimOwnerId: null, claimHeartbeatAt: null, updatedAt: sql`now()` })
        .where(and(eq(transcriptions.id, job.id), eq(transcriptions.status, "processing"), guard));
      return null;
    });
    if (terminal) {
      ctx.log.warn("batch claim recovered", { transcriptionId: terminal.id, code: terminal.errorCode, stage: "claim_recovery" });
      await cleanupJobFiles(ctx, terminal.id);
    }
  }
}

/**
 * Frees the dispatch slot iff it holds one of `attemptIds` and its owning process is dead. While the owner
 * lives, its call may still be in flight, so the slot stays held until that owner settles it.
 */
export async function releaseDeadSlot(ctx: BatchContext, tx: DbOrTx, attemptIds: string[]) {
  const [slot] = await tx.select().from(providerDispatchSlots).where(eq(providerDispatchSlots.id, 1)).for("update");
  if (!slot?.attemptId || !attemptIds.includes(slot.attemptId)) return;
  if (slot.ownerId && await workerLive(ctx, tx, slot.ownerId)) return;
  await tx.update(providerDispatchSlots).set({ attemptId: null, transcriptionId: null, ownerId: null, claimedAt: null }).where(eq(providerDispatchSlots.id, 1));
}

/**
 * Periodic reconciliation (every 60 s in the worker process). Each step is idempotent and independently
 * retried on the next pass.
 */
export async function runSweep(ctx: BatchContext): Promise<void> {
  const now = new Date();
  // 1. Upload deadline (absolute, from create).
  const expired = await ctx.db.select({ id: transcriptions.id }).from(transcriptions)
    .where(and(eq(transcriptions.status, "awaiting_upload"), lt(transcriptions.uploadDeadlineAt, now)));
  for (const { id } of expired) {
    const row = await terminalize(ctx.db, id, and(eq(transcriptions.status, "awaiting_upload"), lt(transcriptions.uploadDeadlineAt, now))!, "failed", { code: "upload_expired", message: "The recording was not uploaded before the upload deadline" });
    if (row) await cleanupJobFiles(ctx, id);
  }
  // 2. Dead upload leases (their temp files are removed by step 7).
  await ctx.db.update(transcriptions).set({ uploadLeaseToken: null, uploadLeaseStartedAt: null, uploadLeaseHeartbeatAt: null, uploadLeaseHardExpiresAt: null })
    .where(and(eq(transcriptions.status, "awaiting_upload"), isNotNull(transcriptions.uploadLeaseToken), or(
      lt(transcriptions.uploadLeaseHeartbeatAt, secondsAgo(ctx.config.upload.leaseStaleSeconds)),
      lt(transcriptions.uploadLeaseHardExpiresAt, now),
    )));
  // 3. Processing ceiling. The generation bump fences out the worker; an in-flight provider call keeps
  //    the slot until the worker settles it (or its process is found dead).
  const overdue = await ctx.db.select({ id: transcriptions.id }).from(transcriptions)
    .where(and(eq(transcriptions.status, "processing"), lt(transcriptions.processingStartedAt, secondsAgo(ctx.config.worker.maxProcessingSeconds))));
  for (const { id } of overdue) {
    const row = await terminalize(ctx.db, id, eq(transcriptions.status, "processing"), "failed", { code: "processing_timeout", message: "Processing exceeded the maximum duration" });
    if (row) await cleanupJobFiles(ctx, id);
  }
  // 4. Claims whose owner died.
  await recoverStaleClaims(ctx);
  // 5. Pending deletions (retries failed unlinks).
  const pending = await ctx.db.select({ id: transcriptions.id }).from(transcriptions)
    .where(and(eq(transcriptions.deletionState, "pending"), inArray(transcriptions.status, [...TERMINAL_STATUSES]))).orderBy(asc(transcriptions.terminalAt));
  for (const { id } of pending) await cleanupJobFiles(ctx, id);
  // 6. Transcript expiry: 24 h after completion unless deleted earlier. Failed/cancelled jobs lose any
  //    partial text at their terminal transition; this also finishes one whose caller died in between.
  const due = await ctx.db.select({ id: transcriptions.id }).from(transcriptions).where(and(
    isNull(transcriptions.transcriptDeletedAt),
    or(
      and(eq(transcriptions.status, "completed"), lt(transcriptions.transcriptExpiresAt, now)),
      inArray(transcriptions.status, ["failed", "cancelled"]),
    ),
  ));
  for (const { id } of due) await deleteTranscriptContent(ctx.db, id);
  // 7. Directory reconciliation: anything on disk that the ledger does not currently authorize goes.
  await reconcileDirectories(ctx);
  // 8. Purge tombstones and finished rows 7 days after their files were verified deleted.
  const cutoff = secondsAgo(ctx.config.retention.tombstoneRetentionSeconds);
  await ctx.db.delete(transcriptions).where(and(
    eq(transcriptions.deletionState, "files_deleted"),
    lt(transcriptions.filesDeletedAt, cutoff),
    or(eq(transcriptions.tombstoned, true), sql`${transcriptions.status} <> 'completed'`, isNotNull(transcriptions.transcriptDeletedAt)),
  ));
  await ctx.db.delete(transcriptionTenantUsage).where(lt(transcriptionTenantUsage.day, new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)));
}

/** Deletes transcript content (result row + region text) and records when. */
export async function deleteTranscriptContent(db: DbOrTx, id: string) {
  await db.delete(transcriptionResults).where(eq(transcriptionResults.transcriptionId, id));
  await db.update(transcriptionRegions).set({ text: null }).where(eq(transcriptionRegions.transcriptionId, id));
  await db.update(transcriptions).set({ transcriptDeletedAt: sql`coalesce(${transcriptions.transcriptDeletedAt}, now())`, updatedAt: sql`now()` })
    .where(eq(transcriptions.id, id));
}

async function reconcileDirectories(ctx: BatchContext) {
  const root = ctx.config.uploadDir;
  for (const id of await listJobDirs(root)) {
    // Fresh read per directory: a PUT may have taken a lease since the pass started.
    const [row] = await ctx.db.select().from(transcriptions).where(eq(transcriptions.id, id));
    if (!row || !isActive(row.status)) {
      if (row?.deletionState === "pending") continue; // step 5 owns it
      if (row?.deletionState === "files_deleted") ctx.log.error("batch artifact reappeared after verified deletion", { transcriptionId: id, stage: "reconcile", alert: true });
      await removeJobArtifacts(root, id);
      continue;
    }
    const allowed = new Set<string>();
    if (row.status === "awaiting_upload" && row.uploadLeaseToken) {
      allowed.add(tempUploadName(row.uploadLeaseToken));
      allowed.add(audioName(row.uploadLeaseToken)); // a PUT between rename and commit
    }
    if ((row.status === "queued" || row.status === "processing") && row.audioFile) allowed.add(row.audioFile);
    if (row.status === "processing") allowed.add(workDirName(row.generation));
    // Unauthorized entries of an active job are reaped once older than a dead lease, so a request that
    // is creating its file right now is never raced; a crashed one's leftovers go on a later pass.
    const staleBefore = Date.now() - ctx.config.upload.leaseStaleSeconds * 1000;
    for (const entry of await listJobEntries(root, id)) {
      if (allowed.has(entry)) continue;
      const modified = await lstat(join(jobDir(root, id), entry)).then((s) => s.mtimeMs, () => null);
      if (modified !== null && modified < staleBefore) await removeJobEntry(root, id, entry);
    }
  }
}

