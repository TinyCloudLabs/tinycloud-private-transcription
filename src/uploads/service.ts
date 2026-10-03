import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  transcriptionAdmission,
  transcriptionCapabilities,
  transcriptionRegions,
  transcriptionResults,
  transcriptions,
  transcriptionTenantUsage,
  type TranscriptionRow,
} from "../db/schema.ts";
import { newTranscriptionId } from "../domain/ids.ts";
import { generateCapability, hashCapability } from "./capability.ts";
import { CONTENT_TYPES, type UploadContentType } from "./config.ts";
import type { BatchContext } from "./context.ts";
import { BatchError, jobError } from "./errors.ts";
import type { DbOrTx } from "./fence.ts";
import { ACTIVE_STATUSES, cleanupJobFiles, deleteTranscriptContent, isActive, retentionLagSeconds, terminalize, workerLive } from "./ledger.ts";
import { diskUsedPercent } from "./storage.ts";

export const TENANT_REF = /^[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const LABEL = /^[^\u0000-\u001f\u007f]{1,64}$/;
export const ADMISSION_MODES = ["open", "drain", "closed"] as const;
export type AdmissionMode = (typeof ADMISSION_MODES)[number];

export interface CreateTranscriptionInput {
  content_type: UploadContentType;
  byte_size: number;
  sha256: string;
  language: string | null;
  channel_mode: "separate" | "mixed";
  channel_labels: string[];
  /** Downmix to mono and label speaker turns (contract C2). Only accepted when `diarizationAvailable`. */
  diarize: boolean;
}

const CREATE_FIELDS = ["content_type", "byte_size", "sha256", "language", "channel_mode", "channel_labels", "diarize"];

export function parseCreateBody(raw: unknown, maxBytes: number): CreateTranscriptionInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BatchError("invalid_request", "Request body must be a JSON object");
  const body = raw as Record<string, unknown>;
  const extra = Object.keys(body).filter((key) => !CREATE_FIELDS.includes(key));
  if (extra.length) throw new BatchError("invalid_request", `Unknown field(s): ${extra.join(", ")}`);
  if (!(CONTENT_TYPES as readonly unknown[]).includes(body.content_type)) {
    throw new BatchError("invalid_request", `content_type must be one of ${CONTENT_TYPES.join(", ")}`);
  }
  if (typeof body.byte_size !== "number" || !Number.isSafeInteger(body.byte_size) || body.byte_size < 1) {
    throw new BatchError("invalid_request", "byte_size must be a positive integer");
  }
  if (body.byte_size > maxBytes) throw new BatchError("recording_too_large", `byte_size must be at most ${maxBytes}`);
  if (typeof body.sha256 !== "string" || !SHA256.test(body.sha256)) throw new BatchError("invalid_request", "sha256 must be 64 lowercase hex characters");
  const language = body.language ?? null;
  if (language !== null && (typeof language !== "string" || language.length > 35 || !LANGUAGE.test(language))) {
    throw new BatchError("invalid_request", "language must be a BCP-47 language tag such as en or pt-BR");
  }
  const diarize = body.diarize ?? false;
  if (typeof diarize !== "boolean") throw new BatchError("invalid_request", "diarize must be a boolean");
  // Diarization works on a mono downmix, so it defaults to mixed and cannot be combined with separate channels.
  const channelMode = body.channel_mode ?? (diarize ? "mixed" : "separate");
  if (channelMode !== "separate" && channelMode !== "mixed") throw new BatchError("invalid_request", "channel_mode must be separate or mixed");
  if (diarize && channelMode === "separate") throw new BatchError("invalid_request", "diarize cannot be combined with channel_mode separate");
  const labels = body.channel_labels ?? ["Speaker 1", "Speaker 2"];
  if (!Array.isArray(labels) || labels.length < 1 || labels.length > 2 || !labels.every((label) => typeof label === "string" && LABEL.test(label))) {
    throw new BatchError("invalid_request", "channel_labels must be 1 or 2 strings of 1 to 64 printable characters");
  }
  return {
    content_type: body.content_type as UploadContentType, byte_size: body.byte_size, sha256: body.sha256, language, channel_mode: channelMode,
    channel_labels: labels as string[], diarize,
  };
}

const canonical = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
      : JSON.stringify(value);
/**
 * The tenant is part of the hash: replaying another tenant's key is an idempotency_conflict, never a read.
 * `diarize: false` is left out so the hash of every request made before the field existed is unchanged.
 */
export const hashCreateRequest = ({ diarize, ...input }: CreateTranscriptionInput, tenantRef: string) =>
  createHash("sha256").update(canonical({ ...input, ...(diarize ? { diarize } : {}), tenant_ref: tenantRef })).digest("hex");

/** Whether this deployment can diarize: enabled, and the sherpa-onnx install is present (src/uploads/diarize.ts). */
export const diarizationAvailable = (ctx: BatchContext): boolean => ctx.diarizer !== null;

export async function readiness(ctx: BatchContext) {
  const providerConfigured = ctx.provider !== null;
  const live = await workerLive(ctx);
  return { providerConfigured, workerLive: live, ready: providerConfigured && live };
}

export async function admissionMode(db: DbOrTx): Promise<AdmissionMode> {
  const [row] = await db.select({ mode: transcriptionAdmission.mode }).from(transcriptionAdmission).where(eq(transcriptionAdmission.id, 1));
  if (!row) throw new Error("transcription_admission row is missing (migration 0017 not applied)");
  return row.mode as AdmissionMode;
}

export async function setAdmissionMode(ctx: BatchContext, mode: AdmissionMode) {
  await ctx.db.update(transcriptionAdmission).set({ mode, updatedAt: sql`now()` }).where(eq(transcriptionAdmission.id, 1));
  ctx.log.warn("batch admission mode changed", { mode, stage: "admission" });
}

export async function activeCounts(db: DbOrTx) {
  const rows = await db.select({ status: transcriptions.status, count: sql<number>`count(*)::int` }).from(transcriptions)
    .where(inArray(transcriptions.status, [...ACTIVE_STATUSES])).groupBy(transcriptions.status);
  const counts = { awaiting_upload: 0, queued: 0, processing: 0 };
  for (const row of rows) counts[row.status as keyof typeof counts] = Number(row.count);
  return counts;
}

const utcDay = () => new Date().toISOString().slice(0, 10);
const secondsToUtcMidnight = () => {
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - Date.now()) / 1000));
};

export interface IssuedCapability {
  path: string;
  capability: string;
  expires_at: string;
  max_live: number;
}

/** Issues one more capability for a job still awaiting upload. Never revokes an earlier one. */
async function issueCapability(ctx: BatchContext, tx: DbOrTx, job: TranscriptionRow): Promise<IssuedCapability> {
  const now = new Date();
  await tx.delete(transcriptionCapabilities).where(and(eq(transcriptionCapabilities.transcriptionId, job.id), lt(transcriptionCapabilities.expiresAt, now)));
  const live = await tx.select({ expiresAt: transcriptionCapabilities.expiresAt }).from(transcriptionCapabilities)
    .where(eq(transcriptionCapabilities.transcriptionId, job.id)).orderBy(asc(transcriptionCapabilities.expiresAt));
  const max = ctx.config.upload.maxLiveCapabilities;
  if (live.length >= max) {
    throw new BatchError("upload_capability_limit", `At most ${max} upload capabilities may be live for one transcription`, {
      retry_after_seconds: Math.max(1, Math.ceil((live[0]!.expiresAt.getTime() - now.getTime()) / 1000)),
    });
  }
  const token = generateCapability();
  const expiresAt = new Date(Math.min(now.getTime() + ctx.config.upload.capabilityTtlSeconds * 1000, job.uploadDeadlineAt.getTime()));
  await tx.insert(transcriptionCapabilities).values({ id: `cap_${crypto.randomUUID()}`, transcriptionId: job.id, tokenHash: hashCapability(token), expiresAt });
  return { path: `/uploads/${job.id}`, capability: token, expires_at: expiresAt.toISOString(), max_live: max };
}

export interface CreateResult {
  job: TranscriptionRow;
  created: boolean;
  upload: IssuedCapability | null;
}

/**
 * Create (or idempotently replay) a job. All admission decisions happen in one transaction that holds the
 * transcription_admission row lock, so concurrent creates are serialized and every bound is exact:
 *   - admission mode must be open
 *   - one active job per (project, tenant_ref) (also a partial unique index)
 *   - service-wide active jobs (awaiting_upload + queued + processing) <= maxActiveJobs
 *   - service-wide declared bytes of those jobs + byte_size <= maxReservedBytes
 *   - tenant daily bytes (conditional UPDATE) <= tenantDailyBytes
 * The reservation is the job row itself: it is released only by a terminal transition (terminalize).
 */
export async function createTranscription(
  ctx: BatchContext,
  projectId: string,
  tenantRef: string,
  idempotencyKey: string,
  input: CreateTranscriptionInput,
): Promise<CreateResult> {
  if (input.diarize && !diarizationAvailable(ctx)) {
    throw new BatchError("diarization_unavailable", "Speaker diarization is not available on this service");
  }
  const requestHash = hashCreateRequest(input, tenantRef);
  if (await replayCreate(ctx, ctx.db, projectId, idempotencyKey, requestHash, false)) {
    const replayed = await ctx.db.transaction((tx) => replayCreate(ctx, tx, projectId, idempotencyKey, requestHash, true));
    if (replayed) return replayed;
    // The row was purged between the two reads (only possible 7 days after its files were deleted): the key
    // is free again, so this is an ordinary create and takes every admission check below.
  }

  const ready = await readiness(ctx);
  if (!ready.ready) {
    throw new BatchError("service_unavailable", ready.providerConfigured ? "The transcription worker is not running" : "The transcription provider is not configured");
  }
  const used = await diskUsedPercent(ctx.config.uploadDir);
  if (used >= ctx.config.limits.diskHighWaterPercent) {
    ctx.log.error("batch admission stopped by disk high-water", { usedPercent: used, stage: "admission", alert: true });
    throw new BatchError("service_busy", "The service is at storage capacity; try again later", { retry_after_seconds: 300 });
  }

  try {
    return await ctx.db.transaction(async (tx) => {
      const [admission] = await tx.select({ mode: transcriptionAdmission.mode }).from(transcriptionAdmission).where(eq(transcriptionAdmission.id, 1)).for("update");
      if (!admission) throw new Error("transcription_admission row is missing (migration 0017 not applied)");
      const replayed = await replayCreate(ctx, tx, projectId, idempotencyKey, requestHash, true);
      if (replayed) return replayed;
      if (admission.mode !== "open") throw new BatchError("service_paused", "New transcriptions are paused; try again later", { retry_after_seconds: 300 });

      const [active] = await tx.select({ id: transcriptions.id }).from(transcriptions)
        .where(and(eq(transcriptions.projectId, projectId), eq(transcriptions.tenantRef, tenantRef), inArray(transcriptions.status, [...ACTIVE_STATUSES]))).limit(1);
      if (active) throw new BatchError("active_transcription_exists", "This account already has a transcription in progress", { id: active.id });

      const [totals] = await tx.select({ jobs: sql<number>`count(*)::int`, bytes: sql<string>`coalesce(sum(${transcriptions.byteSize}), 0)::text` })
        .from(transcriptions).where(inArray(transcriptions.status, [...ACTIVE_STATUSES]));
      const limits = ctx.config.limits;
      if (Number(totals!.jobs) >= limits.maxActiveJobs || Number(totals!.bytes) + input.byte_size > limits.maxReservedBytes) {
        throw new BatchError("service_busy", "The service is at capacity; try again later", { retry_after_seconds: 60 });
      }

      const day = utcDay();
      await tx.insert(transcriptionTenantUsage).values({ projectId, tenantRef, day, bytes: 0 }).onConflictDoNothing();
      const charged = await tx.update(transcriptionTenantUsage).set({ bytes: sql`${transcriptionTenantUsage.bytes} + ${input.byte_size}` })
        .where(and(eq(transcriptionTenantUsage.projectId, projectId), eq(transcriptionTenantUsage.tenantRef, tenantRef), eq(transcriptionTenantUsage.day, day),
          sql`${transcriptionTenantUsage.bytes} + ${input.byte_size} <= ${limits.tenantDailyBytes}`))
        .returning({ bytes: transcriptionTenantUsage.bytes });
      if (charged.length === 0) throw new BatchError("quota_exceeded", "The daily transcription allowance for this account is used up", { retry_after_seconds: secondsToUtcMidnight() });

      const [job] = await tx.insert(transcriptions).values({
        id: newTranscriptionId(),
        projectId,
        tenantRef,
        status: "awaiting_upload",
        idempotencyKey,
        requestHash,
        contentType: input.content_type,
        byteSize: input.byte_size,
        sha256: input.sha256,
        language: input.language,
        channelMode: input.channel_mode,
        channelLabels: input.channel_labels,
        diarize: input.diarize,
        uploadDeadlineAt: new Date(Date.now() + ctx.config.upload.deadlineSeconds * 1000),
      }).returning();
      return { job: job!, created: true, upload: await issueCapability(ctx, tx, job!) };
    });
  } catch (error) {
    // The partial unique index is the backstop for the per-tenant check above (drizzle wraps the driver error).
    const cause = (error as { cause?: { errno?: string; constraint?: string } })?.cause;
    if (cause?.errno === "23505" && cause.constraint === "transcriptions_one_active_per_tenant_idx") {
      const [active] = await ctx.db.select({ id: transcriptions.id }).from(transcriptions)
        .where(and(eq(transcriptions.projectId, projectId), eq(transcriptions.tenantRef, tenantRef), inArray(transcriptions.status, [...ACTIVE_STATUSES]))).limit(1);
      if (active) throw new BatchError("active_transcription_exists", "This account already has a transcription in progress", { id: active.id });
    }
    throw error;
  }
}

async function replayCreate(ctx: BatchContext, db: DbOrTx, projectId: string, key: string, requestHash: string, issue: boolean): Promise<CreateResult | null> {
  const lookup = db.select().from(transcriptions)
    .where(and(eq(transcriptions.projectId, projectId), eq(transcriptions.idempotencyKey, key))).limit(1);
  // Issuing locks the job row, so concurrent replays count and insert live capabilities one at a time (and the
  // status check sees a committed upload). Lock order matches every other path: admission row, then job row.
  const [existing] = issue ? await lookup.for("update") : await lookup;
  if (!existing) return null;
  if (existing.requestHash !== requestHash) throw new BatchError("idempotency_conflict", "Idempotency-Key was already used with a different request");
  if (existing.tombstoned) throw new BatchError("transcription_not_found", "No such transcription");
  if (!issue) return { job: existing, created: false, upload: null };
  const upload = existing.status === "awaiting_upload" && existing.uploadDeadlineAt > new Date() ? await issueCapability(ctx, db, existing) : null;
  return { job: existing, created: false, upload };
}

/** Tenant-scoped lookup. Missing, other-tenant and tombstoned jobs are all the same 404. */
export async function getJob(ctx: BatchContext, projectId: string, tenantRef: string, id: string): Promise<TranscriptionRow> {
  const [row] = await ctx.db.select().from(transcriptions)
    .where(and(eq(transcriptions.id, id), eq(transcriptions.projectId, projectId), eq(transcriptions.tenantRef, tenantRef), eq(transcriptions.tombstoned, false))).limit(1);
  if (!row) throw new BatchError("transcription_not_found", "No such transcription");
  return row;
}

export async function getJobByIdempotencyKey(ctx: BatchContext, projectId: string, tenantRef: string, key: string) {
  const [row] = await ctx.db.select().from(transcriptions)
    .where(and(eq(transcriptions.projectId, projectId), eq(transcriptions.idempotencyKey, key), eq(transcriptions.tenantRef, tenantRef), eq(transcriptions.tombstoned, false))).limit(1);
  if (!row) throw new BatchError("transcription_not_found", "No such transcription");
  return row;
}

export async function listJobs(ctx: BatchContext, projectId: string, tenantRef: string, limit: number) {
  return ctx.db.select().from(transcriptions)
    .where(and(eq(transcriptions.projectId, projectId), eq(transcriptions.tenantRef, tenantRef), eq(transcriptions.tombstoned, false)))
    .orderBy(desc(transcriptions.createdAt)).limit(limit);
}

/** Cancel: transactional terminal transition (generation bump fences the worker), then file cleanup. Idempotent. */
export async function cancelJob(ctx: BatchContext, job: TranscriptionRow): Promise<TranscriptionRow> {
  const cancelled = await terminalize(ctx.db, job.id, eq(transcriptions.tombstoned, false), "cancelled", { code: "cancelled", message: "Cancelled by the caller" });
  if (cancelled) {
    await cleanupJobFiles(ctx, job.id);
    return cancelled;
  }
  const [current] = await ctx.db.select().from(transcriptions).where(eq(transcriptions.id, job.id));
  return current ?? job;
}

/**
 * DELETE: in one transaction an active job is cancelled, the row becomes a tombstone (hidden from every
 * read), the generation is bumped, and transcript content is deleted. Files follow via the ledger; the
 * tombstone (ids, sizes, timings, codes) is purged 7 days after the files are verified gone.
 */
export async function deleteJob(ctx: BatchContext, job: TranscriptionRow): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(transcriptions).where(eq(transcriptions.id, job.id)).for("update");
    if (!locked || locked.tombstoned) throw new BatchError("transcription_not_found", "No such transcription");
    if (isActive(locked.status)) {
      await terminalize(tx, job.id, eq(transcriptions.generation, locked.generation), "cancelled", { code: "cancelled", message: "Deleted by the caller" });
    }
    await tx.update(transcriptions).set({ tombstoned: true, tombstonedAt: sql`now()`, generation: sql`${transcriptions.generation} + 1`, updatedAt: sql`now()` })
      .where(eq(transcriptions.id, job.id));
    await deleteTranscriptContent(tx, job.id);
  });
  await cleanupJobFiles(ctx, job.id);
}

export async function getResult(ctx: BatchContext, id: string) {
  const [row] = await ctx.db.select().from(transcriptionResults).where(eq(transcriptionResults.transcriptionId, id));
  return row?.resultJson ?? null;
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

export async function serializeJob(ctx: BatchContext, job: TranscriptionRow) {
  const regionCounts = await ctx.db.select({ status: transcriptionRegions.status, count: sql<number>`count(*)::int` })
    .from(transcriptionRegions).where(eq(transcriptionRegions.transcriptionId, job.id)).groupBy(transcriptionRegions.status);
  const total = regionCounts.reduce((sum, row) => sum + Number(row.count), 0);
  const completed = regionCounts.filter((row) => row.status === "completed").reduce((sum, row) => sum + Number(row.count), 0);
  let queuePosition: number | null = null;
  if (job.status === "queued" && job.uploadedAt) {
    const [ahead] = await ctx.db.select({ count: sql<number>`count(*)::int` }).from(transcriptions)
      .where(and(inArray(transcriptions.status, ["queued", "processing"]), lt(transcriptions.uploadedAt, job.uploadedAt)));
    queuePosition = Number(ahead!.count) + 1;
  }
  const stage = job.status === "processing" ? (total === 0 ? "decoding" : "transcribing") : job.status;
  const audio = job.deletionState === "files_deleted" ? "deleted"
    : job.deletionState === "pending" ? "deletion_pending"
      : job.status === "awaiting_upload" ? "not_received" : "stored";
  return {
    id: job.id,
    object: "transcription",
    status: job.status,
    content_type: job.contentType,
    byte_size: job.byteSize,
    language: job.language,
    channel_mode: job.channelMode,
    channel_labels: job.channelLabels,
    diarize: job.diarize,
    duration_seconds: job.durationSeconds,
    channels: job.channels,
    progress: { stage, queue_position: queuePosition, regions_completed: completed, regions_total: total },
    retention: {
      audio,
      audio_deleted_at: iso(job.filesDeletedAt),
      transcript_expires_at: iso(job.transcriptExpiresAt),
      transcript_deleted_at: iso(job.transcriptDeletedAt),
    },
    error: jobError(job.errorCode, job.errorMessage),
    created_at: iso(job.createdAt),
    upload_deadline_at: iso(job.uploadDeadlineAt),
    uploaded_at: iso(job.uploadedAt),
    processing_started_at: iso(job.processingStartedAt),
    finished_at: iso(job.terminalAt),
  };
}

export async function admissionStatus(ctx: BatchContext) {
  return { mode: await admissionMode(ctx.db), active: await activeCounts(ctx.db), retention_lag_seconds: await retentionLagSeconds(ctx.db) };
}

