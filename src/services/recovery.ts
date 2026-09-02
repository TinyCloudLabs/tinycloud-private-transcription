import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "../db/client.ts";
import {
  RecoveryBudgetRejected,
  inspectProjectRecoveryBudget,
  reserveProjectRecoveryBudgetInTransaction,
  type RecoveryBudgetLimits,
} from "../db/recovery-budget.ts";
import {
  meetings,
  outboxJobs,
  providerCallLedger,
  recoveryOperations,
  type MeetingRow,
  type RecoveryOperationRow,
} from "../db/schema.ts";
import { ApiError } from "../domain/errors.ts";
import { newOutboxJobId, newRecoveryOperationId } from "../domain/ids.ts";
import {
  vexaRecoveryPreflightPolicyIsReady,
  type VexaRecoveryPreflightPolicy,
  type VexaRecoveryPreflightResult,
  type VexaRecoveryTarget,
} from "../providers/vexa/recovery-preflight.ts";

interface NullableProviderLimits {
  maxSourceDurationMs: number | null;
  maxRecordingBytes: number | null;
  maxCallsPerOperation: number | null;
  maxSubmittedAudioMsPerOperation: number | null;
  maxConcurrency: number | null;
  operationDeadlineMs: number | null;
}

export interface RecoveryAcceptancePolicy {
  enabled: boolean;
  providerV2Enabled: boolean;
  manualMeetingCycles: number | null;
  cooldownBaseMs: number | null;
  cooldownMaxMs: number | null;
  retentionPolicyVersion: string | null;
  priceVersion: string | null;
  providerLimits: NullableProviderLimits;
  projectBudget: RecoveryBudgetLimits;
  recording: VexaRecoveryPreflightPolicy | null;
}

/** No operator economics, retention, price, or provider limit is inferred by the application. */
export const UNSET_RECOVERY_ACCEPTANCE_POLICY: RecoveryAcceptancePolicy = Object.freeze({
  enabled: false,
  providerV2Enabled: false,
  manualMeetingCycles: null,
  cooldownBaseMs: null,
  cooldownMaxMs: null,
  retentionPolicyVersion: null,
  priceVersion: null,
  providerLimits: Object.freeze({
    maxSourceDurationMs: null,
    maxRecordingBytes: null,
    maxCallsPerOperation: null,
    maxSubmittedAudioMsPerOperation: null,
    maxConcurrency: null,
    operationDeadlineMs: null,
  }),
  projectBudget: Object.freeze({
    manualCycles: null,
    automaticCycles: null,
    sharedCalls: null,
    sharedAudioMs: null,
    sharedCostMicrounits: null,
  }),
  recording: null,
});

type FaultPoint =
  | "after_operation_insert"
  | "after_meeting_update"
  | "before_outbox_insert"
  | "after_outbox_insert";

export interface StartManualRecoveryDependencies {
  db: Db;
  policy?: RecoveryAcceptancePolicy;
  preflight(target: VexaRecoveryTarget, policy: VexaRecoveryPreflightPolicy): Promise<VexaRecoveryPreflightResult>;
  fault?(point: FaultPoint): void;
}

export interface StartManualRecoveryInput {
  projectId: string;
  meetingId: string;
  idempotencyKey: string;
}

export type ManualRecoveryDisposition = "started" | "already_active" | "already_completed";

export type StartManualRecoveryResult =
  | { disposition: "started"; replayed: boolean; meeting: MeetingRow; operation: RecoveryOperationRow }
  | { disposition: "already_active"; replayed: false; meeting: MeetingRow; operation: RecoveryOperationRow | null }
  | { disposition: "already_completed"; replayed: false; meeting: MeetingRow; operation: null };

const ACTIVE_OPERATION_STATES = ["accepted", "active", "delayed"] as const;
const ELIGIBLE_FAILURE_CODES = new Set([
  "provider_timeout",
  "provider_unavailable",
  "finalizer_interrupted",
  "recording_fetch_transient",
]);
const OPAQUE_KEY = /^[\x21-\x7e]{1,128}$/;
const OPAQUE_POLICY_VERSION = /^[A-Za-z0-9._:-]{1,128}$/;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function recoveryAcceptancePolicyIsReady(policy: RecoveryAcceptancePolicy): policy is RecoveryAcceptancePolicy & {
  manualMeetingCycles: number;
  cooldownBaseMs: number;
  cooldownMaxMs: number;
  retentionPolicyVersion: string;
  priceVersion: string;
  recording: VexaRecoveryPreflightPolicy;
} {
  const provider = policy.providerLimits;
  const budget = policy.projectBudget;
  return policy.enabled === true
    && policy.providerV2Enabled === true
    && positiveInteger(policy.manualMeetingCycles)
    && positiveInteger(policy.cooldownBaseMs)
    && positiveInteger(policy.cooldownMaxMs)
    && policy.cooldownMaxMs >= policy.cooldownBaseMs
    && typeof policy.retentionPolicyVersion === "string"
    && OPAQUE_POLICY_VERSION.test(policy.retentionPolicyVersion)
    && typeof policy.priceVersion === "string"
    && OPAQUE_POLICY_VERSION.test(policy.priceVersion)
    && positiveInteger(provider.maxSourceDurationMs)
    && positiveInteger(provider.maxRecordingBytes)
    && positiveInteger(provider.maxCallsPerOperation)
    && positiveInteger(provider.maxSubmittedAudioMsPerOperation)
    && positiveInteger(provider.maxConcurrency)
    && positiveInteger(provider.operationDeadlineMs)
    && positiveInteger(budget.manualCycles)
    && nonnegativeInteger(budget.automaticCycles)
    && positiveInteger(budget.sharedCalls)
    && positiveInteger(budget.sharedAudioMs)
    && typeof budget.sharedCostMicrounits === "bigint"
    && budget.sharedCostMicrounits > 0n
    && policy.recording !== null
    && vexaRecoveryPreflightPolicyIsReady(policy.recording)
    && policy.recording.maxDurationMs <= provider.maxSourceDurationMs
    && policy.recording.maxBytes <= provider.maxRecordingBytes;
}

function assertBoundedInput(input: StartManualRecoveryInput): void {
  if (!input.projectId || input.projectId.length > 128 || !input.meetingId || input.meetingId.length > 128) {
    throw new ApiError("invalid_request", "Recovery request identifiers are malformed.");
  }
  if (!OPAQUE_KEY.test(input.idempotencyKey)) {
    throw new ApiError("invalid_request", "Idempotency-Key must contain 1-128 visible ASCII characters.");
  }
}

function assertMeetingEligible(meeting: MeetingRow, policy: ReturnType<typeof readyPolicy>, databaseNow: Date): void {
  if (meeting.status !== "failed"
    || meeting.budgetProvenance !== "tracked"
    || !ELIGIBLE_FAILURE_CODES.has(meeting.errorCode ?? "")
    || meeting.errorCode === "cancelled"
    || meeting.errorCode === "deleted"
    || meeting.lastRecoveryOutcome === "cancelled"
    || meeting.deletedAt !== null
    || meeting.activeRecoveryOperationId !== null) {
    throw new ApiError("recovery_ineligible", "This meeting is not eligible for recovery.");
  }
  if (meeting.nextRecoveryEligibleAt && meeting.nextRecoveryEligibleAt.getTime() > databaseNow.getTime()) {
    const seconds = Math.ceil((meeting.nextRecoveryEligibleAt.getTime() - databaseNow.getTime()) / 1000);
    const retryAfterSeconds = Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86_400 ? seconds : null;
    throw new ApiError("recovery_cooldown", "Meeting recovery is cooling down.", 429, retryAfterSeconds);
  }
  if (meeting.manualRecoveryCyclesConsumed >= policy.manualMeetingCycles) {
    throw new ApiError("budget_exhausted", "The recovery budget is exhausted.");
  }
}

function readyPolicy(policy: RecoveryAcceptancePolicy): RecoveryAcceptancePolicy & {
  manualMeetingCycles: number;
  cooldownBaseMs: number;
  cooldownMaxMs: number;
  retentionPolicyVersion: string;
  priceVersion: string;
  recording: VexaRecoveryPreflightPolicy;
} {
  if (!recoveryAcceptancePolicyIsReady(policy)) {
    throw new ApiError("recovery_disabled", "Meeting recovery is not available on this deployment.");
  }
  return policy;
}

async function findOperationByKey(
  db: Pick<Db, "select">,
  input: Pick<StartManualRecoveryInput, "projectId" | "meetingId">,
  keyHash: string,
): Promise<RecoveryOperationRow | null> {
  const [operation] = await db
    .select()
    .from(recoveryOperations)
    .where(and(
      eq(recoveryOperations.projectId, input.projectId),
      eq(recoveryOperations.meetingId, input.meetingId),
      eq(recoveryOperations.idempotencyKeyHash, keyHash),
    ))
    .limit(1);
  return operation ?? null;
}

async function findMeetingWithClock(db: Db, input: StartManualRecoveryInput) {
  const [row] = await db
    .select({ meeting: meetings, databaseNow: sql<Date>`clock_timestamp()` })
    .from(meetings)
    .where(and(eq(meetings.id, input.meetingId), eq(meetings.projectId, input.projectId), isNull(meetings.deletedAt)))
    .limit(1);
  if (!row) throw new ApiError("meeting_not_found", "No such meeting.");
  return row;
}

function noOpDisposition(meeting: MeetingRow): "already_completed" | "already_active" | null {
  if (meeting.status === "completed") return "already_completed";
  if (meeting.status === "processing") return "already_active";
  return null;
}

async function findLinkedActiveOperation(
  db: Pick<Db, "select">,
  meeting: MeetingRow,
): Promise<RecoveryOperationRow | null> {
  if (!meeting.activeRecoveryOperationId) return null;
  const [operation] = await db.select().from(recoveryOperations).where(and(
    eq(recoveryOperations.id, meeting.activeRecoveryOperationId),
    eq(recoveryOperations.projectId, meeting.projectId),
    eq(recoveryOperations.meetingId, meeting.id),
  )).limit(1);
  return operation ?? null;
}

function preflightError(result: Exclude<VexaRecoveryPreflightResult, { availability: "present_unverified" }>): ApiError {
  if (result.availability === "absent") return new ApiError("recording_absent", "The recording is unavailable.");
  if (result.availability === "transient") {
    return new ApiError("recording_fetch_transient", "The recording is temporarily unavailable.");
  }
  return new ApiError("recovery_ineligible", "This meeting is not eligible for recovery.");
}

/**
 * Accept one manual recovery into the database outbox. This service never accesses Redis, a
 * recording body, transcription, the provider call ledger, or delivery machinery.
 */
export async function startManualRecovery(
  deps: StartManualRecoveryDependencies,
  input: StartManualRecoveryInput,
): Promise<StartManualRecoveryResult> {
  assertBoundedInput(input);
  const keyHash = hash(input.idempotencyKey);
  const replay = await findOperationByKey(deps.db, input, keyHash);
  if (replay) {
    const [meeting] = await deps.db.select().from(meetings).where(and(
      eq(meetings.id, input.meetingId),
      eq(meetings.projectId, input.projectId),
      isNull(meetings.deletedAt),
    )).limit(1);
    if (!meeting) throw new ApiError("meeting_not_found", "No such meeting.");
    return { disposition: "started", replayed: true, meeting, operation: replay };
  }

  const initial = await findMeetingWithClock(deps.db, input);
  if (initial.meeting.status === "completed") {
    return { disposition: "already_completed", replayed: false, meeting: initial.meeting, operation: null };
  }
  const initialNoOp = noOpDisposition(initial.meeting);
  if (initialNoOp === "already_active") {
    return {
      disposition: initialNoOp,
      replayed: false,
      meeting: initial.meeting,
      operation: await findLinkedActiveOperation(deps.db, initial.meeting),
    };
  }
  if (initial.meeting.status !== "failed") {
    throw new ApiError("recovery_ineligible", "This meeting is not eligible for recovery.");
  }
  const policy = readyPolicy(deps.policy ?? UNSET_RECOVERY_ACCEPTANCE_POLICY);
  assertMeetingEligible(initial.meeting, policy, initial.databaseNow);
  if (!initial.meeting.vexaPlatform || !initial.meeting.vexaNativeMeetingId) {
    throw new ApiError("recovery_ineligible", "This meeting is not eligible for recovery.");
  }

  const budgetInput = {
    projectId: input.projectId,
    kind: "manual" as const,
    reservation: { cycles: 1, calls: 0, audioMs: 0, costMicrounits: 0n },
    limits: policy.projectBudget,
  };
  const budgetPreview = await inspectProjectRecoveryBudget(deps.db, budgetInput);
  if (!budgetPreview.accepted) {
    const code = budgetPreview.reason === "limits_unset" ? "recovery_disabled" : "budget_exhausted";
    throw new ApiError(code, code === "recovery_disabled"
      ? "Meeting recovery is not available on this deployment."
      : "The recovery budget is exhausted.");
  }

  const preflight = await deps.preflight({
    platform: initial.meeting.vexaPlatform,
    nativeMeetingId: initial.meeting.vexaNativeMeetingId,
  }, policy.recording);
  if (preflight.availability !== "present_unverified") throw preflightError(preflight);

  const operationId = newRecoveryOperationId();
  const outboxId = newOutboxJobId();
  try {
    return await deps.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ meeting: meetings, databaseNow: sql<Date>`clock_timestamp()` })
        .from(meetings)
        .where(and(eq(meetings.id, input.meetingId), eq(meetings.projectId, input.projectId), isNull(meetings.deletedAt)))
        .for("update");
      if (!locked) throw new ApiError("meeting_not_found", "No such meeting.");

      const existing = await findOperationByKey(tx as unknown as Pick<Db, "select">, input, keyHash);
      if (existing) return { disposition: "started" as const, replayed: true, meeting: locked.meeting, operation: existing };
      const lockedNoOp = noOpDisposition(locked.meeting);
      if (lockedNoOp === "already_completed") {
        return { disposition: lockedNoOp, replayed: false as const, meeting: locked.meeting, operation: null };
      }
      if (lockedNoOp === "already_active") {
        return {
          disposition: lockedNoOp,
          replayed: false as const,
          meeting: locked.meeting,
          operation: await findLinkedActiveOperation(tx as unknown as Pick<Db, "select">, locked.meeting),
        };
      }
      assertMeetingEligible(locked.meeting, policy, locked.databaseNow);

      // The budget guard is the project lock. Take it (and reserve the one project cycle) before
      // inserting any operation; every later failure remains inside this same transaction.
      await reserveProjectRecoveryBudgetInTransaction(tx, budgetInput);

      const [operation] = await tx.insert(recoveryOperations).values({
        id: operationId,
        projectId: input.projectId,
        meetingId: input.meetingId,
        idempotencyKeyHash: keyHash,
        kind: "manual",
        state: "accepted",
        phase: "queued",
        eligibilityCode: "eligible",
        ordinal: locked.meeting.manualRecoveryCyclesConsumed + 1,
        cooldownSnapshotAt: locked.meeting.nextRecoveryEligibleAt,
        correlationId: operationId,
        actorClass: "user",
        reasonCode: "user_requested",
        acceptedAt: locked.databaseNow,
        deadlineAt: new Date(locked.databaseNow.getTime() + policy.providerLimits.operationDeadlineMs!),
        createdAt: locked.databaseNow,
        updatedAt: locked.databaseNow,
      }).returning();
      if (!operation) throw new Error("recovery operation insert failed");
      deps.fault?.("after_operation_insert");

      const [updatedMeeting] = await tx.update(meetings).set({
        status: "processing",
        manualRecoveryCyclesConsumed: locked.meeting.manualRecoveryCyclesConsumed + 1,
        activeRecoveryOperationId: operation.id,
        recoveryPhase: "queued",
        nextRecoveryEligibleAt: null,
        lastRecoveryOutcome: null,
        errorCode: null,
        errorMessage: null,
      }).where(and(
        eq(meetings.id, input.meetingId),
        eq(meetings.projectId, input.projectId),
        eq(meetings.status, "failed"),
      )).returning();
      if (!updatedMeeting) throw new Error("recovery meeting update failed");
      deps.fault?.("after_meeting_update");

      deps.fault?.("before_outbox_insert");
      await tx.insert(outboxJobs).values({
        id: outboxId,
        projectId: input.projectId,
        operationId: operation.id,
        eventType: "operation.accepted",
        dedupeKeyHash: hash(`operation.accepted:${operation.id}`),
        state: "pending",
        availableAt: locked.databaseNow,
        createdAt: locked.databaseNow,
        updatedAt: locked.databaseNow,
      });
      deps.fault?.("after_outbox_insert");
      return { disposition: "started" as const, replayed: false as const, meeting: updatedMeeting, operation };
    });
  } catch (error) {
    if (error instanceof RecoveryBudgetRejected) {
      const code = error.reason === "limits_unset" ? "recovery_disabled" : "budget_exhausted";
      throw new ApiError(code, code === "recovery_disabled"
        ? "Meeting recovery is not available on this deployment."
        : "The recovery budget is exhausted.");
    }
    throw error;
  }
}

/** Read-only, request-time eligibility proof. Acceptance rechecks every condition transactionally. */
export async function inspectManualRecoveryEligibility(
  deps: Pick<StartManualRecoveryDependencies, "db" | "policy" | "preflight">,
  meeting: MeetingRow,
): Promise<boolean> {
  try {
    const policy = readyPolicy(deps.policy ?? UNSET_RECOVERY_ACCEPTANCE_POLICY);
    const [clock] = await deps.db.select({ databaseNow: sql<Date>`clock_timestamp()` })
      .from(meetings)
      .where(and(eq(meetings.id, meeting.id), eq(meetings.projectId, meeting.projectId), isNull(meetings.deletedAt)))
      .limit(1);
    if (!clock) return false;
    assertMeetingEligible(meeting, policy, clock.databaseNow);
    const budget = await inspectProjectRecoveryBudget(deps.db, {
      projectId: meeting.projectId,
      kind: "manual",
      reservation: { cycles: 1, calls: 0, audioMs: 0, costMicrounits: 0n },
      limits: policy.projectBudget,
    });
    if (!budget.accepted || !meeting.vexaPlatform || !meeting.vexaNativeMeetingId) return false;
    const recording = await deps.preflight({
      platform: meeting.vexaPlatform,
      nativeMeetingId: meeting.vexaNativeMeetingId,
    }, policy.recording);
    return recording.availability === "present_unverified";
  } catch {
    return false;
  }
}

export interface RepeatRecoveryPreflightDependencies {
  db: Db;
  operationId: string;
  leaseOwner: string;
  operationFence: number;
  preflight(target: VexaRecoveryTarget): Promise<VexaRecoveryPreflightResult>;
}

export type RepeatRecoveryPreflightResult =
  | { outcome: "present_unverified" | "transient" | "permanent" | "recording_absent" | "too_late" | "terminal" | "stale" };

/** Future-worker seam only; it claims or delivers no outbox job and dispatches no provider call. */
export async function repeatRecoveryPreflightBeforeFirstDebit(
  deps: RepeatRecoveryPreflightDependencies,
): Promise<RepeatRecoveryPreflightResult> {
  if (!/^rcv_[0-9A-HJKMNP-TV-Z]{26}$/.test(deps.operationId)) {
    throw new ApiError("invalid_request", "Recovery operation identifier is malformed.");
  }
  if (!OPAQUE_KEY.test(deps.leaseOwner) || !positiveInteger(deps.operationFence)) {
    throw new ApiError("invalid_request", "Recovery operation lease is malformed.");
  }
  const leaseOwnerHash = hash(deps.leaseOwner);
  const [operation] = await deps.db.select().from(recoveryOperations)
    .where(and(
      eq(recoveryOperations.id, deps.operationId),
      eq(recoveryOperations.workerLeaseOwnerHash, leaseOwnerHash),
      eq(recoveryOperations.workerLeaseFence, deps.operationFence),
      sql`${recoveryOperations.workerLeaseExpiresAt} > clock_timestamp()`,
    )).limit(1);
  if (!operation) return { outcome: "stale" };
  const [meeting] = await deps.db.select().from(meetings).where(eq(meetings.id, operation.meetingId)).limit(1);
  if (!meeting) throw new ApiError("meeting_not_found", "No such meeting.");
  if (!ACTIVE_OPERATION_STATES.includes(operation.state as typeof ACTIVE_OPERATION_STATES[number])) {
    return { outcome: "terminal" };
  }
  if (meeting.status !== "processing" || meeting.activeRecoveryOperationId !== operation.id) {
    return { outcome: "terminal" };
  }
  if (!meeting.vexaPlatform || !meeting.vexaNativeMeetingId) return { outcome: "permanent" };

  const preflight = await deps.preflight({
    platform: meeting.vexaPlatform,
    nativeMeetingId: meeting.vexaNativeMeetingId,
  });
  return deps.db.transaction(async (tx) => {
    const [lockedMeeting] = await tx.select().from(meetings)
      .where(and(
        eq(meetings.id, operation.meetingId),
        eq(meetings.status, "processing"),
        eq(meetings.activeRecoveryOperationId, operation.id),
        isNull(meetings.deletedAt),
      )).for("update");
    if (!lockedMeeting) return { outcome: "terminal" as const };
    const [lockedOperation] = await tx.select().from(recoveryOperations)
      .where(eq(recoveryOperations.id, deps.operationId)).for("update");
    if (!lockedOperation || !ACTIVE_OPERATION_STATES.includes(
      lockedOperation.state as typeof ACTIVE_OPERATION_STATES[number],
    )) return { outcome: "terminal" as const };
    if (lockedOperation.workerLeaseOwnerHash !== leaseOwnerHash
      || lockedOperation.workerLeaseFence !== deps.operationFence
      || !lockedOperation.workerLeaseExpiresAt) return { outcome: "stale" as const };
    const [clock] = await tx.select({ databaseNow: sql<Date>`clock_timestamp()` })
      .from(recoveryOperations).where(eq(recoveryOperations.id, lockedOperation.id)).limit(1);
    if (!clock) return { outcome: "stale" as const };
    const { databaseNow } = clock;
    if (lockedOperation.workerLeaseExpiresAt.getTime() <= databaseNow.getTime()) {
      return { outcome: "stale" as const };
    }
    if (lockedOperation.meetingId !== lockedMeeting.id) {
      return { outcome: "terminal" as const };
    }
    const [call] = await tx.select({ id: providerCallLedger.id }).from(providerCallLedger)
      .where(eq(providerCallLedger.operationId, lockedOperation.id)).limit(1);
    if (call) return { outcome: "too_late" as const };
    if (preflight.availability !== "absent") return { outcome: preflight.availability };

    const [failedOperation] = await tx.update(recoveryOperations).set({
      state: "failed",
      phase: "failed",
      failureCode: "recording_absent",
      workerLeaseOwnerHash: null,
      workerLeaseExpiresAt: null,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(recoveryOperations.id, lockedOperation.id),
      eq(recoveryOperations.workerLeaseOwnerHash, leaseOwnerHash),
      eq(recoveryOperations.workerLeaseFence, deps.operationFence),
      sql`${recoveryOperations.workerLeaseExpiresAt} > clock_timestamp()`,
      inArray(recoveryOperations.state, [...ACTIVE_OPERATION_STATES]),
    )).returning({ id: recoveryOperations.id });
    if (!failedOperation) return { outcome: "stale" as const };
    const [failedMeeting] = await tx.update(meetings).set({
      status: "failed",
      errorCode: "recording_absent",
      errorMessage: "The recording is unavailable.",
      activeRecoveryOperationId: null,
      recoveryPhase: "failed",
      lastRecoveryOutcome: "failed",
    }).where(and(
      eq(meetings.id, lockedMeeting.id),
      eq(meetings.activeRecoveryOperationId, lockedOperation.id),
      eq(meetings.status, "processing"),
    )).returning({ id: meetings.id });
    if (!failedMeeting) throw new Error("recovery terminal meeting update failed");
    await tx.update(outboxJobs).set({
      state: "cancelled",
      leaseOwnerHash: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(outboxJobs.operationId, lockedOperation.id),
      inArray(outboxJobs.state, ["pending", "leased", "failed"]),
    ));
    return { outcome: "recording_absent" as const };
  });
}
