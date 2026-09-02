import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { AppContext } from "../context.ts";
import {
  meetings,
  outboxJobs,
  recoveryOperations,
  transcriptionChunks,
  transcripts,
  webhookDeliveries,
  type MeetingRow,
  type TranscriptRow,
} from "../db/schema.ts";
import { ApiError, type ErrorCode, safeStoredError } from "../domain/errors.ts";
import { newMeetingId } from "../domain/ids.ts";
import { detectPlatform, type Platform } from "../domain/platform.ts";
import { canTransition, isTerminal, type MeetingStatus } from "../domain/state.ts";
import { classifyRecovery } from "../domain/recovery.ts";
import type { NormalizedTranscript } from "../domain/transcript.ts";
import { meetingLogFields } from "../log.ts";
import { VexaHttpError } from "../providers/vexa/client.ts";
import {
  safeTranscriptRevision,
  serializeMeetingRecovery,
} from "../api/recovery-contract.ts";
import { reconcileTerminalProviderReservations } from "../worker/outbox.ts";
import { startMeetingFencedCall } from "../worker/meeting-call-fence.ts";

export interface CreateMeetingInput {
  meeting_url: string;
  bot_name?: string;
  language?: string;
  webhook_url?: string;
  platform?: string;
  metadata?: Record<string, unknown>;
}

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
};
export const hashCreateRequest = (input: CreateMeetingInput) => createHash("sha256").update(canonical(input)).digest("hex");

export async function createMeeting(
  ctx: AppContext,
  projectId: string,
  input: CreateMeetingInput,
  idempotencyKey: string | null,
): Promise<{ meeting: MeetingRow; created: boolean }> {
  const requestHash = hashCreateRequest(input);
  if (idempotencyKey) {
    const [existing] = await ctx.db
      .select()
      .from(meetings)
      .where(and(eq(meetings.projectId, projectId), eq(meetings.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ApiError("idempotency_conflict", "Idempotency-Key was already used with a different request body");
      }
      return { meeting: existing, created: false };
    }
  }
  const detected = detectPlatform(input.meeting_url, input.platform);
  // Detection recognizes every platform; deployments only accept the ones in ENABLED_PLATFORMS
  // (default jitsi — the others are detected but not serviceable yet, see .context/ptx-demo-readiness.md #8).
  if (!ctx.config.enabledPlatforms.includes(detected.platform)) {
    throw new ApiError(
      "unsupported_platform",
      `The ${detected.platform} platform was detected but is not enabled on this deployment.`,
    );
  }
  const [row] = await ctx.db
    .insert(meetings)
    .values({
      id: newMeetingId(),
      projectId,
      meetingUrl: input.meeting_url,
      platform: detected.platform,
      status: "queued",
      botName: input.bot_name ?? null,
      language: input.language ?? null,
      webhookUrl: input.webhook_url ?? null,
      vexaNativeMeetingId: detected.nativeMeetingId,
      metadata: input.metadata ?? {},
      idempotencyKey,
      requestHash,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    // Lost a race on the idempotency key; return the winner.
    return createMeeting(ctx, projectId, input, idempotencyKey);
  }
  await ctx.queue.push({ type: "meeting.start", meetingId: row.id });
  return { meeting: row, created: true };
}

export async function getMeeting(ctx: AppContext, projectId: string, id: string): Promise<MeetingRow> {
  const [row] = await ctx.db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, id), eq(meetings.projectId, projectId), isNull(meetings.deletedAt)))
    .limit(1);
  // The requested id is deliberately not echoed. A meeting belonging to another project and one
  // that never existed must answer identically, and the caller already knows what it asked for.
  if (!row) throw new ApiError("meeting_not_found", "No such meeting.");
  return row;
}

export async function getMeetingById(ctx: AppContext, id: string): Promise<MeetingRow | null> {
  const [row] = await ctx.db.select().from(meetings)
    .where(and(eq(meetings.id, id), isNull(meetings.deletedAt))).limit(1);
  return row ?? null;
}

export async function getTranscript(ctx: AppContext, meetingId: string): Promise<TranscriptRow | null> {
  const [row] = await ctx.db.select().from(transcripts).where(eq(transcripts.meetingId, meetingId)).limit(1);
  return row ?? null;
}

/**
 * Apply a status transition if the state machine allows it. Returns the updated row (or the
 * unchanged row when the transition is not allowed). Timestamps are set on first entry.
 */
export async function transition(
  ctx: AppContext,
  meeting: MeetingRow,
  to: MeetingStatus,
  extra: Partial<typeof meetings.$inferInsert> = {},
): Promise<{ meeting: MeetingRow; changed: boolean }> {
  if (!canTransition(meeting.status as MeetingStatus, to)) return { meeting, changed: false };
  const now = new Date();
  const patch: Partial<typeof meetings.$inferInsert> = { status: to, ...extra };
  if (to === "in_progress" && !meeting.startedAt) patch.startedAt = now;
  if ((to === "processing" || isTerminal(to)) && !meeting.endedAt) patch.endedAt = now;
  if (to === "completed") patch.completedAt = now;
  const [row] = await ctx.db
    .update(meetings)
    .set(patch)
    .where(and(eq(meetings.id, meeting.id), eq(meetings.status, meeting.status)))
    .returning();
  // If another writer moved it first, re-read and report unchanged.
  if (!row) return { meeting: (await getMeetingById(ctx, meeting.id)) ?? meeting, changed: false };
  return { meeting: row, changed: true };
}

export async function failMeeting(ctx: AppContext, meeting: MeetingRow, code: ErrorCode, message: string) {
  return transition(ctx, meeting, "failed", { errorCode: code, errorMessage: message });
}

export async function storeTranscript(
  ctx: AppContext,
  meetingId: string,
  t: NormalizedTranscript,
  provider: string,
  fallback: { from: string; reason: string } | null = null,
) {
  const row = {
    language: t.language,
    durationSeconds: t.duration_seconds,
    segmentsJson: { speakers: t.speakers, segments: t.segments, text: t.text },
    provider,
    fallbackFrom: fallback?.from ?? null,
    fallbackReason: fallback?.reason ?? null,
  };
  return ctx.db.transaction(async (tx) => {
    const [liveMeeting] = await tx.select({ id: meetings.id }).from(meetings).where(and(
      eq(meetings.id, meetingId),
      eq(meetings.status, "processing"),
      isNull(meetings.deletedAt),
    )).for("update");
    if (!liveMeeting) return false;
    await tx.insert(transcripts)
      .values({ meetingId, ...row })
      .onConflictDoUpdate({ target: transcripts.meetingId, set: row });
    return true;
  });
}

/** Idempotent owner-scoped stop. The provider handoff and every post-I/O effect revalidate liveness. */
export async function stopMeeting(ctx: AppContext, projectId: string, meetingId: string): Promise<MeetingRow> {
  const started = await startMeetingFencedCall(
    ctx.db,
    meetingId,
    async (_tx, meeting) => meeting.projectId === projectId
      ? {
          meeting,
          shouldStop: !isTerminal(meeting.status as MeetingStatus) && meeting.status !== "processing",
        }
      : null,
    async (authority) => {
      if (authority.shouldStop) await stopInVexa(ctx, authority.meeting);
      return authority.meeting;
    },
  );
  if (started.kind === "stale" || started.kind === "not_started") {
    throw new ApiError("meeting_not_found", "No such meeting.");
  }
  if (started.kind === "ambiguous") {
    throw new ApiError("provider_unavailable", "Could not confirm the capture provider stop handoff.");
  }
  // Only a positively acknowledged commit may use the response. The transaction below then locks
  // the owner-scoped live row again before status or queue publication.
  await started.response;

  return ctx.db.transaction(async (tx) => {
    const [meeting] = await tx.select().from(meetings).where(and(
      eq(meetings.id, meetingId),
      eq(meetings.projectId, projectId),
      isNull(meetings.deletedAt),
    )).for("update");
    if (!meeting) throw new ApiError("meeting_not_found", "No such meeting.");
    const status = meeting.status as MeetingStatus;
    if (isTerminal(status) || status === "processing") return meeting;

    const nextStatus: MeetingStatus = status === "in_progress" ? "processing" : "cancelled";
    if (!canTransition(status, nextStatus)) return meeting;
    const now = new Date();
    const [updated] = await tx.update(meetings).set({
      status: nextStatus,
      ...(!meeting.endedAt ? { endedAt: now } : {}),
    }).where(and(
      eq(meetings.id, meeting.id),
      eq(meetings.projectId, projectId),
      eq(meetings.status, meeting.status),
      isNull(meetings.deletedAt),
    )).returning();
    if (!updated) throw new ApiError("meeting_not_found", "No such meeting.");
    if (nextStatus === "processing") {
      await ctx.queue.push({ type: "meeting.poll", meetingId: meeting.id });
    }
    return updated;
  });
}

export type RecoverDisposition = "already_completed" | "already_active";

export interface RecoverResult {
  meeting: MeetingRow;
  /** Every A0/A1 success is a read-only no-op. A started disposition requires A2-A4 authority. */
  disposition: RecoverDisposition;
}

/**
 * A0/A1 containment only. Completed and already-processing meetings are successful read-only
 * no-ops. Every failed row remains disabled even when the deployment switch is true: the switch
 * is necessary but cannot substitute for the A2-A4 transactional operation, budget, capability,
 * and durable-delivery authority. Other states fail closed.
 */
export async function recoverMeeting(_ctx: AppContext, meeting: MeetingRow): Promise<RecoverResult> {
  const classification = classifyRecovery(meeting.status, meeting.errorCode);
  if (classification === "already_completed") return { meeting, disposition: "already_completed" };
  if (classification === "already_active") {
    // A meeting already being worked on is reported, never re-driven: an extra poll per call is an
    // unbounded duplicate-work amplifier under client retries. Repairing the commit-to-Redis crash
    // window belongs to recovery v2, not to a caller retry.
    return { meeting, disposition: "already_active" };
  }
  if (meeting.status === "failed") {
    throw new ApiError("recovery_disabled", "Meeting recovery is not available on this deployment.");
  }
  throw new ApiError("recovery_ineligible", "This meeting is not eligible for recovery.");
}

async function stopInVexa(ctx: AppContext, meeting: MeetingRow) {
  if (!meeting.vexaPlatform || !meeting.vexaNativeMeetingId) return;
  try {
    await ctx.vexa.stopBot(meeting.vexaPlatform, meeting.vexaNativeMeetingId);
  } catch (error) {
    if (error instanceof VexaHttpError && error.notFound) return;
    ctx.log.warn("capture_stop_failed", {
      ...meetingLogFields(meeting.id),
      errorClass: "capture_provider_failure",
      ...(error instanceof VexaHttpError ? { statusClass: `${Math.floor(error.status / 100)}xx` } : {}),
    });
  }
}

/**
 * Removes our record + transcript and asks Vexa to delete its meeting (404-tolerant). Vexa v0.12 only
 * deletes PLANNED rows and answers 409 for anything the bot lifecycle touched — we log that ("retained
 * by capture provider") and still remove our data; purging Vexa's copy is a documented gap.
 */
interface DeletionTarget {
  platform: string;
  nativeMeetingId: string;
}

async function fenceMeetingDeletion(
  ctx: AppContext,
  projectId: string,
  meetingId: string,
): Promise<DeletionTarget | null> {
  return ctx.db.transaction(async (tx) => {
    const [meeting] = await tx.select().from(meetings).where(and(
      eq(meetings.id, meetingId),
      eq(meetings.projectId, projectId),
    )).for("update");
    if (!meeting) throw new ApiError("meeting_not_found", "No such meeting.");
    if (meeting.deletedAt) {
      return meeting.deletionSagaState === "pending"
        && meeting.deletionProviderPlatform && meeting.deletionProviderNativeMeetingId
        ? { platform: meeting.deletionProviderPlatform, nativeMeetingId: meeting.deletionProviderNativeMeetingId }
        : null;
    }

    const target = meeting.vexaPlatform && meeting.vexaNativeMeetingId
      ? { platform: meeting.vexaPlatform, nativeMeetingId: meeting.vexaNativeMeetingId }
      : null;
    // Recovery transactions use one lock order everywhere: meeting -> operation -> outbox ->
    // chunks -> provider ledger -> project guard/bucket. Lock every operation (including terminal
    // audit rows) in stable order before changing any dependent recovery row.
    const lockedOperations = await tx.select().from(recoveryOperations)
      .where(eq(recoveryOperations.meetingId, meetingId))
      .orderBy(recoveryOperations.id)
      .for("update");
    const cancellableOperationIds = lockedOperations
      .filter((operation) => ["accepted", "active", "delayed"].includes(operation.state))
      .map((operation) => operation.id);
    const cancelledOperations = cancellableOperationIds.length > 0
      ? await tx.update(recoveryOperations).set({
      state: "cancelled",
      phase: "failed",
      failureCode: "deleted",
      workerLeaseOwnerHash: null,
      workerLeaseExpiresAt: null,
      workerLeaseFence: sql`${recoveryOperations.workerLeaseFence} + 1`,
      completedAt: sql`coalesce(${recoveryOperations.completedAt}, clock_timestamp())`,
      updatedAt: sql`clock_timestamp()`,
    }).where(inArray(recoveryOperations.id, cancellableOperationIds)).returning({ id: recoveryOperations.id })
      : [];
    await tx.update(outboxJobs).set({
      state: "cancelled",
      leaseOwnerHash: null,
      leaseExpiresAt: null,
      leaseFence: sql`${outboxJobs.leaseFence} + 1`,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      sql`${outboxJobs.operationId} in (select id from recovery_operations where meeting_id = ${meetingId})`,
      inArray(outboxJobs.state, ["pending", "leased", "failed"]),
    ));
    await tx.update(transcriptionChunks).set({
      leaseOwnerHash: null,
      leaseExpiresAt: null,
      leaseFence: sql`${transcriptionChunks.leaseFence} + 1`,
      updatedAt: sql`clock_timestamp()`,
    }).where(sql`${transcriptionChunks.operationId} in (select id from recovery_operations where meeting_id = ${meetingId})`);
    for (const operation of cancelledOperations.sort((left, right) => left.id.localeCompare(right.id))) {
      await reconcileTerminalProviderReservations(tx, operation.id);
    }
    await tx.update(webhookDeliveries).set({
      status: "cancelled",
      nextAttemptAt: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(webhookDeliveries.meetingId, meetingId),
      inArray(webhookDeliveries.status, ["pending", "dispatching"]),
    ));
    await tx.delete(transcripts).where(eq(transcripts.meetingId, meetingId));
    await tx.update(meetings).set({
      meetingUrl: "",
      botName: null,
      language: null,
      webhookUrl: null,
      vexaPlatform: null,
      vexaNativeMeetingId: null,
      vexaBotId: null,
      metadata: {},
      errorCode: "deleted",
      errorMessage: null,
      idempotencyKey: null,
      requestHash: null,
      status: "cancelled",
      activeRecoveryOperationId: null,
      nextRecoveryEligibleAt: null,
      recoveryPhase: "failed",
      lastRecoveryOutcome: "cancelled",
      deletedAt: sql`clock_timestamp()`,
      deletionFence: sql`${meetings.deletionFence} + 1`,
      deletionSagaState: target ? "pending" : "completed",
      deletionProviderPlatform: target?.platform ?? null,
      deletionProviderNativeMeetingId: target?.nativeMeetingId ?? null,
    }).where(and(eq(meetings.id, meetingId), isNull(meetings.deletedAt)));
    return target;
  });
}

async function completeDeletionSaga(ctx: AppContext, projectId: string, meetingId: string): Promise<void> {
  await ctx.db.update(meetings).set({
    deletionSagaState: "completed",
    deletionProviderPlatform: null,
    deletionProviderNativeMeetingId: null,
  }).where(and(
    eq(meetings.id, meetingId),
    eq(meetings.projectId, projectId),
    sql`${meetings.deletedAt} is not null`,
    eq(meetings.deletionSagaState, "pending"),
  ));
}

async function finishCaptureDeletion(
  ctx: AppContext,
  projectId: string,
  meetingId: string,
  target: DeletionTarget | null,
): Promise<void> {
  if (target) {
    // Explicit deletion-saga authority: the row is already tombstoned, so this cleanup must not use
    // the live-meeting fence that protects ordinary stop calls.
    await stopInVexa(ctx, {
      id: meetingId,
      status: "cancelled",
      vexaPlatform: target.platform,
      vexaNativeMeetingId: target.nativeMeetingId,
    } as MeetingRow);
    try {
      await ctx.vexa.deleteMeeting(target.platform, target.nativeMeetingId);
    } catch (error) {
      if (error instanceof VexaHttpError && error.conflict) {
        ctx.log.warn("capture_delete_retained", {
          ...meetingLogFields(meetingId),
          errorClass: "capture_provider_conflict",
          statusClass: "4xx",
        });
      } else if (!(error instanceof VexaHttpError && error.notFound)) {
        ctx.log.warn("capture_delete_failed", {
          ...meetingLogFields(meetingId),
          errorClass: "capture_provider_failure",
          ...(error instanceof VexaHttpError ? { statusClass: `${Math.floor(error.status / 100)}xx` } : {}),
        });
        throw new ApiError("provider_unavailable", "Could not delete the meeting from the capture provider");
      }
    }
  }
  await completeDeletionSaga(ctx, projectId, meetingId);
}

/** Tombstone/fence first; the capture-provider delete is a retryable idempotent saga step. */
export async function deleteMeetingById(ctx: AppContext, projectId: string, meetingId: string): Promise<void> {
  const target = await fenceMeetingDeletion(ctx, projectId, meetingId);
  await finishCaptureDeletion(ctx, projectId, meetingId, target);
}

/** Backward-compatible service entry point for callers that already loaded the owner-scoped row. */
export async function deleteMeeting(ctx: AppContext, meeting: MeetingRow): Promise<void> {
  await deleteMeetingById(ctx, meeting.projectId, meeting.id);
}

// ---- serialization ----

export interface MeetingRecoverySerializationContext {
  manualMeetingCycles: number | null;
  eligible: boolean;
}

const DARK_RECOVERY_SERIALIZATION: MeetingRecoverySerializationContext = Object.freeze({
  manualMeetingCycles: null,
  eligible: false,
});

export function serializeMeeting(
  m: MeetingRow,
  transcript: TranscriptRow | null | undefined,
  recoveryContext: MeetingRecoverySerializationContext = DARK_RECOVERY_SERIALIZATION,
) {
  const status = m.status as MeetingStatus;
  return {
    id: m.id,
    object: "meeting",
    status,
    platform: m.platform as Platform,
    meeting_url: m.meetingUrl,
    bot: { name: m.botName, joined_at: m.startedAt?.toISOString() ?? null },
    transcript: { status: transcriptStatus(status, !!transcript) },
    created_at: m.createdAt.toISOString(),
    started_at: m.startedAt?.toISOString() ?? null,
    ended_at: m.endedAt?.toISOString() ?? null,
    completed_at: m.completedAt?.toISOString() ?? null,
    metadata: m.metadata ?? {},
    ...(transcript ? transcriptProviderFields(transcript) : {}),
    recovery: serializeMeetingRecovery({
      status,
      errorCode: m.errorCode,
      phase: m.recoveryPhase,
      nextEligibleAt: m.nextRecoveryEligibleAt,
      budgetProvenance: m.budgetProvenance,
      manualCyclesConsumed: m.manualRecoveryCyclesConsumed,
      manualMeetingCycles: recoveryContext.manualMeetingCycles,
      eligible: recoveryContext.eligible,
    }),
    transcript_revision: safeTranscriptRevision(m.transcriptRevision),
    ...(status === "failed" ? { error: safeStoredError(m.errorCode) } : {}),
  };
}

/** `transcript_provider` (+ fallback provenance when the configured provider fell back). */
export function transcriptProviderFields(t: TranscriptRow) {
  return {
    transcript_provider: t.provider,
    ...(t.fallbackFrom ? { fallback_from: t.fallbackFrom, fallback_reason: t.fallbackReason } : {}),
  };
}

function transcriptStatus(status: MeetingStatus, hasTranscript: boolean) {
  if (hasTranscript) return "completed";
  if (status === "processing") return "processing";
  if (status === "failed" || status === "cancelled") return "unavailable";
  return "pending";
}

export function serializeTranscript(m: MeetingRow, t: TranscriptRow) {
  const body = t.segmentsJson as { speakers: unknown[]; segments: unknown[]; text: string };
  return {
    meeting_id: m.id,
    status: "completed",
    language: t.language,
    duration_seconds: t.durationSeconds,
    provider: t.provider,
    ...(t.fallbackFrom ? { fallback_from: t.fallbackFrom, fallback_reason: t.fallbackReason } : {}),
    speakers: body.speakers,
    segments: body.segments,
    text: body.text,
    created_at: t.createdAt.toISOString(),
    transcript_revision: safeTranscriptRevision(m.transcriptRevision),
  };
}
