import { and, eq, gt, isNotNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { transcriptionAdmission, transcriptionCapabilities, transcriptions, type TranscriptionRow } from "../db/schema.ts";
import { TRANSCRIPTION_ID } from "../domain/ids.ts";
import { CAPABILITY_PREFIX, digestEquals, matchCapability } from "./capability.ts";
import type { UploadContentType } from "./config.ts";
import type { BatchContext } from "./context.ts";
import { BatchError, jobError, type JobErrorCode } from "./errors.ts";
import { isSimulatedCrash } from "./faults.ts";
import { cleanupJobFiles, terminalize } from "./ledger.ts";
import { probeAudio, syncDir } from "./audio.ts";
import { admissionMode } from "./service.ts";
import { audioName, createJobDir, diskUsedPercent, jobDir, tempUploadName } from "./storage.ts";

/**
 * `PUT /uploads/{id}` — the single post-acceptance contract (SPEC.md "Upload"):
 *
 * A PUT is accepted exactly once: 201 {status:"queued"} is returned only after the job row committed
 * awaiting_upload → queued. That same transaction deletes every capability of the job, so ANY later PUT
 * (including a replay after a lost 201) gets 401 upload_capability_invalid and changes nothing. There is
 * no "already received" answer: after a transport error or any non-201, the client learns the outcome
 * only from GET /v1/transcriptions/{id} — `awaiting_upload` means re-upload the whole file, anything
 * else means the upload was accepted (or the job ended).
 */
export async function handleUpload(ctx: BatchContext, id: string, request: Request): Promise<{ status: "queued" }> {
  if (!TRANSCRIPTION_ID.test(id)) throw new BatchError("upload_capability_invalid", "Invalid upload capability");
  const [scheme, token] = (request.headers.get("authorization") ?? "").split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token?.startsWith(CAPABILITY_PREFIX)) throw new BatchError("upload_capability_invalid", "Invalid upload capability");

  const caps = await ctx.db.select().from(transcriptionCapabilities).where(eq(transcriptionCapabilities.transcriptionId, id));
  const cap = matchCapability(token, caps);
  if (!cap) throw new BatchError("upload_capability_invalid", "Invalid upload capability");
  if (cap.expiresAt <= new Date()) throw new BatchError("upload_capability_expired", "The upload capability has expired");
  const [job] = await ctx.db.select().from(transcriptions).where(eq(transcriptions.id, id));
  if (!job || job.status !== "awaiting_upload" || job.tombstoned) throw new BatchError("upload_capability_invalid", "Invalid upload capability");

  if (await admissionMode(ctx.db) === "closed") throw new BatchError("service_paused", "Uploads are paused; try again later", { retry_after_seconds: 300 });
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader === null || !/^\d+$/.test(lengthHeader) || Number(lengthHeader) !== job.byteSize) {
    throw new BatchError("upload_length_mismatch", "Content-Length must equal the byte_size declared at create");
  }
  if ((request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() !== job.contentType) {
    throw new BatchError("unsupported_media_type", "Content-Type must equal the content_type declared at create");
  }
  if (!request.body) throw new BatchError("upload_length_mismatch", "The request has no body");
  const used = await diskUsedPercent(ctx.config.uploadDir);
  if (used >= ctx.config.limits.diskHighWaterPercent) {
    ctx.log.error("batch upload refused by disk high-water", { usedPercent: used, stage: "upload", alert: true });
    throw new BatchError("service_busy", "The service is at storage capacity; try again later", { retry_after_seconds: 300 });
  }

  const lease = await acquireUploadLease(ctx, job);
  const dir = jobDir(ctx.config.uploadDir, id);
  const tempPath = join(dir, tempUploadName(lease.token));
  const finalName = audioName(lease.token);
  const finalPath = join(dir, finalName);
  let committed = false;
  try {
    await createJobDir(ctx.config.uploadDir, id);
    const digest = await receiveBody(ctx, job, lease, request.body, tempPath);
    await ctx.faults.hit("upload.after_temp_write", { id });

    if (!digestEquals(digest, job.sha256)) {
      await failUpload(ctx, job, lease.token, "upload_integrity_failed", "The uploaded bytes do not match the declared sha256");
    }
    await ctx.faults.hit("upload.after_hash_verify", { id });

    const probed = await probeAudio(tempPath, job.contentType as UploadContentType, ctx.config.limits, ctx.config.ffprobePath);
    if (!probed.ok) await failUpload(ctx, job, lease.token, probed.code, probed.message);
    await ctx.faults.hit("upload.after_probe", { id });

    await rename(tempPath, finalPath);
    await syncDir(dir);
    await ctx.faults.hit("upload.after_rename", { id });

    const probe = (probed as { ok: true; probe: { durationSeconds: number; channels: number } }).probe;
    const accepted = await ctx.db.transaction(async (tx) => {
      // `closed` is a clean cut: the share lock orders this commit against PUT /v1/admin/admission, so once
      // closing has returned no further upload is accepted.
      const [admission] = await tx.select({ mode: transcriptionAdmission.mode }).from(transcriptionAdmission)
        .where(eq(transcriptionAdmission.id, 1)).for("share");
      if (admission?.mode === "closed") return "paused" as const;
      const [row] = await tx.update(transcriptions).set({
        status: "queued",
        audioFile: finalName,
        durationSeconds: probe.durationSeconds,
        channels: probe.channels,
        uploadedAt: sql`now()`,
        uploadLeaseToken: null,
        uploadLeaseStartedAt: null,
        uploadLeaseHeartbeatAt: null,
        uploadLeaseHardExpiresAt: null,
        updatedAt: sql`now()`,
      }).where(and(eq(transcriptions.id, id), eq(transcriptions.status, "awaiting_upload"), eq(transcriptions.uploadLeaseToken, lease.token), eq(transcriptions.tombstoned, false)))
        .returning({ id: transcriptions.id });
      if (!row) return false;
      // Capabilities die with awaiting_upload, atomically with acceptance.
      await tx.delete(transcriptionCapabilities).where(eq(transcriptionCapabilities.transcriptionId, id));
      return true;
    });
    if (accepted === "paused") throw new BatchError("service_paused", "Uploads were paused; try again later", { retry_after_seconds: 300 });
    if (!accepted) throw new BatchError("upload_capability_invalid", "The transcription is no longer accepting an upload");
    committed = true;
    await ctx.faults.hit("upload.after_commit", { id });
    ctx.log.info("batch upload accepted", { transcriptionId: id, stage: "upload" });
    return { status: "queued" };
  } catch (error) {
    if (isSimulatedCrash(error)) throw error; // a dead process cleans nothing up; recovery must
    if (!committed) {
      await rm(tempPath, { force: true });
      await rm(finalPath, { force: true });
      await releaseUploadLease(ctx, id, lease.token);
    }
    throw error;
  }
}

interface Lease {
  token: string;
  hardExpiresAt: Date;
}

/**
 * Takes the job's single upload lease, service-wide concurrency permitting. Serialized with creates on the
 * admission row. The hard expiry is min(now + maxPutSeconds, upload deadline) and is never extended.
 */
async function acquireUploadLease(ctx: BatchContext, job: TranscriptionRow): Promise<Lease> {
  const token = crypto.randomUUID().replaceAll("-", "");
  const now = Date.now();
  const hardExpiresAt = new Date(Math.min(now + ctx.config.upload.maxPutSeconds * 1000, job.uploadDeadlineAt.getTime()));
  if (hardExpiresAt.getTime() <= now) throw new BatchError("upload_capability_expired", "The upload deadline has passed");
  const staleBefore = new Date(now - ctx.config.upload.leaseStaleSeconds * 1000);
  return ctx.db.transaction(async (tx) => {
    await tx.select({ id: transcriptionAdmission.id }).from(transcriptionAdmission).where(eq(transcriptionAdmission.id, 1)).for("update");
    const [live] = await tx.select({ count: sql<number>`count(*)::int` }).from(transcriptions).where(and(
      eq(transcriptions.status, "awaiting_upload"),
      isNotNull(transcriptions.uploadLeaseToken),
      gt(transcriptions.uploadLeaseHeartbeatAt, staleBefore),
      gt(transcriptions.uploadLeaseHardExpiresAt, new Date(now)),
      sql`${transcriptions.id} <> ${job.id}`,
    ));
    if (Number(live!.count) >= ctx.config.limits.maxConcurrentUploads) {
      throw new BatchError("service_busy", "Too many uploads are in progress; try again shortly", { retry_after_seconds: 30 });
    }
    const [taken] = await tx.update(transcriptions).set({
      uploadLeaseToken: token,
      uploadLeaseStartedAt: new Date(now),
      uploadLeaseHeartbeatAt: new Date(now),
      uploadLeaseHardExpiresAt: hardExpiresAt,
    }).where(and(
      eq(transcriptions.id, job.id),
      eq(transcriptions.status, "awaiting_upload"),
      eq(transcriptions.tombstoned, false),
      sql`(${transcriptions.uploadLeaseToken} is null or ${transcriptions.uploadLeaseHeartbeatAt} <= ${staleBefore} or ${transcriptions.uploadLeaseHardExpiresAt} <= ${new Date(now)})`,
    )).returning({ id: transcriptions.id });
    if (!taken) {
      const [current] = await tx.select({ status: transcriptions.status }).from(transcriptions).where(eq(transcriptions.id, job.id));
      if (current?.status !== "awaiting_upload") throw new BatchError("upload_capability_invalid", "Invalid upload capability");
      throw new BatchError("upload_in_progress", "Another upload of this recording is in progress");
    }
    return { token, hardExpiresAt };
  });
}

async function releaseUploadLease(ctx: BatchContext, id: string, token: string) {
  await ctx.db.update(transcriptions).set({ uploadLeaseToken: null, uploadLeaseStartedAt: null, uploadLeaseHeartbeatAt: null, uploadLeaseHardExpiresAt: null })
    .where(and(eq(transcriptions.id, id), eq(transcriptions.uploadLeaseToken, token)));
}

/** Heartbeat under the lease CAS. Never moves the hard expiry. */
async function renewUploadLease(ctx: BatchContext, id: string, token: string): Promise<boolean> {
  const rows = await ctx.db.update(transcriptions).set({ uploadLeaseHeartbeatAt: sql`now()` })
    .where(and(eq(transcriptions.id, id), eq(transcriptions.status, "awaiting_upload"), eq(transcriptions.uploadLeaseToken, token), eq(transcriptions.tombstoned, false)))
    .returning({ id: transcriptions.id });
  return rows.length > 0;
}

const interrupted = (message: string) => new BatchError("upload_interrupted", message);

/**
 * Streams the body to a new temp file while hashing. Enforces: never more than byte_size bytes; an idle
 * timeout; an absolute hard expiry; and a minimum average rate after a grace period. Returns the hex digest.
 */
async function receiveBody(ctx: BatchContext, job: TranscriptionRow, lease: Lease, body: ReadableStream<Uint8Array>, tempPath: string): Promise<string> {
  const cfg = ctx.config.upload;
  const handle = await open(tempPath, "wx", 0o600);
  const reader = body.getReader();
  const hash = createHash("sha256");
  const started = Date.now();
  let received = 0;
  let lastHeartbeat = started;
  try {
    for (;;) {
      const remainingHard = lease.hardExpiresAt.getTime() - Date.now();
      if (remainingHard <= 0) throw interrupted("The upload exceeded its maximum duration");
      const wait = Math.min(cfg.idleTimeoutSeconds * 1000, remainingHard);
      let timer: Timer | undefined;
      const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), wait); });
      let next: Awaited<ReturnType<typeof reader.read>> | "timeout";
      try {
        next = await Promise.race([reader.read(), timedOut]);
      } catch {
        throw interrupted("The upload connection was interrupted");
      } finally {
        clearTimeout(timer);
      }
      if (next === "timeout") {
        throw interrupted(remainingHard <= wait ? "The upload exceeded its maximum duration" : "The upload stalled");
      }
      if (next.done) break;
      const chunk = next.value;
      received += chunk.byteLength;
      if (received > job.byteSize) throw new BatchError("upload_length_mismatch", "The body is longer than the declared byte_size");
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) offset += (await handle.write(chunk, offset, chunk.byteLength - offset)).bytesWritten;
      const now = Date.now();
      const elapsed = (now - started) / 1000;
      if (elapsed > cfg.progressGraceSeconds && received < cfg.minBytesPerSecond * elapsed) {
        throw interrupted("The upload is too slow");
      }
      if (now - lastHeartbeat >= cfg.leaseHeartbeatSeconds * 1000) {
        // `closed` stops uploads already in flight too (within one heartbeat); the job stays awaiting_upload.
        if (await admissionMode(ctx.db) === "closed") throw new BatchError("service_paused", "Uploads were paused; try again later", { retry_after_seconds: 300 });
        if (!await renewUploadLease(ctx, job.id, lease.token)) throw new BatchError("upload_capability_invalid", "The transcription is no longer accepting an upload");
        lastHeartbeat = now;
      }
    }
    if (received !== job.byteSize) throw interrupted("The upload ended before byte_size bytes were received");
    await handle.sync();
    return hash.digest("hex");
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

/** Terminal failure detected while validating an upload. Always throws the 422 for the response. */
async function failUpload(ctx: BatchContext, job: TranscriptionRow, token: string, code: JobErrorCode, message: string): Promise<never> {
  const failed = await terminalize(ctx.db, job.id, eq(transcriptions.uploadLeaseToken, token), "failed", { code, message });
  if (!failed) throw new BatchError("upload_capability_invalid", "The transcription is no longer accepting an upload");
  await cleanupJobFiles(ctx, job.id);
  ctx.log.warn("batch upload rejected", { transcriptionId: job.id, code, stage: "upload" });
  throw new BatchError("upload_rejected", message, { status: "failed", job_error: jobError(code, message)! });
}
