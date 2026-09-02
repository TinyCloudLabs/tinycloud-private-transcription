import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "../db/client.ts";
import {
  clampRecoveryWakeToDeadline,
} from "../domain/recovery.ts";
import {
  meetings,
  outboxJobs,
  projectRecoveryBuckets,
  projectRecoveryGuards,
  providerCallLedger,
  recoveryOperations,
  transcriptionChunks,
  type OutboxJobRow,
} from "../db/schema.ts";

const ACTIVE_OPERATION_STATES = ["accepted", "active", "delayed"] as const;
const BOUNDED_OWNER = /^[\x21-\x7e]{1,128}$/;
const ownerHash = (owner: string): string => createHash("sha256").update(owner).digest("hex");
const boundedPositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_DATABASE_COUNTER = 2_147_483_647;

export interface DurableDeliveryPolicy {
  leaseMs: number | null;
  maxAttempts: number | null;
  maxAgeMs: number | null;
  retryDelayMs: number | null;
  idleMs: number | null;
}

export const UNSET_DURABLE_DELIVERY_POLICY: DurableDeliveryPolicy = Object.freeze({
  leaseMs: null,
  maxAttempts: null,
  maxAgeMs: null,
  retryDelayMs: null,
  idleMs: null,
});

type ReadyDurableDeliveryPolicy = DurableDeliveryPolicy & {
  leaseMs: number;
  maxAttempts: number;
  maxAgeMs: number;
  retryDelayMs: number;
  idleMs: number;
};

/** Maintenance is safe with dispatch gates off, but only when every bounded timing is explicit. */
export function durableDeliveryMaintenanceIsReady(
  policy: DurableDeliveryPolicy,
): policy is ReadyDurableDeliveryPolicy {
  return boundedPositive(policy.leaseMs)
    && policy.leaseMs <= MAX_TIMER_MS
    && boundedPositive(policy.maxAttempts)
    && policy.maxAttempts <= MAX_DATABASE_COUNTER
    && boundedPositive(policy.maxAgeMs)
    && boundedPositive(policy.retryDelayMs)
    && policy.retryDelayMs <= MAX_TIMER_MS
    && boundedPositive(policy.idleMs)
    && policy.idleMs <= MAX_TIMER_MS;
}

function assertOwner(owner: string): void {
  if (!BOUNDED_OWNER.test(owner)) throw new TypeError("invalid delivery lease owner");
}

export interface OutboxClaim {
  id: string;
  projectId: string;
  operationId: string;
  chunkId: string | null;
  eventType: string;
  fence: number;
  attempt: number;
}

export interface ClaimOutboxJobInput {
  db: Db;
  owner: string;
  policy: DurableDeliveryPolicy;
  fault?(point: "after_job_claim" | "before_handler" | "after_handler"): void;
}

/** Claim one due row and promote the operation under the global meeting-first lock order. */
export async function claimOutboxJob(input: ClaimOutboxJobInput): Promise<OutboxClaim | null> {
  assertOwner(input.owner);
  if (!durableDeliveryMaintenanceIsReady(input.policy)) return null;
  const policy = input.policy;
  const hash = ownerHash(input.owner);
  return input.db.transaction(async (tx) => {
    const [candidate] = await tx.select({ job: outboxJobs }).from(outboxJobs).where(and(
      eq(outboxJobs.state, "pending"),
      inArray(outboxJobs.eventType, ["operation.accepted", "operation.resume", "chunk.retry", "transcript.publish"]),
      sql`${outboxJobs.availableAt} <= clock_timestamp()`,
      sql`not exists (
        select 1 from ${recoveryOperations}
        where ${recoveryOperations.id} = ${outboxJobs.operationId}
          and ${recoveryOperations.state} in ('accepted', 'active', 'delayed')
          and ${recoveryOperations.workerLeaseOwnerHash} is not null
          and ${recoveryOperations.workerLeaseExpiresAt} > clock_timestamp()
      )`,
    )).orderBy(asc(outboxJobs.availableAt), asc(outboxJobs.createdAt), asc(outboxJobs.id))
      .limit(1);
    if (!candidate) return null;
    const related = await operationAndMeeting(tx, candidate.job.operationId);
    const [row] = await tx.select({ job: outboxJobs, databaseNow: sql<Date>`clock_timestamp()` }).from(outboxJobs).where(and(
      eq(outboxJobs.id, candidate.job.id),
      eq(outboxJobs.state, "pending"),
      sql`${outboxJobs.availableAt} <= clock_timestamp()`,
    )).for("update", { skipLocked: true });
    if (!row) return null;
    if (!related.operation || !ACTIVE_OPERATION_STATES.includes(
      related.operation.state as typeof ACTIVE_OPERATION_STATES[number],
    )) {
      await finishOperationJobs(tx, row.job.operationId);
      return null;
    }
    if (!related.meeting
      || related.meeting.status !== "processing"
      || related.meeting.activeRecoveryOperationId !== related.operation.id) {
      await finishOperationJobs(tx, row.job.operationId);
      return null;
    }
    if (related.operation.workerLeaseOwnerHash
      && related.operation.workerLeaseExpiresAt
      && related.operation.workerLeaseExpiresAt.getTime() > row.databaseNow.getTime()) return null;
    if (!Number.isSafeInteger(related.operation.workerLeaseFence)
      || related.operation.workerLeaseFence >= Number.MAX_SAFE_INTEGER) {
      await terminalPersistenceFailure(tx, row.job, related.operation, related.meeting);
      return null;
    }
    const ageMs = row.databaseNow.getTime() - row.job.createdAt.getTime();
    if (row.job.attempt >= policy.maxAttempts || ageMs >= policy.maxAgeMs) {
      await terminalPersistenceFailure(tx, row.job, related.operation, related.meeting);
      return null;
    }

    const [promoted] = await tx.update(recoveryOperations).set({
      state: "active",
      phase: sql`case when ${recoveryOperations.phase} = 'queued' then 'preflighting' else ${recoveryOperations.phase} end`,
      startedAt: sql`coalesce(${recoveryOperations.startedAt}, clock_timestamp())`,
      workerLeaseOwnerHash: hash,
      workerLeaseExpiresAt: sql`clock_timestamp() + (${policy.leaseMs}::text || ' milliseconds')::interval`,
      workerLeaseFence: sql`${recoveryOperations.workerLeaseFence} + 1`,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(recoveryOperations.id, related.operation.id),
      eq(recoveryOperations.workerLeaseFence, related.operation.workerLeaseFence),
      inArray(recoveryOperations.state, [...ACTIVE_OPERATION_STATES]),
      sql`exists (
        select 1 from ${meetings}
        where ${meetings.id} = ${recoveryOperations.meetingId}
          and ${meetings.status} = 'processing'
          and ${meetings.activeRecoveryOperationId} = ${recoveryOperations.id}
      )`,
    )).returning({
      fence: recoveryOperations.workerLeaseFence,
      leaseExpiresAt: recoveryOperations.workerLeaseExpiresAt,
    });
    if (!promoted || !promoted.leaseExpiresAt) return null;

    const [claimed] = await tx.update(outboxJobs).set({
      state: "leased",
      leaseOwnerHash: hash,
      leaseExpiresAt: promoted.leaseExpiresAt,
      leaseFence: promoted.fence,
      attempt: sql`${outboxJobs.attempt} + 1`,
      lastErrorCode: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(eq(outboxJobs.id, row.job.id), eq(outboxJobs.state, "pending"))).returning();
    if (!claimed) throw new Error("delivery job claim promotion mismatch");
    input.fault?.("after_job_claim");

    await tx.update(meetings).set({
      recoveryPhase: sql`case when ${meetings.recoveryPhase} = 'queued' then 'preflighting' else ${meetings.recoveryPhase} end`,
    }).where(and(
      eq(meetings.activeRecoveryOperationId, claimed.operationId),
      eq(meetings.status, "processing"),
    ));
    return {
      id: claimed.id,
      projectId: claimed.projectId,
      operationId: claimed.operationId,
      chunkId: claimed.chunkId,
      eventType: claimed.eventType,
      fence: promoted.fence,
      attempt: claimed.attempt,
    };
  });
}

interface LeaseMutationInput {
  db: Db;
  jobId: string;
  owner: string;
  fence: number;
}

function validFence(fence: number): boolean {
  return Number.isSafeInteger(fence) && fence > 0;
}

function leasePredicate(input: LeaseMutationInput) {
  return and(
    eq(outboxJobs.id, input.jobId),
    eq(outboxJobs.state, "leased"),
    eq(outboxJobs.leaseOwnerHash, ownerHash(input.owner)),
    eq(outboxJobs.leaseFence, input.fence),
    sql`${outboxJobs.leaseExpiresAt} > clock_timestamp()`,
  );
}

export async function heartbeatOutboxJob(
  input: LeaseMutationInput & { leaseMs: number },
): Promise<boolean> {
  assertOwner(input.owner);
  if (!validFence(input.fence) || !boundedPositive(input.leaseMs) || input.leaseMs > MAX_TIMER_MS) return false;
  return input.db.transaction(async (tx) => {
    const [reference] = await tx.select({ operationId: outboxJobs.operationId })
      .from(outboxJobs).where(leasePredicate(input)).limit(1);
    if (!reference) return false;
    const related = await operationAndMeeting(tx, reference.operationId);
    if (!related.operation || !related.meeting) return false;
    const [job] = await tx.select().from(outboxJobs).where(leasePredicate(input)).for("update");
    if (!job) return false;
    const [operation] = await tx.update(recoveryOperations).set({
      workerLeaseExpiresAt: sql`clock_timestamp() + (${input.leaseMs}::text || ' milliseconds')::interval`,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(recoveryOperations.id, job.operationId),
      eq(recoveryOperations.workerLeaseOwnerHash, ownerHash(input.owner)),
      eq(recoveryOperations.workerLeaseFence, input.fence),
      sql`${recoveryOperations.workerLeaseExpiresAt} > clock_timestamp()`,
      inArray(recoveryOperations.state, [...ACTIVE_OPERATION_STATES]),
    )).returning({ leaseExpiresAt: recoveryOperations.workerLeaseExpiresAt });
    if (!operation?.leaseExpiresAt) return false;
    const [updatedJob] = await tx.update(outboxJobs).set({
      leaseExpiresAt: operation.leaseExpiresAt,
      updatedAt: sql`clock_timestamp()`,
    }).where(leasePredicate(input)).returning({ id: outboxJobs.id });
    if (!updatedJob) throw new Error("delivery job lease mismatch");
    return true;
  });
}

export async function acknowledgeOutboxJob(input: LeaseMutationInput): Promise<boolean> {
  assertOwner(input.owner);
  if (!validFence(input.fence)) return false;
  return input.db.transaction(async (tx) => {
    const [reference] = await tx.select({ operationId: outboxJobs.operationId })
      .from(outboxJobs).where(leasePredicate(input)).limit(1);
    if (!reference) return false;
    const related = await operationAndMeeting(tx, reference.operationId);
    if (!related.operation || !related.meeting) return false;
    const [job] = await tx.select().from(outboxJobs).where(leasePredicate(input)).for("update");
    if (!job || job.operationId !== related.operation.id) return false;
    const activeWinner = ACTIVE_OPERATION_STATES.includes(
      related.operation.state as typeof ACTIVE_OPERATION_STATES[number],
    ) && related.meeting.status === "processing"
      && related.meeting.activeRecoveryOperationId === related.operation.id;
    const alreadyCompleted = related.operation.state === "completed"
      && related.meeting.status === "completed";
    if (!activeWinner && !alreadyCompleted) return false;
    const [operation] = await tx.update(recoveryOperations).set({
      state: "completed",
      phase: "completed",
      failureCode: null,
      workerLeaseOwnerHash: null,
      workerLeaseExpiresAt: null,
      completedAt: sql`coalesce(${recoveryOperations.completedAt}, clock_timestamp())`,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      operationLeasePredicate(job.operationId, input),
      inArray(recoveryOperations.state, [...ACTIVE_OPERATION_STATES, "completed"]),
    )).returning({ id: recoveryOperations.id });
    if (!operation) return false;
    if (activeWinner) {
      const [meeting] = await tx.update(meetings).set({
        status: "completed",
        errorCode: null,
        errorMessage: null,
        activeRecoveryOperationId: null,
        recoveryPhase: "completed",
        lastRecoveryOutcome: "completed",
      }).where(and(
        eq(meetings.id, related.meeting.id),
        eq(meetings.status, "processing"),
        eq(meetings.activeRecoveryOperationId, related.operation.id),
      )).returning({ id: meetings.id });
      if (!meeting) throw new Error("delivery completion meeting mismatch");
    }
    const [delivered] = await tx.update(outboxJobs).set({
      state: "delivered",
      leaseOwnerHash: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(leasePredicate(input)).returning({ id: outboxJobs.id });
    if (!delivered) throw new Error("delivery acknowledgement lease mismatch");
    await tx.update(outboxJobs).set({
      state: "cancelled",
      leaseOwnerHash: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(outboxJobs.operationId, job.operationId),
      sql`${outboxJobs.id} <> ${job.id}`,
      inArray(outboxJobs.state, ["pending", "leased", "failed"]),
    ));
    return true;
  });
}

/**
 * Acknowledge one bounded B3 step without declaring the operation complete. The finalizer has
 * already persisted and enqueued the next durable state before this lease is released.
 */
export async function continueOutboxJob(input: LeaseMutationInput): Promise<boolean> {
  assertOwner(input.owner);
  if (!validFence(input.fence)) return false;
  return input.db.transaction(async (tx) => {
    const [reference] = await tx.select({ operationId: outboxJobs.operationId })
      .from(outboxJobs).where(leasePredicate(input)).limit(1);
    if (!reference) return false;
    const related = await operationAndMeeting(tx, reference.operationId);
    if (!related.operation || !related.meeting) return false;
    const [job] = await tx.select().from(outboxJobs).where(leasePredicate(input)).for("update");
    if (!job || job.operationId !== related.operation.id) return false;
    const [operation] = await tx.update(recoveryOperations).set({
      workerLeaseOwnerHash: null,
      workerLeaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      operationLeasePredicate(job.operationId, input),
      inArray(recoveryOperations.state, [...ACTIVE_OPERATION_STATES]),
    )).returning({ id: recoveryOperations.id });
    if (!operation) return false;
    const [delivered] = await tx.update(outboxJobs).set({
      state: "delivered",
      leaseOwnerHash: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(leasePredicate(input)).returning({ id: outboxJobs.id });
    if (!delivered) throw new Error("bounded step acknowledgement lease mismatch");
    return true;
  });
}

async function operationAndMeeting(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], operationId: string) {
  const [reference] = await tx.select({ meetingId: recoveryOperations.meetingId }).from(recoveryOperations)
    .where(eq(recoveryOperations.id, operationId)).limit(1);
  if (!reference) return { operation: null, meeting: null };
  const [meeting] = await tx.select().from(meetings)
    .where(eq(meetings.id, reference.meetingId)).for("update");
  if (!meeting) return { operation: null, meeting: null };
  const [operation] = await tx.select().from(recoveryOperations)
    .where(eq(recoveryOperations.id, operationId)).for("update");
  return { operation: operation ?? null, meeting };
}

function completedWins(operation: { state: string } | null, meeting: { status: string } | null): boolean {
  return operation?.state === "completed" || meeting?.status === "completed";
}

function operationLeasePredicate(operationId: string, input: Pick<LeaseMutationInput, "owner" | "fence">) {
  return and(
    eq(recoveryOperations.id, operationId),
    eq(recoveryOperations.workerLeaseOwnerHash, ownerHash(input.owner)),
    eq(recoveryOperations.workerLeaseFence, input.fence),
    sql`${recoveryOperations.workerLeaseExpiresAt} > clock_timestamp()`,
  );
}

async function finishOperationJobs(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  operationId: string,
): Promise<void> {
  await tx.update(outboxJobs).set({
    state: "cancelled",
    leaseOwnerHash: null,
    leaseExpiresAt: null,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(
    eq(outboxJobs.operationId, operationId),
    inArray(outboxJobs.state, ["pending", "leased", "failed"]),
  ));
}

async function lockProjectRecoveryGuard(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  projectId: string,
): Promise<void> {
  await tx.insert(projectRecoveryGuards).values({ projectId }).onConflictDoNothing();
  await tx.select().from(projectRecoveryGuards)
    .where(eq(projectRecoveryGuards.projectId, projectId)).for("update");
}

/** Settle every still-open provider reservation only after the operation fence has won. */
export async function reconcileTerminalProviderReservations(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  operationId: string,
): Promise<void> {
  // Callers already hold meeting -> operation -> outbox. Lock affected chunks before ledgers so
  // deletion, retry maintenance, and the finalizer cannot form a chunk/ledger inversion.
  await tx.select({ id: transcriptionChunks.id }).from(transcriptionChunks).where(and(
    eq(transcriptionChunks.operationId, operationId),
    inArray(transcriptionChunks.state, ["reserved", "dispatching"]),
  )).orderBy(asc(transcriptionChunks.id)).for("update");
  const ledgers = await tx.select().from(providerCallLedger).where(and(
    eq(providerCallLedger.operationId, operationId),
    inArray(providerCallLedger.dispatchState, ["reserved", "dispatching"]),
  )).orderBy(asc(providerCallLedger.id)).for("update");
  for (const ledger of ledgers) {
    await lockProjectRecoveryGuard(tx, ledger.projectId);
    const dispatched = ledger.dispatchState === "dispatching";
    const [bucket] = await tx.update(projectRecoveryBuckets).set({
      reservedCalls: sql`${projectRecoveryBuckets.reservedCalls} - 1`,
      spentCalls: dispatched
        ? sql`${projectRecoveryBuckets.spentCalls} + 1`
        : sql`${projectRecoveryBuckets.spentCalls}`,
      reservedAudioMs: sql`${projectRecoveryBuckets.reservedAudioMs} - ${ledger.submittedAudioMs}`,
      spentAudioMs: dispatched
        ? sql`${projectRecoveryBuckets.spentAudioMs} + ${ledger.submittedAudioMs}`
        : sql`${projectRecoveryBuckets.spentAudioMs}`,
      reservedCostMicrounits: sql`${projectRecoveryBuckets.reservedCostMicrounits} - ${ledger.reservedCostMicrounits}`,
      spentCostMicrounits: dispatched
        ? sql`${projectRecoveryBuckets.spentCostMicrounits} + ${ledger.reservedCostMicrounits}`
        : sql`${projectRecoveryBuckets.spentCostMicrounits}`,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(projectRecoveryBuckets.projectId, ledger.projectId),
      eq(projectRecoveryBuckets.bucketMinute, ledger.budgetBucketMinute),
      sql`${projectRecoveryBuckets.reservedCalls} >= 1`,
      sql`${projectRecoveryBuckets.reservedAudioMs} >= ${ledger.submittedAudioMs}`,
      sql`${projectRecoveryBuckets.reservedCostMicrounits} >= ${ledger.reservedCostMicrounits}`,
    )).returning({ projectId: projectRecoveryBuckets.projectId });
    if (!bucket) throw new Error("delivery terminal provider bucket mismatch");
    const [operation] = await tx.update(recoveryOperations).set({
      reservedCalls: sql`${recoveryOperations.reservedCalls} - 1`,
      spentCalls: dispatched
        ? sql`${recoveryOperations.spentCalls} + 1`
        : sql`${recoveryOperations.spentCalls}`,
      submittedAudioMs: dispatched
        ? sql`${recoveryOperations.submittedAudioMs} + ${ledger.submittedAudioMs}`
        : sql`${recoveryOperations.submittedAudioMs}`,
      reservedCostMicrounits: sql`${recoveryOperations.reservedCostMicrounits} - ${ledger.reservedCostMicrounits}`,
      spentCostMicrounits: dispatched
        ? sql`${recoveryOperations.spentCostMicrounits} + ${ledger.reservedCostMicrounits}`
        : sql`${recoveryOperations.spentCostMicrounits}`,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(recoveryOperations.id, ledger.operationId),
      sql`${recoveryOperations.reservedCalls} >= 1`,
      sql`${recoveryOperations.reservedCostMicrounits} >= ${ledger.reservedCostMicrounits}`,
    )).returning({ id: recoveryOperations.id });
    if (!operation) throw new Error("delivery terminal provider operation mismatch");
    const [settled] = await tx.update(providerCallLedger).set({
      dispatchState: dispatched ? "spent" : "not_dispatched",
      outcomeCode: dispatched ? "unknown" : "not_dispatched",
      statusClass: "none",
      spentCostMicrounits: dispatched ? ledger.reservedCostMicrounits : 0n,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(providerCallLedger.id, ledger.id),
      eq(providerCallLedger.dispatchState, ledger.dispatchState),
    )).returning({ id: providerCallLedger.id });
    if (!settled) throw new Error("delivery terminal provider ledger mismatch");
    await tx.update(transcriptionChunks).set({
      state: "failed",
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(transcriptionChunks.id, ledger.chunkId),
      eq(transcriptionChunks.providerCallLedgerId, ledger.id),
      inArray(transcriptionChunks.state, ["reserved", "dispatching"]),
    ));
  }
}

async function terminalPersistenceFailure(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  job: Pick<OutboxJobRow, "id" | "operationId">,
  operation: Awaited<ReturnType<typeof operationAndMeeting>>["operation"],
  meeting: Awaited<ReturnType<typeof operationAndMeeting>>["meeting"],
  exactLease?: { ownerHash: string; fence: number; requireFresh?: boolean },
): Promise<boolean> {
  if (completedWins(operation, meeting)) {
    const meetingMatches = !!meeting && (meeting.status === "completed"
      || (meeting.status === "processing" && meeting.activeRecoveryOperationId === job.operationId));
    if (!operation || !exactLease || !meetingMatches) {
      await finishOperationJobs(tx, job.operationId);
      return true;
    }
    const [completedOperation] = await tx.update(recoveryOperations).set({
      state: "completed",
      phase: "completed",
      failureCode: null,
      workerLeaseOwnerHash: null,
      workerLeaseExpiresAt: null,
      completedAt: sql`coalesce(${recoveryOperations.completedAt}, clock_timestamp())`,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(recoveryOperations.id, operation.id),
      eq(recoveryOperations.workerLeaseOwnerHash, exactLease.ownerHash),
      eq(recoveryOperations.workerLeaseFence, exactLease.fence),
      exactLease.requireFresh ? sql`${recoveryOperations.workerLeaseExpiresAt} > clock_timestamp()` : undefined,
      inArray(recoveryOperations.state, [...ACTIVE_OPERATION_STATES, "completed"]),
    )).returning({ id: recoveryOperations.id });
    if (!completedOperation) return false;
    if (meeting.status === "processing") {
      const [completedMeeting] = await tx.update(meetings).set({
        status: "completed",
        errorCode: null,
        errorMessage: null,
        activeRecoveryOperationId: null,
        recoveryPhase: "completed",
        lastRecoveryOutcome: "completed",
      }).where(and(
        eq(meetings.id, meeting.id),
        eq(meetings.status, "processing"),
        eq(meetings.activeRecoveryOperationId, job.operationId),
      )).returning({ id: meetings.id });
      if (!completedMeeting) throw new Error("delivery completion meeting mismatch");
    }
    const [delivered] = await tx.update(outboxJobs).set({
      state: "delivered",
      leaseOwnerHash: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(outboxJobs.id, job.id),
      eq(outboxJobs.state, "leased"),
      eq(outboxJobs.leaseOwnerHash, exactLease.ownerHash),
      eq(outboxJobs.leaseFence, exactLease.fence),
      exactLease.requireFresh ? sql`${outboxJobs.leaseExpiresAt} > clock_timestamp()` : undefined,
    )).returning({ id: outboxJobs.id });
    if (!delivered) throw new Error("delivery completion job lease mismatch");
    await tx.update(outboxJobs).set({
      state: "cancelled",
      leaseOwnerHash: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(outboxJobs.operationId, job.operationId),
      sql`${outboxJobs.id} <> ${job.id}`,
      inArray(outboxJobs.state, ["pending", "leased", "failed"]),
    ));
    return true;
  }
  if (!operation || !ACTIVE_OPERATION_STATES.includes(operation.state as typeof ACTIVE_OPERATION_STATES[number])) {
    if (exactLease) return false;
    await finishOperationJobs(tx, job.operationId);
    return true;
  }
  const operationMatch = exactLease
    ? and(
      eq(recoveryOperations.id, operation.id),
      eq(recoveryOperations.workerLeaseOwnerHash, exactLease.ownerHash),
      eq(recoveryOperations.workerLeaseFence, exactLease.fence),
      exactLease.requireFresh ? sql`${recoveryOperations.workerLeaseExpiresAt} > clock_timestamp()` : undefined,
    )
    : and(
      eq(recoveryOperations.id, operation.id),
      eq(recoveryOperations.workerLeaseFence, operation.workerLeaseFence),
    );
  const [failedOperation] = await tx.update(recoveryOperations).set({
    state: "failed",
    phase: "failed",
    failureCode: "persistence_failed",
    workerLeaseOwnerHash: null,
    workerLeaseExpiresAt: null,
    completedAt: sql`clock_timestamp()`,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(
    operationMatch,
    inArray(recoveryOperations.state, [...ACTIVE_OPERATION_STATES]),
  )).returning({ id: recoveryOperations.id });
  if (!failedOperation) return false;
  await reconcileTerminalProviderReservations(tx, operation.id);
  if (meeting && meeting.activeRecoveryOperationId === job.operationId && meeting.status !== "completed") {
    const [failedMeeting] = await tx.update(meetings).set({
      status: "failed",
      errorCode: "persistence_failed",
      errorMessage: "Recovery delivery could not be persisted.",
      activeRecoveryOperationId: null,
      recoveryPhase: "failed",
      lastRecoveryOutcome: "failed",
    }).where(and(
      eq(meetings.id, meeting.id),
      eq(meetings.activeRecoveryOperationId, job.operationId),
      sql`${meetings.status} <> 'completed'`,
    )).returning({ id: meetings.id });
    if (!failedMeeting) throw new Error("delivery terminal meeting mismatch");
  }
  await tx.update(outboxJobs).set({
    state: "cancelled",
    leaseOwnerHash: null,
    leaseExpiresAt: null,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(
    eq(outboxJobs.operationId, job.operationId),
    sql`${outboxJobs.id} <> ${job.id}`,
    inArray(outboxJobs.state, ["pending", "leased", "failed"]),
  ));
  const primaryJobMatch = exactLease
    ? and(
      eq(outboxJobs.id, job.id),
      eq(outboxJobs.state, "leased"),
      eq(outboxJobs.leaseOwnerHash, exactLease.ownerHash),
      eq(outboxJobs.leaseFence, exactLease.fence),
      exactLease.requireFresh ? sql`${outboxJobs.leaseExpiresAt} > clock_timestamp()` : undefined,
    )
    : and(eq(outboxJobs.id, job.id), inArray(outboxJobs.state, ["pending", "leased", "failed"]));
  const [failedJob] = await tx.update(outboxJobs).set({
    state: "failed",
    leaseOwnerHash: null,
    leaseExpiresAt: null,
    lastErrorCode: "persistence_failed",
    updatedAt: sql`clock_timestamp()`,
  }).where(primaryJobMatch).returning({ id: outboxJobs.id });
  if (!failedJob) throw new Error("delivery terminal job lease mismatch");
  return true;
}

export type RetryOutboxResult = "retry_scheduled" | "terminal" | "delivered" | "stale";

export async function retryOutboxJob(
  input: LeaseMutationInput & { policy: DurableDeliveryPolicy },
): Promise<RetryOutboxResult> {
  assertOwner(input.owner);
  if (!validFence(input.fence) || !durableDeliveryMaintenanceIsReady(input.policy)) return "stale";
  const policy = input.policy;
  return input.db.transaction(async (tx) => {
    const [reference] = await tx.select({ operationId: outboxJobs.operationId })
      .from(outboxJobs).where(leasePredicate(input)).limit(1);
    if (!reference) return "stale";
    const related = await operationAndMeeting(tx, reference.operationId);
    if (!related.operation || !related.meeting) return "stale";
    const [job] = await tx.select({ job: outboxJobs, databaseNow: sql<Date>`clock_timestamp()` })
      .from(outboxJobs).where(leasePredicate(input)).for("update");
    if (!job || job.job.operationId !== related.operation.id) return "stale";
    const exactLease = { ownerHash: ownerHash(input.owner), fence: input.fence, requireFresh: true };
    if (completedWins(related.operation, related.meeting)) {
      if (!await terminalPersistenceFailure(tx, job.job, related.operation, related.meeting, exactLease)) return "stale";
      return "delivered";
    }
    const ageMs = job.databaseNow.getTime() - job.job.createdAt.getTime();
    if (job.job.attempt >= policy.maxAttempts || ageMs >= policy.maxAgeMs) {
      if (!await terminalPersistenceFailure(tx, job.job, related.operation, related.meeting, exactLease)) return "stale";
      return "terminal";
    }
    const [operation] = await tx.update(recoveryOperations).set({
      workerLeaseOwnerHash: null,
      workerLeaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(operationLeasePredicate(job.job.operationId, input)).returning({ id: recoveryOperations.id });
    if (!operation) return "stale";
    const availableAt = clampRecoveryWakeToDeadline(
      related.operation,
      new Date(job.databaseNow.getTime() + policy.retryDelayMs),
    );
    const [scheduled] = await tx.update(outboxJobs).set({
      state: "pending",
      availableAt,
      leaseOwnerHash: null,
      leaseExpiresAt: null,
      lastErrorCode: "delivery_failed",
      updatedAt: sql`clock_timestamp()`,
    }).where(leasePredicate(input)).returning({ id: outboxJobs.id });
    if (!scheduled) throw new Error("delivery retry lease mismatch");
    return "retry_scheduled";
  });
}

export async function parkOutboxJob(input: LeaseMutationInput): Promise<boolean> {
  assertOwner(input.owner);
  if (!validFence(input.fence)) return false;
  return input.db.transaction(async (tx) => {
    const [reference] = await tx.select({ operationId: outboxJobs.operationId })
      .from(outboxJobs).where(leasePredicate(input)).limit(1);
    if (!reference) return false;
    const related = await operationAndMeeting(tx, reference.operationId);
    if (!related.operation || !related.meeting) return false;
    const [job] = await tx.select().from(outboxJobs).where(leasePredicate(input)).for("update");
    if (!job || job.operationId !== related.operation.id) return false;
    const [operation] = await tx.update(recoveryOperations).set({
      state: "delayed",
      phase: "disabled",
      workerLeaseOwnerHash: null,
      workerLeaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      operationLeasePredicate(job.operationId, input),
      inArray(recoveryOperations.state, [...ACTIVE_OPERATION_STATES]),
    )).returning({ meetingId: recoveryOperations.meetingId });
    if (!operation) return false;
    const [parked] = await tx.update(outboxJobs).set({
      state: "failed",
      leaseOwnerHash: null,
      leaseExpiresAt: null,
      lastErrorCode: "disabled",
      updatedAt: sql`clock_timestamp()`,
    }).where(leasePredicate(input)).returning({ id: outboxJobs.id });
    if (!parked) throw new Error("delivery park lease mismatch");
    await tx.update(outboxJobs).set({
      state: "cancelled",
      leaseOwnerHash: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(outboxJobs.operationId, job.operationId),
      sql`${outboxJobs.id} <> ${job.id}`,
      inArray(outboxJobs.state, ["pending", "leased", "failed"]),
    ));
    await tx.update(meetings).set({ recoveryPhase: "disabled" }).where(and(
      eq(meetings.id, operation.meetingId),
      eq(meetings.activeRecoveryOperationId, job.operationId),
      eq(meetings.status, "processing"),
    ));
    return true;
  });
}

export interface SweepResult {
  requeued: number;
  parked: number;
  terminal: number;
  delivered: number;
}

/** Deadline maintenance is independent of provider readiness and never makes work dispatchable. */
export async function enforceParkedOperationDeadline(input: {
  db: Db;
  limit?: number;
}): Promise<string | null> {
  const limit = input.limit ?? 1;
  if (!Number.isSafeInteger(limit) || limit <= 0) return null;
  return input.db.transaction(async (tx) => {
    const [candidate] = await tx.select({ job: outboxJobs }).from(outboxJobs).where(and(
      eq(outboxJobs.state, "failed"),
      inArray(outboxJobs.lastErrorCode, ["disabled", "delivery_failed", "lease_expired"]),
      sql`exists (
        select 1 from ${recoveryOperations}
        join ${meetings} on ${meetings.id} = ${recoveryOperations.meetingId}
        where ${recoveryOperations.id} = ${outboxJobs.operationId}
          and ${recoveryOperations.state} in ('accepted', 'active', 'delayed')
          and coalesce(${recoveryOperations.deadlineAt}, ${recoveryOperations.acceptedAt}) <= clock_timestamp()
          and (${recoveryOperations.workerLeaseOwnerHash} is null
            or ${recoveryOperations.workerLeaseExpiresAt} <= clock_timestamp())
          and ${meetings.status} = 'processing'
          and ${meetings.activeRecoveryOperationId} = ${recoveryOperations.id}
      )`,
    )).orderBy(asc(outboxJobs.updatedAt), asc(outboxJobs.id)).limit(limit);
    if (!candidate) return null;
    const related = await operationAndMeeting(tx, candidate.job.operationId);
    if (!related.operation || !related.meeting) return null;
    const [row] = await tx.select({ job: outboxJobs }).from(outboxJobs).where(and(
      eq(outboxJobs.id, candidate.job.id),
      eq(outboxJobs.state, "failed"),
      inArray(outboxJobs.lastErrorCode, ["disabled", "delivery_failed", "lease_expired"]),
    )).for("update", { skipLocked: true });
    if (!row || row.job.operationId !== related.operation.id) return null;
    const [operation] = await tx.update(recoveryOperations).set({
      state: "failed",
      phase: "failed",
      failureCode: "operation_deadline_exceeded",
      workerLeaseOwnerHash: null,
      workerLeaseExpiresAt: null,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(recoveryOperations.id, related.operation.id),
      eq(recoveryOperations.workerLeaseFence, related.operation.workerLeaseFence),
      inArray(recoveryOperations.state, [...ACTIVE_OPERATION_STATES]),
      sql`coalesce(${recoveryOperations.deadlineAt}, ${recoveryOperations.acceptedAt}) <= clock_timestamp()`,
      sql`(${recoveryOperations.workerLeaseOwnerHash} is null
        or ${recoveryOperations.workerLeaseExpiresAt} <= clock_timestamp())`,
    )).returning({ id: recoveryOperations.id });
    if (!operation) return null;
    await reconcileTerminalProviderReservations(tx, operation.id);
    const [meeting] = await tx.update(meetings).set({
      status: "failed",
      errorCode: "operation_deadline_exceeded",
      errorMessage: "Transcript finalization exceeded its deadline.",
      activeRecoveryOperationId: null,
      recoveryPhase: "failed",
      lastRecoveryOutcome: "failed",
    }).where(and(
      eq(meetings.id, related.meeting.id),
      eq(meetings.status, "processing"),
      eq(meetings.activeRecoveryOperationId, operation.id),
    )).returning({ id: meetings.id });
    if (!meeting) throw new Error("parked deadline meeting fence mismatch");
    await tx.update(outboxJobs).set({
      state: "cancelled",
      leaseOwnerHash: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(outboxJobs.operationId, operation.id),
      sql`${outboxJobs.id} <> ${row.job.id}`,
      inArray(outboxJobs.state, ["pending", "leased", "failed"]),
    ));
    const [failed] = await tx.update(outboxJobs).set({
      state: "failed",
      leaseOwnerHash: null,
      leaseExpiresAt: null,
      lastErrorCode: "operation_deadline_exceeded",
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(outboxJobs.id, row.job.id),
      eq(outboxJobs.state, "failed"),
    )).returning({ id: outboxJobs.id });
    if (!failed) throw new Error("parked deadline job fence mismatch");
    return failed.id;
  });
}

function emptySweep(): SweepResult {
  return { requeued: 0, parked: 0, terminal: 0, delivered: 0 };
}

async function sweepJobs(
  db: Db,
  policy: DurableDeliveryPolicy,
  limit: number,
  mode: "expired" | "repair",
): Promise<SweepResult> {
  if (!Number.isSafeInteger(limit) || limit <= 0) return emptySweep();
  if (!durableDeliveryMaintenanceIsReady(policy)) return emptySweep();
  const readyPolicy = policy;
  return db.transaction(async (tx) => {
    const conditions = mode === "expired"
      ? and(eq(outboxJobs.state, "leased"), sql`${outboxJobs.leaseExpiresAt} <= clock_timestamp()`)
      : and(eq(outboxJobs.state, "failed"), inArray(outboxJobs.lastErrorCode, ["disabled", "delivery_failed", "lease_expired"]));
    const candidates = await tx.select({ job: outboxJobs }).from(outboxJobs).where(conditions)
      .orderBy(asc(outboxJobs.updatedAt), asc(outboxJobs.id)).limit(limit);
    const result = emptySweep();
    if (candidates.length < 1) return result;
    const candidateOperationIds = [...new Set(candidates.map((row) => row.job.operationId))].sort();
    const references = await tx.select({ id: recoveryOperations.id, meetingId: recoveryOperations.meetingId })
      .from(recoveryOperations).where(inArray(recoveryOperations.id, candidateOperationIds));
    const meetingIds = [...new Set(references.map((row) => row.meetingId))].sort();
    const lockedMeetings = meetingIds.length > 0
      ? await tx.select().from(meetings).where(inArray(meetings.id, meetingIds))
        .orderBy(asc(meetings.id)).for("update")
      : [];
    const lockedOperations = await tx.select().from(recoveryOperations)
      .where(inArray(recoveryOperations.id, candidateOperationIds))
      .orderBy(asc(recoveryOperations.id)).for("update");
    const candidateIds = candidates.map((row) => row.job.id);
    const lockedJobs = await tx.select({ job: outboxJobs, databaseNow: sql<Date>`clock_timestamp()` })
      .from(outboxJobs).where(and(conditions, inArray(outboxJobs.id, candidateIds)))
      .orderBy(asc(outboxJobs.updatedAt), asc(outboxJobs.id))
      .limit(limit).for("update", { skipLocked: true });
    const candidateOrder = new Map(candidateIds.map((id, index) => [id, index]));
    const jobs = lockedJobs
      .filter((row) => candidateOrder.has(row.job.id))
      .sort((left, right) => candidateOrder.get(left.job.id)! - candidateOrder.get(right.job.id)!);
    const operationsById = new Map(lockedOperations.map((operation) => [operation.id, operation]));
    const meetingsById = new Map(lockedMeetings.map((meeting) => [meeting.id, meeting]));
    for (const row of jobs) {
      const operation = operationsById.get(row.job.operationId) ?? null;
      const related = {
        operation,
        meeting: operation ? meetingsById.get(operation.meetingId) ?? null : null,
      };
      const exactLease = row.job.leaseOwnerHash
        ? { ownerHash: row.job.leaseOwnerHash, fence: row.job.leaseFence }
        : undefined;
      if (completedWins(related.operation, related.meeting)) {
        const fencedWinner = !!exactLease;
        const completed = await terminalPersistenceFailure(
          tx,
          row.job,
          related.operation,
          related.meeting,
          exactLease,
        );
        if (!completed) await finishOperationJobs(tx, row.job.operationId);
        if (completed && fencedWinner) result.delivered += 1;
        else result.terminal += 1;
        continue;
      }
      const activeParkedOperation = !!related.operation
        && ACTIVE_OPERATION_STATES.includes(related.operation.state as typeof ACTIVE_OPERATION_STATES[number])
        && related.meeting?.status === "processing"
        && related.meeting.activeRecoveryOperationId === related.operation.id;
      if (mode === "repair" && !activeParkedOperation) {
        await finishOperationJobs(tx, row.job.operationId);
        result.terminal += 1;
        continue;
      }
      if (mode === "expired" && (!exactLease
        || related.operation?.workerLeaseOwnerHash !== exactLease.ownerHash
        || related.operation.workerLeaseFence !== exactLease.fence)) {
        await tx.update(outboxJobs).set({
          state: "cancelled",
          leaseOwnerHash: null,
          leaseExpiresAt: null,
          updatedAt: sql`clock_timestamp()`,
        }).where(eq(outboxJobs.id, row.job.id));
        result.parked += 1;
        continue;
      }
      const ageMs = row.databaseNow.getTime() - row.job.createdAt.getTime();
      if (row.job.attempt >= readyPolicy.maxAttempts || ageMs >= readyPolicy.maxAgeMs) {
        if (await terminalPersistenceFailure(tx, row.job, related.operation, related.meeting, exactLease)) {
          result.terminal += 1;
        } else {
          result.parked += 1;
        }
        continue;
      }
      if (mode === "expired" && exactLease) {
        const [cleared] = await tx.update(recoveryOperations).set({
          workerLeaseOwnerHash: null,
          workerLeaseExpiresAt: null,
          updatedAt: sql`clock_timestamp()`,
        }).where(and(
          eq(recoveryOperations.id, row.job.operationId),
          eq(recoveryOperations.workerLeaseOwnerHash, exactLease.ownerHash),
          eq(recoveryOperations.workerLeaseFence, exactLease.fence),
          inArray(recoveryOperations.state, [...ACTIVE_OPERATION_STATES]),
        )).returning({ id: recoveryOperations.id });
        if (!cleared) {
          await tx.update(outboxJobs).set({
            state: "cancelled",
            leaseOwnerHash: null,
            leaseExpiresAt: null,
            updatedAt: sql`clock_timestamp()`,
          }).where(eq(outboxJobs.id, row.job.id));
          result.parked += 1;
          continue;
        }
      }
      await tx.update(outboxJobs).set({
        state: "pending",
        availableAt: related.operation
          ? clampRecoveryWakeToDeadline(
            related.operation,
            mode === "repair"
              ? row.databaseNow
              : new Date(row.databaseNow.getTime() + readyPolicy.retryDelayMs),
          )
          : row.databaseNow,
        leaseOwnerHash: null,
        leaseExpiresAt: null,
        lastErrorCode: mode === "expired" ? "lease_expired" : null,
        updatedAt: sql`clock_timestamp()`,
      }).where(eq(outboxJobs.id, row.job.id));
      result.requeued += 1;
    }
    return result;
  });
}

export async function reapExpiredOutboxJobs(input: {
  db: Db;
  policy: DurableDeliveryPolicy;
  limit: number;
}): Promise<SweepResult> {
  return sweepJobs(input.db, input.policy, input.limit, "expired");
}

export async function repairOutboxJobs(input: {
  db: Db;
  policy: DurableDeliveryPolicy;
  limit: number;
}): Promise<SweepResult> {
  return sweepJobs(input.db, input.policy, input.limit, "repair");
}

export async function outboxQueueHealth(db: Db): Promise<{ due: number; oldestDueAgeMs: number | null }> {
  const [row] = await db.select({
    due: sql<number>`count(*)::int`,
    oldestDueAgeMs: sql<number | null>`case when count(*) = 0 then null else floor(extract(epoch from (clock_timestamp() - min(${outboxJobs.availableAt}))) * 1000)::bigint end`,
  }).from(outboxJobs).where(and(
    eq(outboxJobs.state, "pending"),
    sql`${outboxJobs.availableAt} <= clock_timestamp()`,
  ));
  return { due: row?.due ?? 0, oldestDueAgeMs: row?.oldestDueAgeMs === null ? null : Number(row?.oldestDueAgeMs) };
}

export interface RunOutboxDeliveryOnceInput extends ClaimOutboxJobInput {
  handler(claim: OutboxClaim): Promise<void | "park" | "continue" | "acknowledged" | "already_parked" | "already_waiting" | "stale">;
  repairEnabled: boolean;
  fault?(point: "after_job_claim" | "before_handler" | "after_handler"): void;
}

export type RunOutboxDeliveryResult =
  | { outcome: "idle" }
  | { outcome: "delivered" | "parked" | "retry_scheduled" | "terminal" | "stale"; jobId: string };

/** One content-free delivery iteration. */
export async function runOutboxDeliveryOnce(
  input: RunOutboxDeliveryOnceInput,
): Promise<RunOutboxDeliveryResult> {
  if (!durableDeliveryMaintenanceIsReady(input.policy)) return { outcome: "idle" };
  const deadlineJobId = await enforceParkedOperationDeadline({ db: input.db, limit: 1 });
  if (deadlineJobId) return { outcome: "terminal", jobId: deadlineJobId };
  await reapExpiredOutboxJobs({ db: input.db, policy: input.policy, limit: 1 });
  if (input.repairEnabled) await repairOutboxJobs({ db: input.db, policy: input.policy, limit: 1 });
  const claim = await claimOutboxJob(input);
  if (!claim) return { outcome: "idle" };
  input.fault?.("before_handler");
  let handled: void | "park" | "continue" | "acknowledged" | "already_parked" | "already_waiting" | "stale";
  try {
    handled = await input.handler(claim);
  } catch {
    const outcome = await retryOutboxJob({
      db: input.db,
      jobId: claim.id,
      owner: input.owner,
      fence: claim.fence,
      policy: input.policy,
    });
    return { outcome, jobId: claim.id };
  }
  input.fault?.("after_handler");
  if (handled === "acknowledged") return { outcome: "delivered", jobId: claim.id };
  if (handled === "already_parked") return { outcome: "parked", jobId: claim.id };
  if (handled === "already_waiting") return { outcome: "retry_scheduled", jobId: claim.id };
  if (handled === "stale") return { outcome: "stale", jobId: claim.id };
  if (handled === "continue") {
    const continued = await continueOutboxJob({
      db: input.db,
      jobId: claim.id,
      owner: input.owner,
      fence: claim.fence,
    });
    return { outcome: continued ? "delivered" : "stale", jobId: claim.id };
  }
  if (handled === "park") {
    const parked = await parkOutboxJob({
      db: input.db,
      jobId: claim.id,
      owner: input.owner,
      fence: claim.fence,
    });
    return { outcome: parked ? "parked" : "stale", jobId: claim.id };
  }
  const acknowledged = await acknowledgeOutboxJob({
    db: input.db,
    jobId: claim.id,
    owner: input.owner,
    fence: claim.fence,
  });
  return { outcome: acknowledged ? "delivered" : "stale", jobId: claim.id };
}

export interface DurableDeliveryWorkerHandle {
  stop(): Promise<void>;
}

/** Inert unless every maintenance timing is explicit; dispatch readiness remains separate. */
export function startDurableDeliveryWorker(
  input: RunOutboxDeliveryOnceInput,
): DurableDeliveryWorkerHandle | null {
  if (!durableDeliveryMaintenanceIsReady(input.policy)) return null;
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const result = await runOutboxDeliveryOnce(input);
        if (result.outcome === "idle") await Bun.sleep(input.policy.idleMs!);
      } catch {
        await Bun.sleep(input.policy.idleMs!);
      }
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
    },
  };
}
