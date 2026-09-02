import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "../db/client.ts";
import {
  meetings,
  outboxJobs,
  projectRecoveryBuckets,
  projectRecoveryGuards,
  providerCallLedger,
  recoveryOperations,
  transcriptionChunks,
  transcripts,
} from "../db/schema.ts";
import {
  RecoveryBudgetRejected,
  reserveProjectRecoveryBudgetInTransaction,
  type RecoveryBudgetLimits,
  type RecoveryBudgetTransaction,
} from "../db/recovery-budget.ts";
import type { ErrorCode } from "../domain/errors.ts";
import {
  authoritativeRecoveryDeadline,
  clampRecoveryWakeToDeadline,
} from "../domain/recovery.ts";
import { normalizeSegments } from "../domain/transcript.ts";
import {
  planProviderV2Chunks,
  reconstructProviderV2SampleRange,
  validateProviderV2Plan,
  type ProviderV2Pcm,
  type ProviderV2PlannerLimits,
  type ProviderV2SpeakerInterval,
} from "../providers/transcription/provider-v2-planner.ts";
import type {
  ProviderV2DispatchInput,
  ProviderV2LedgerOutcome,
  ProviderV2Outcome,
  ProviderV2StatusClass,
} from "../providers/transcription/provider-v2.ts";
import { isProviderV2TranscriptionText } from "../providers/transcription/provider-v2.ts";
import {
  validateVexaFallbackCoverage,
  type VexaFallbackLeaf,
} from "../providers/vexa/fallback-coverage.ts";
import type { OutboxClaim } from "./outbox.ts";
import type { RecoveryDispatchAdapter } from "./recovery-runtime.ts";
import { startMeetingFencedCall } from "./meeting-call-fence.ts";

const ACTIVE_STATES = ["accepted", "active", "delayed"] as const;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const ownerHash = (owner: string): string => hash(owner);

export interface DurableFinalizerPolicy {
  readonly fallbackEnabled: boolean;
  readonly maxOperationCalls: number | null;
  readonly maxOperationAudioMs: number | null;
  readonly maxOperationCostMicrounits: bigint | null;
  readonly maxConcurrentCalls: number | null;
  readonly splitFloorMs: number | null;
  readonly retryBackoffMs: number | null;
  readonly maxRetryAfterMs: number | null;
  readonly operationDeadlineMs: number | null;
  readonly delayedThresholdMs: number | null;
  readonly projectLimits: RecoveryBudgetLimits;
  readonly plannerLimits: ProviderV2PlannerLimits;
}

type ReadyPolicy = DurableFinalizerPolicy & {
  readonly maxOperationCalls: number;
  readonly maxOperationAudioMs: number;
  readonly maxOperationCostMicrounits: bigint;
  readonly maxConcurrentCalls: number;
  readonly splitFloorMs: number;
  readonly retryBackoffMs: number;
  readonly maxRetryAfterMs: number;
  readonly operationDeadlineMs: number;
  readonly delayedThresholdMs: number;
};

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nonnegativeBigint = (value: unknown): value is bigint => typeof value === "bigint" && value >= 0n;

/** B3 has no policy defaults: every work, time, retry, concurrency, and economic value is explicit. */
export function durableFinalizerPolicyIsReady(policy: DurableFinalizerPolicy): policy is ReadyPolicy {
  return !!policy
    && typeof policy.fallbackEnabled === "boolean"
    && positive(policy.maxOperationCalls)
    && positive(policy.maxOperationAudioMs)
    && nonnegativeBigint(policy.maxOperationCostMicrounits)
    && positive(policy.maxConcurrentCalls)
    && positive(policy.splitFloorMs)
    && positive(policy.retryBackoffMs)
    && positive(policy.maxRetryAfterMs)
    && positive(policy.operationDeadlineMs)
    && positive(policy.delayedThresholdMs)
    && policy.delayedThresholdMs < policy.operationDeadlineMs
    && nonnegative(policy.projectLimits.manualCycles)
    && nonnegative(policy.projectLimits.automaticCycles)
    && nonnegative(policy.projectLimits.sharedCalls)
    && nonnegative(policy.projectLimits.sharedAudioMs)
    && nonnegativeBigint(policy.projectLimits.sharedCostMicrounits)
    && !!policy.plannerLimits;
}

export function boundedRetryAfterMs(
  value: unknown,
  policy: Pick<DurableFinalizerPolicy, "retryBackoffMs" | "maxRetryAfterMs">,
): number {
  if (!positive(policy.retryBackoffMs) || !positive(policy.maxRetryAfterMs)) {
    throw new TypeError("retry timing policy is unset");
  }
  return positive(value) && value <= policy.maxRetryAfterMs
    ? Math.max(policy.retryBackoffMs, value)
    : policy.retryBackoffMs;
}

export type DurableProviderClassification =
  | "success"
  | "timeout"
  | "retryable"
  | "terminal_rejected"
  | "terminal_authorization"
  | "terminal_attestation"
  | "terminal_persistence";

export function classifyDurableProviderOutcome(outcome: ProviderV2Outcome): DurableProviderClassification {
  if (outcome.kind === "success") return "success";
  if (outcome.kind === "timeout" && (outcome.outcomeCode === "timeout" || outcome.outcomeCode === "http_408")) {
    return "timeout";
  }
  if (outcome.kind === "unavailable" && ["transport_error", "http_429", "http_5xx"].includes(outcome.outcomeCode)) {
    return "retryable";
  }
  if (outcome.kind === "authorization") return "terminal_authorization";
  if (outcome.kind === "attestation_failed") return "terminal_attestation";
  if (outcome.kind === "persistence_failed") return "terminal_persistence";
  return "terminal_rejected";
}

export interface DurableRecordingBoundary {
  /** Called only while no durable plan exists. The returned PCM is never stored by this module. */
  prepare(input: { operationId: string; meetingId: string }): Promise<{
    pcm: ProviderV2Pcm | null;
    speakerIntervals: readonly ProviderV2SpeakerInterval[];
  }>;
  /** Trusted slicing/encoding boundary; it must return only the requested deterministic interval. */
  encode(input: {
    operationId: string;
    startSample: number;
    endSample: number;
    sampleRate: number;
    totalSamples: number;
  }): Promise<{ audio: Uint8Array; contentType: string }>;
}

export interface DurableProviderAttemptResult {
  readonly outcome: ProviderV2Outcome;
  /** Already parsed from a syntactically valid provider header, in integer milliseconds. */
  readonly retryAfterMs?: unknown;
}

export interface DurableProviderBoundary {
  readonly ready: boolean;
  dispatch(input: ProviderV2DispatchInput): Promise<DurableProviderAttemptResult>;
}

export interface DurableFallbackBoundary {
  readonly ready: boolean;
  coverage(input: {
    readonly operationId: string;
    readonly meetingId: string;
    readonly sampleRate: number;
    readonly sampleCount: number;
    readonly leaves: readonly VexaFallbackLeaf[];
  }): Promise<unknown>;
}

export interface DurableDispatchBreaker {
  allowsDispatch(): boolean;
  trip(reason: "authorization"): void;
}

export interface ProtectedCheckpoint {
  readonly ciphertext: string;
  readonly nonce: string;
  readonly keyVersion: string;
}

export interface CheckpointProtector {
  readonly ready: boolean;
  protect(plaintext: string): Promise<ProtectedCheckpoint>;
  unprotect(checkpoint: ProtectedCheckpoint): Promise<string>;
}

export interface DurableFinalizerIds {
  id(kind: "chunk" | "ledger" | "outbox", stableInput: string): string;
}

const DEFAULT_IDS: DurableFinalizerIds = Object.freeze({
  id(kind: "chunk" | "ledger" | "outbox", stableInput: string) {
    return `${kind === "chunk" ? "chk" : kind === "ledger" ? "led" : "obx"}_b3_${hash(stableInput).slice(0, 24)}`;
  },
});

export type DurableFinalizerFaultPoint =
  | "after_plan"
  | "after_reservation"
  | "after_dispatch_marked"
  | "after_provider"
  | "after_checkpoint"
  | "after_fallback_checkpoint"
  | "before_publication"
  | "after_publication";

export interface DurableFinalizerInput {
  readonly db: Db;
  readonly claim: OutboxClaim;
  readonly owner: string;
  readonly policy: DurableFinalizerPolicy;
  readonly recording: DurableRecordingBoundary;
  readonly provider: DurableProviderBoundary;
  readonly breaker: DurableDispatchBreaker;
  readonly protector: CheckpointProtector;
  readonly fallback?: DurableFallbackBoundary;
  readonly priceAttempt: (input: { submittedAudioMs: number; submittedBytes: number }) => bigint | null;
  readonly ids?: DurableFinalizerIds;
  readonly fault?: (point: DurableFinalizerFaultPoint) => void;
}

export type DurableFinalizerStepResult = "continued" | "completed" | "terminal" | "parked" | "waiting" | "stale";
type Tx = RecoveryBudgetTransaction;

interface LockedContext {
  job: typeof outboxJobs.$inferSelect;
  operation: typeof recoveryOperations.$inferSelect;
  meeting: typeof meetings.$inferSelect;
  databaseNow: Date;
}

function leaseWhere(input: DurableFinalizerInput) {
  return and(
    eq(outboxJobs.id, input.claim.id),
    eq(outboxJobs.operationId, input.claim.operationId),
    eq(outboxJobs.state, "leased"),
    eq(outboxJobs.leaseOwnerHash, ownerHash(input.owner)),
    eq(outboxJobs.leaseFence, input.claim.fence),
    sql`${outboxJobs.leaseExpiresAt} > clock_timestamp()`,
  );
}

function operationLeaseWhere(input: DurableFinalizerInput) {
  return and(
    eq(recoveryOperations.id, input.claim.operationId),
    eq(recoveryOperations.workerLeaseOwnerHash, ownerHash(input.owner)),
    eq(recoveryOperations.workerLeaseFence, input.claim.fence),
    sql`${recoveryOperations.workerLeaseExpiresAt} > clock_timestamp()`,
    inArray(recoveryOperations.state, [...ACTIVE_STATES]),
  );
}

async function lockContext(tx: Tx, input: DurableFinalizerInput): Promise<LockedContext | null> {
  const [reference] = await tx.select({ meetingId: recoveryOperations.meetingId })
    .from(recoveryOperations).where(eq(recoveryOperations.id, input.claim.operationId)).limit(1);
  if (!reference) return null;
  // Global recovery lock order: meeting -> operation -> outbox -> chunks -> provider ledger ->
  // project guard/bucket. The initial reference read is deliberately non-locking; every mutation is
  // revalidated only after the meeting fence is held.
  const [meeting] = await tx.select().from(meetings).where(and(
    eq(meetings.id, reference.meetingId),
    eq(meetings.status, "processing"),
    eq(meetings.activeRecoveryOperationId, input.claim.operationId),
    isNull(meetings.deletedAt),
  )).for("update");
  if (!meeting) return null;
  const [operation] = await tx.select().from(recoveryOperations).where(operationLeaseWhere(input)).for("update");
  if (!operation || operation.meetingId !== meeting.id) return null;
  const [job] = await tx.select({ job: outboxJobs, databaseNow: sql<Date>`clock_timestamp()` })
    .from(outboxJobs).where(leaseWhere(input)).for("update");
  return job ? { job: job.job, operation, meeting, databaseNow: job.databaseNow } : null;
}

async function lockChunkBeforeLedger(
  tx: Tx,
  operationId: string,
  ledgerId: string,
  dispatchState: "reserved" | "dispatching",
): Promise<{
  ledger: typeof providerCallLedger.$inferSelect;
  chunk: typeof transcriptionChunks.$inferSelect | null;
} | null> {
  const [reference] = await tx.select({ chunkId: providerCallLedger.chunkId }).from(providerCallLedger).where(and(
    eq(providerCallLedger.id, ledgerId),
    eq(providerCallLedger.operationId, operationId),
    eq(providerCallLedger.dispatchState, dispatchState),
  )).limit(1);
  if (!reference) return null;
  const [chunk] = await tx.select().from(transcriptionChunks)
    .where(and(eq(transcriptionChunks.id, reference.chunkId), eq(transcriptionChunks.operationId, operationId)))
    .for("update");
  const [ledger] = await tx.select().from(providerCallLedger).where(and(
    eq(providerCallLedger.id, ledgerId),
    eq(providerCallLedger.operationId, operationId),
    eq(providerCallLedger.chunkId, reference.chunkId),
    eq(providerCallLedger.dispatchState, dispatchState),
  )).for("update");
  return ledger ? { ledger, chunk: chunk ?? null } : null;
}

function deadlineExpired(context: LockedContext): boolean {
  return context.databaseNow.getTime() >= authoritativeRecoveryDeadline(context.operation).getTime();
}

function failureMessage(code: ErrorCode): string {
  const messages: Partial<Record<ErrorCode, string>> = {
    operation_deadline_exceeded: "Transcript finalization exceeded its deadline.",
    provider_timeout: "The transcription provider timed out.",
    provider_unavailable: "The transcription provider is unavailable.",
    provider_rejected: "The transcription provider rejected this request.",
    attestation_failed: "Provider verification failed.",
    recording_absent: "The recording is unavailable.",
    recording_undecodable: "The recording could not be decoded.",
    recording_silent: "The recording contains no usable audio.",
    budget_exhausted: "The recovery budget is exhausted.",
    coverage_incomplete: "Transcript coverage is incomplete.",
    persistence_failed: "Recovery state could not be persisted.",
    validation_failed: "The request is invalid.",
  };
  return messages[code] ?? "Transcription failed.";
}

async function cancelOtherWork(tx: Tx, operationId: string, currentJobId: string): Promise<void> {
  await tx.update(outboxJobs).set({
    state: "cancelled",
    leaseOwnerHash: null,
    leaseExpiresAt: null,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(
    eq(outboxJobs.operationId, operationId),
    sql`${outboxJobs.id} <> ${currentJobId}`,
    inArray(outboxJobs.state, ["pending", "leased", "failed"]),
  ));
}

async function terminalInTransaction(
  tx: Tx,
  input: DurableFinalizerInput,
  context: LockedContext,
  code: ErrorCode,
): Promise<boolean> {
  const [operation] = await tx.update(recoveryOperations).set({
    state: "failed",
    phase: "failed",
    failureCode: code,
    workerLeaseOwnerHash: null,
    workerLeaseExpiresAt: null,
    completedAt: sql`clock_timestamp()`,
    updatedAt: sql`clock_timestamp()`,
  }).where(operationLeaseWhere(input)).returning({ id: recoveryOperations.id });
  if (!operation) return false;
  const [meeting] = await tx.update(meetings).set({
    status: "failed",
    errorCode: code,
    errorMessage: failureMessage(code),
    activeRecoveryOperationId: null,
    recoveryPhase: "failed",
    lastRecoveryOutcome: code === "budget_exhausted" ? "budget_exhausted" : "failed",
  }).where(and(
    eq(meetings.id, context.meeting.id),
    eq(meetings.status, "processing"),
    eq(meetings.activeRecoveryOperationId, operation.id),
  )).returning({ id: meetings.id });
  if (!meeting) throw new Error("durable finalizer meeting fence mismatch");
  const [job] = await tx.update(outboxJobs).set({
    state: "delivered",
    leaseOwnerHash: null,
    leaseExpiresAt: null,
    updatedAt: sql`clock_timestamp()`,
  }).where(leaseWhere(input)).returning({ id: outboxJobs.id });
  if (!job) throw new Error("durable finalizer job fence mismatch");
  await cancelOtherWork(tx, operation.id, job.id);
  return true;
}

async function terminal(input: DurableFinalizerInput, code: ErrorCode): Promise<DurableFinalizerStepResult> {
  return input.db.transaction(async (tx) => {
    const context = await lockContext(tx, input);
    if (!context) return "stale";
    return await terminalInTransaction(tx, input, context, code) ? "terminal" : "stale";
  });
}

async function park(input: DurableFinalizerInput): Promise<DurableFinalizerStepResult> {
  return input.db.transaction(async (tx) => {
    const context = await lockContext(tx, input);
    if (!context) return "stale";
    const [operation] = await tx.update(recoveryOperations).set({
      state: "delayed",
      phase: "disabled",
      workerLeaseOwnerHash: null,
      workerLeaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(operationLeaseWhere(input)).returning({ id: recoveryOperations.id });
    if (!operation) return "stale";
    await tx.update(meetings).set({ recoveryPhase: "disabled" }).where(and(
      eq(meetings.id, context.meeting.id),
      eq(meetings.activeRecoveryOperationId, operation.id),
      eq(meetings.status, "processing"),
    ));
    await tx.update(outboxJobs).set({
      state: "failed",
      leaseOwnerHash: null,
      leaseExpiresAt: null,
      lastErrorCode: "disabled",
      updatedAt: sql`clock_timestamp()`,
    }).where(leaseWhere(input));
    return "parked";
  });
}

function nextJob(ids: DurableFinalizerIds, operationId: string, stable: string) {
  const dedupeKeyHash = hash(`b3:${operationId}:${stable}`);
  return { id: ids.id("outbox", dedupeKeyHash), dedupeKeyHash };
}

async function schedule(
  tx: Tx,
  ids: DurableFinalizerIds,
  context: LockedContext,
  stable: string,
  availableAt: Date,
  chunkId: string | null = null,
  eventType: "operation.resume" | "chunk.retry" | "transcript.publish" = "operation.resume",
): Promise<void> {
  const job = nextJob(ids, context.operation.id, stable);
  const boundedAvailableAt = clampRecoveryWakeToDeadline(context.operation, availableAt);
  await tx.insert(outboxJobs).values({
    ...job,
    projectId: context.operation.projectId,
    operationId: context.operation.id,
    chunkId,
    eventType,
    state: "pending",
    availableAt: boundedAvailableAt,
  }).onConflictDoNothing();
}

async function persistTruthfulScheduledPhase(
  tx: Tx,
  input: DurableFinalizerInput,
  ids: DurableFinalizerIds,
  context: LockedContext,
  availableAt: Date,
): Promise<void> {
  if (!context.operation.delayedAt) return;
  if (context.databaseNow.getTime() < context.operation.delayedAt.getTime()) {
    if (availableAt.getTime() >= context.operation.delayedAt.getTime()) {
      await schedule(
        tx,
        ids,
        context,
        `delayed-threshold:${context.operation.delayedAt.toISOString()}`,
        context.operation.delayedAt,
      );
    }
    return;
  }
  if (context.operation.phase === "delayed" && context.meeting.recoveryPhase === "delayed") return;
  const [operation] = await tx.update(recoveryOperations).set({
    state: "delayed",
    phase: "delayed",
    updatedAt: sql`clock_timestamp()`,
  }).where(operationLeaseWhere(input)).returning({ id: recoveryOperations.id });
  if (!operation) throw new Error("durable scheduled phase fence mismatch");
  const [meeting] = await tx.update(meetings).set({ recoveryPhase: "delayed" }).where(and(
    eq(meetings.id, context.meeting.id),
    eq(meetings.status, "processing"),
    eq(meetings.activeRecoveryOperationId, operation.id),
  )).returning({ id: meetings.id });
  if (!meeting) throw new Error("durable scheduled meeting fence mismatch");
}

function planFailure(error: string): ErrorCode {
  if (error === "missing_pcm") return "recording_absent";
  if (error === "silent_recording") return "recording_silent";
  if (error === "undecodable_pcm" || error === "inconsistent_pcm_duration") return "recording_undecodable";
  if (error === "chunk_budget_exceeded" || error === "audio_budget_exceeded") return "budget_exhausted";
  return "validation_failed";
}

async function planStep(
  input: DurableFinalizerInput,
  policy: ReadyPolicy,
  initial: LockedContext,
  ids: DurableFinalizerIds,
): Promise<DurableFinalizerStepResult> {
  let prepared: Awaited<ReturnType<DurableRecordingBoundary["prepare"]>>;
  try {
    const started = await startMeetingFencedCall(
      input.db,
      initial.meeting.id,
      async (tx) => {
        const context = await lockContext(tx, input);
        return context && context.operation.sourceSampleRateHz === null
          && context.operation.sourceSampleCount === null
          ? { operationId: context.operation.id, meetingId: context.meeting.id }
          : null;
      },
      (authority) => input.recording.prepare(authority),
    );
    if (started.kind === "stale") return "stale";
    prepared = await started.response;
  } catch {
    return terminal(input, "recording_undecodable");
  }
  const planningInput = { ...prepared, limits: policy.plannerLimits };
  const result = planProviderV2Chunks(planningInput);
  if (result.kind === "rejected") return terminal(input, planFailure(result.error));
  if (validateProviderV2Plan(result.plan, planningInput) !== null) return terminal(input, "validation_failed");

  let minimumCost = 0n;
  try {
    for (const chunk of result.plan.chunks) {
      const price = input.priceAttempt({ submittedAudioMs: chunk.submittedAudioMs, submittedBytes: chunk.wavBytes });
      if (!nonnegativeBigint(price)) return park(input);
      minimumCost += price;
    }
  } catch {
    return park(input);
  }
  if (result.plan.chunks.length > policy.maxOperationCalls
    || result.plan.totalSubmittedAudioMs > policy.maxOperationAudioMs
    || minimumCost > policy.maxOperationCostMicrounits
    || result.plan.chunks.length > policy.projectLimits.sharedCalls!
    || result.plan.totalSubmittedAudioMs > policy.projectLimits.sharedAudioMs!
    || minimumCost > policy.projectLimits.sharedCostMicrounits!) {
    return terminal(input, "budget_exhausted");
  }

  const persisted = await input.db.transaction(async (tx) => {
    const context = await lockContext(tx, input);
    if (!context || context.operation.sourceSampleRateHz !== null) return false;
    if (deadlineExpired(context)) {
      await terminalInTransaction(tx, input, context, "operation_deadline_exceeded");
      return true;
    }
    const delayedAt = new Date(context.operation.acceptedAt.getTime() + policy.delayedThresholdMs);
    const delayed = context.databaseNow.getTime() >= delayedAt.getTime();
    await tx.insert(transcriptionChunks).values(result.plan.chunks.map((chunk) => ({
      id: ids.id("chunk", `${context.operation.id}:root:${chunk.ordinal}`),
      operationId: context.operation.id,
      ordinal: chunk.ordinal,
      version: 1,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      speakerRefHash: hash(chunk.speaker),
      provenance: "provider",
      state: "planned",
      attempt: 0,
      retryCount: 0,
      leaseFence: input.claim.fence,
    }))).onConflictDoNothing();
    const [operation] = await tx.update(recoveryOperations).set({
      plannedAudioMs: result.plan.durationMs,
      sourceSampleRateHz: result.plan.sampleRate,
      sourceSampleCount: result.plan.totalSamples,
      delayedAt,
      state: delayed ? "delayed" : "active",
      phase: delayed ? "delayed" : "transcribing",
      updatedAt: sql`clock_timestamp()`,
    }).where(operationLeaseWhere(input)).returning({ id: recoveryOperations.id });
    if (!operation) throw new Error("durable finalizer planning fence mismatch");
    await tx.update(meetings).set({ recoveryPhase: delayed ? "delayed" : "transcribing" })
      .where(eq(meetings.id, context.meeting.id));
    await schedule(tx, ids, context, "planned", context.databaseNow);
    return true;
  });
  if (!persisted) return "stale";
  input.fault?.("after_plan");
  return "continued";
}

function wavBytesForRange(startSample: number, endSample: number): number {
  const value = 44 + (endSample - startSample) * 2;
  if (!positive(value)) throw new TypeError("invalid deterministic WAV size");
  return value;
}

function currentLeaves(chunks: readonly (typeof transcriptionChunks.$inferSelect)[]) {
  return chunks.filter((chunk) => chunk.state !== "split");
}

async function reserveStep(
  input: DurableFinalizerInput,
  policy: ReadyPolicy,
  ids: DurableFinalizerIds,
  selectedId: string,
): Promise<DurableFinalizerStepResult> {
  try {
    const result = await input.db.transaction(async (tx) => {
      const context = await lockContext(tx, input);
      if (!context) return "stale" as const;
      if (deadlineExpired(context)) {
        await terminalInTransaction(tx, input, context, "operation_deadline_exceeded");
        return "terminal" as const;
      }
      const [chunk] = await tx.select().from(transcriptionChunks).where(and(
        eq(transcriptionChunks.id, selectedId),
        eq(transcriptionChunks.operationId, context.operation.id),
        eq(transcriptionChunks.state, "planned"),
      )).for("update");
      if (!chunk || context.operation.sourceSampleRateHz === null || context.operation.sourceSampleCount === null) return "stale" as const;
      const range = reconstructProviderV2SampleRange(
        chunk.startMs,
        chunk.endMs,
        context.operation.sourceSampleRateHz,
        context.operation.sourceSampleCount,
        chunk.endMs === context.operation.plannedAudioMs,
      );
      const submittedAudioMs = chunk.endMs - chunk.startMs;
      const submittedBytes = wavBytesForRange(range.startSample, range.endSample);
      const cost = input.priceAttempt({ submittedAudioMs, submittedBytes });
      if (!nonnegativeBigint(cost)) return "parked" as const;

      const ledgerRows = await tx.select().from(providerCallLedger)
        .where(eq(providerCallLedger.operationId, context.operation.id)).for("update");
      const accountedRows = ledgerRows.filter((row) => row.dispatchState !== "not_dispatched");
      const totalCalls = accountedRows.length;
      const totalAudio = accountedRows.reduce((sum, row) => sum + row.submittedAudioMs, 0);
      const totalCost = accountedRows.reduce((sum, row) => sum + row.reservedCostMicrounits, 0n);
      if (totalCalls + 1 > policy.maxOperationCalls
        || totalAudio + submittedAudioMs > policy.maxOperationAudioMs
        || totalCost + cost > policy.maxOperationCostMicrounits) {
        await terminalInTransaction(tx, input, context, "budget_exhausted");
        return "terminal" as const;
      }
      if (context.operation.kind !== "manual" && context.operation.kind !== "automatic") {
        await terminalInTransaction(tx, input, context, "validation_failed");
        return "terminal" as const;
      }
      const budget = await reserveProjectRecoveryBudgetInTransaction(tx, {
        projectId: context.operation.projectId,
        kind: context.operation.kind,
        reservation: { cycles: 0, calls: 1, audioMs: submittedAudioMs, costMicrounits: cost },
        limits: policy.projectLimits,
      });
      const attempt = chunk.attempt + 1;
      const ledgerId = ids.id("ledger", `${context.operation.id}:${chunk.id}:${attempt}`);
      await tx.insert(providerCallLedger).values({
        id: ledgerId,
        projectId: context.operation.projectId,
        operationId: context.operation.id,
        chunkId: chunk.id,
        reservationKeyHash: hash(`${context.operation.id}:${chunk.id}:${attempt}`),
        kind: context.operation.kind,
        submittedAudioMs,
        submittedBytes,
        reservedCostMicrounits: cost,
        spentCostMicrounits: 0n,
        attempt,
        dispatchState: "reserved",
        leaseFence: input.claim.fence,
        budgetBucketMinute: budget.bucketMinute,
      });
      await tx.update(transcriptionChunks).set({
        state: "reserved",
        attempt,
        providerCallLedgerId: ledgerId,
        leaseFence: input.claim.fence,
        updatedAt: sql`clock_timestamp()`,
      }).where(eq(transcriptionChunks.id, chunk.id));
      const delayed = context.databaseNow.getTime() >= (context.operation.delayedAt?.getTime() ?? MAX_SAFE);
      await tx.update(recoveryOperations).set({
        reservedCalls: sql`${recoveryOperations.reservedCalls} + 1`,
        reservedCostMicrounits: sql`${recoveryOperations.reservedCostMicrounits} + ${cost}`,
        phase: delayed ? "delayed" : "transcribing",
        state: delayed ? "delayed" : "active",
        updatedAt: sql`clock_timestamp()`,
      }).where(operationLeaseWhere(input));
      await tx.update(meetings).set({ recoveryPhase: delayed ? "delayed" : "transcribing" }).where(and(
        eq(meetings.id, context.meeting.id),
        eq(meetings.status, "processing"),
        eq(meetings.activeRecoveryOperationId, context.operation.id),
      ));
      await schedule(tx, ids, context, `dispatch:${chunk.id}:${attempt}`, context.databaseNow, chunk.id);
      return "continued" as const;
    });
    if (result === "parked") return park(input);
    if (result === "continued") input.fault?.("after_reservation");
    return result;
  } catch (error) {
    if (error instanceof RecoveryBudgetRejected) return terminal(input, "budget_exhausted");
    throw error;
  }
}

async function lockProjectGuard(tx: Tx, projectId: string): Promise<void> {
  await tx.insert(projectRecoveryGuards).values({ projectId }).onConflictDoNothing();
  await tx.select().from(projectRecoveryGuards).where(eq(projectRecoveryGuards.projectId, projectId)).for("update");
}

async function moveReservationToSpent(tx: Tx, ledger: typeof providerCallLedger.$inferSelect): Promise<void> {
  await lockProjectGuard(tx, ledger.projectId);
  const [bucket] = await tx.update(projectRecoveryBuckets).set({
    reservedCalls: sql`${projectRecoveryBuckets.reservedCalls} - 1`,
    spentCalls: sql`${projectRecoveryBuckets.spentCalls} + 1`,
    reservedAudioMs: sql`${projectRecoveryBuckets.reservedAudioMs} - ${ledger.submittedAudioMs}`,
    spentAudioMs: sql`${projectRecoveryBuckets.spentAudioMs} + ${ledger.submittedAudioMs}`,
    reservedCostMicrounits: sql`${projectRecoveryBuckets.reservedCostMicrounits} - ${ledger.reservedCostMicrounits}`,
    spentCostMicrounits: sql`${projectRecoveryBuckets.spentCostMicrounits} + ${ledger.reservedCostMicrounits}`,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(
    eq(projectRecoveryBuckets.projectId, ledger.projectId),
    eq(projectRecoveryBuckets.bucketMinute, ledger.budgetBucketMinute),
    sql`${projectRecoveryBuckets.reservedCalls} >= 1`,
    sql`${projectRecoveryBuckets.reservedAudioMs} >= ${ledger.submittedAudioMs}`,
    sql`${projectRecoveryBuckets.reservedCostMicrounits} >= ${ledger.reservedCostMicrounits}`,
  )).returning({ projectId: projectRecoveryBuckets.projectId });
  if (!bucket) throw new Error("durable provider reservation bucket mismatch");
  const [operation] = await tx.update(recoveryOperations).set({
    reservedCalls: sql`${recoveryOperations.reservedCalls} - 1`,
    spentCalls: sql`${recoveryOperations.spentCalls} + 1`,
    submittedAudioMs: sql`${recoveryOperations.submittedAudioMs} + ${ledger.submittedAudioMs}`,
    reservedCostMicrounits: sql`${recoveryOperations.reservedCostMicrounits} - ${ledger.reservedCostMicrounits}`,
    spentCostMicrounits: sql`${recoveryOperations.spentCostMicrounits} + ${ledger.reservedCostMicrounits}`,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(
    eq(recoveryOperations.id, ledger.operationId),
    sql`${recoveryOperations.reservedCalls} >= 1`,
    sql`${recoveryOperations.reservedCostMicrounits} >= ${ledger.reservedCostMicrounits}`,
  )).returning({ id: recoveryOperations.id });
  if (!operation) throw new Error("durable provider operation reservation mismatch");
}

async function refundReservation(tx: Tx, ledger: typeof providerCallLedger.$inferSelect): Promise<void> {
  await lockProjectGuard(tx, ledger.projectId);
  const [bucket] = await tx.update(projectRecoveryBuckets).set({
    reservedCalls: sql`${projectRecoveryBuckets.reservedCalls} - 1`,
    reservedAudioMs: sql`${projectRecoveryBuckets.reservedAudioMs} - ${ledger.submittedAudioMs}`,
    reservedCostMicrounits: sql`${projectRecoveryBuckets.reservedCostMicrounits} - ${ledger.reservedCostMicrounits}`,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(
    eq(projectRecoveryBuckets.projectId, ledger.projectId),
    eq(projectRecoveryBuckets.bucketMinute, ledger.budgetBucketMinute),
    sql`${projectRecoveryBuckets.reservedCalls} >= 1`,
    sql`${projectRecoveryBuckets.reservedAudioMs} >= ${ledger.submittedAudioMs}`,
    sql`${projectRecoveryBuckets.reservedCostMicrounits} >= ${ledger.reservedCostMicrounits}`,
  )).returning({ projectId: projectRecoveryBuckets.projectId });
  if (!bucket) throw new Error("durable provider refund bucket mismatch");
  const [operation] = await tx.update(recoveryOperations).set({
    reservedCalls: sql`${recoveryOperations.reservedCalls} - 1`,
    reservedCostMicrounits: sql`${recoveryOperations.reservedCostMicrounits} - ${ledger.reservedCostMicrounits}`,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(
    eq(recoveryOperations.id, ledger.operationId),
    sql`${recoveryOperations.reservedCalls} >= 1`,
    sql`${recoveryOperations.reservedCostMicrounits} >= ${ledger.reservedCostMicrounits}`,
  )).returning({ id: recoveryOperations.id });
  if (!operation) throw new Error("durable provider operation refund mismatch");
}

async function finishUnspentReservation(
  tx: Tx,
  ledger: typeof providerCallLedger.$inferSelect,
  resetChunk: boolean,
): Promise<void> {
  await refundReservation(tx, ledger);
  const [completed] = await tx.update(providerCallLedger).set({
    dispatchState: "not_dispatched",
    outcomeCode: "not_dispatched",
    statusClass: "none",
    spentCostMicrounits: 0n,
    completedAt: sql`clock_timestamp()`,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(
    eq(providerCallLedger.id, ledger.id),
    inArray(providerCallLedger.dispatchState, ["reserved", "dispatching"]),
  )).returning({ id: providerCallLedger.id });
  if (!completed) throw new Error("durable provider unspent ledger mismatch");
  if (!resetChunk) return;
  const [chunk] = await tx.update(transcriptionChunks).set({
    state: "planned",
    providerCallLedgerId: null,
    nextEligibleAt: null,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(
    eq(transcriptionChunks.id, ledger.chunkId),
    eq(transcriptionChunks.state, "reserved"),
    eq(transcriptionChunks.providerCallLedgerId, ledger.id),
  )).returning({ id: transcriptionChunks.id });
  if (!chunk) throw new Error("durable provider unspent chunk mismatch");
}

function syntheticUnknown(): ProviderV2Outcome {
  return {
    kind: "unavailable",
    errorCode: "provider_unavailable",
    attempted: true,
    spent: true,
    outcomeCode: "unknown",
    statusClass: "none",
  } as ProviderV2Outcome;
}

function thrownTransport(): ProviderV2Outcome {
  return {
    kind: "unavailable",
    errorCode: "provider_unavailable",
    attempted: true,
    spent: true,
    outcomeCode: "transport_error",
    statusClass: "network",
  };
}

function invalidSuccessfulResponse(): ProviderV2Outcome {
  return {
    kind: "invalid_response",
    errorCode: "provider_rejected",
    attempted: true,
    spent: true,
    outcomeCode: "invalid_response",
    statusClass: "2xx",
  };
}

function spentPersistenceUnknown(): ProviderV2Outcome {
  return {
    kind: "persistence_failed",
    errorCode: "persistence_failed",
    attempted: true,
    spent: true,
    outcomeCode: "unknown",
    statusClass: "none",
  };
}

type OwnDataResult = { readonly state: "absent" } | { readonly state: "data"; readonly value: unknown };

/** Inspect an injected structural value without invoking an own accessor. */
function ownData(value: unknown, key: PropertyKey): OwnDataResult | null {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { state: "absent" };
    if (!("value" in descriptor)) return null;
    return { state: "data", value: descriptor.value };
  } catch {
    return null;
  }
}

function requiredOwnData(value: unknown, key: PropertyKey): unknown | null {
  const result = ownData(value, key);
  return result?.state === "data" ? result.value : null;
}

/**
 * The provider boundary is structurally injectable in tests and future wiring. Rebuild only exact
 * provider-v2 contract tuples so no raw object, extra field, or accessor crosses into accounting.
 */
function canonicalProviderOutcome(value: unknown): ProviderV2Outcome | null {
  const kind = requiredOwnData(value, "kind");
  const attempted = requiredOwnData(value, "attempted");
  const spent = requiredOwnData(value, "spent");
  const outcomeCode = requiredOwnData(value, "outcomeCode");
  const statusClass = requiredOwnData(value, "statusClass");
  if (kind === null || attempted === null || spent === null || outcomeCode === null || statusClass === null) return null;

  const error = ownData(value, "errorCode");
  const data = ownData(value, "data");
  if (!error || !data) return null;
  if (kind === "success") {
    if (error.state !== "absent" || data.state !== "data"
      || attempted !== true || spent !== true || outcomeCode !== "success" || statusClass !== "2xx") return null;
    if ((typeof data.value !== "object" && typeof data.value !== "function") || data.value === null) {
      return invalidSuccessfulResponse();
    }
    const text = ownData(data.value, "text");
    if (!text) return null;
    if (text.state !== "data" || !isProviderV2TranscriptionText(text.value)) return invalidSuccessfulResponse();
    return { kind: "success", data: { text: text.value }, attempted: true, spent: true, outcomeCode: "success", statusClass: "2xx" };
  }
  if (data.state !== "absent" || error.state !== "data" || typeof error.value !== "string") return null;

  if (attempted === false && spent === false && outcomeCode === "not_dispatched" && statusClass === "none") {
    if (kind === "authorization" && error.value === "provider_rejected") {
      return { kind, errorCode: "provider_rejected", attempted, spent, outcomeCode, statusClass };
    }
    if (kind === "attestation_failed" && error.value === "attestation_failed") {
      return { kind, errorCode: "attestation_failed", attempted, spent, outcomeCode, statusClass };
    }
    if (kind === "persistence_failed" && error.value === "persistence_failed") {
      return { kind, errorCode: "persistence_failed", attempted, spent, outcomeCode, statusClass };
    }
    return null;
  }
  if (attempted !== true || spent !== true) return null;
  if (kind === "timeout" && error.value === "provider_timeout") {
    if (outcomeCode === "timeout" && statusClass === "network") {
      return { kind, errorCode: "provider_timeout", attempted, spent, outcomeCode, statusClass };
    }
    if (outcomeCode === "http_408" && statusClass === "4xx") {
      return { kind, errorCode: "provider_timeout", attempted, spent, outcomeCode, statusClass };
    }
    return null;
  }
  if (kind === "unavailable" && error.value === "provider_unavailable") {
    if ((outcomeCode === "transport_error" && statusClass === "network")
      || (outcomeCode === "http_429" && statusClass === "4xx")
      || (outcomeCode === "http_5xx" && statusClass === "5xx")) {
      return { kind, errorCode: "provider_unavailable", attempted, spent, outcomeCode, statusClass };
    }
    return null;
  }
  if ((kind === "rejected" || kind === "authorization")
    && error.value === "provider_rejected" && outcomeCode === "http_4xx" && statusClass === "4xx") {
    return { kind, errorCode: "provider_rejected", attempted, spent, outcomeCode, statusClass };
  }
  if (kind === "invalid_response" && error.value === "provider_rejected"
    && outcomeCode === "invalid_response" && (statusClass === "2xx" || statusClass === "none")) {
    return { kind, errorCode: "provider_rejected", attempted, spent, outcomeCode, statusClass };
  }
  if (kind === "attestation_failed" && error.value === "attestation_failed"
    && outcomeCode === "attestation_failed" && statusClass === "none") {
    return { kind, errorCode: "attestation_failed", attempted, spent, outcomeCode, statusClass };
  }
  if (kind === "persistence_failed" && error.value === "persistence_failed"
    && outcomeCode === "unknown" && statusClass === "none") {
    return { kind, errorCode: "persistence_failed", attempted, spent, outcomeCode, statusClass };
  }
  return null;
}

function canonicalProviderAttemptResult(value: unknown): DurableProviderAttemptResult | null {
  const outcome = ownData(value, "outcome");
  const retryAfter = ownData(value, "retryAfterMs");
  if (!outcome || outcome.state !== "data" || !retryAfter) return null;
  const canonical = canonicalProviderOutcome(outcome.value);
  if (!canonical) return null;
  return retryAfter.state === "data"
    ? { outcome: canonical, retryAfterMs: retryAfter.value }
    : { outcome: canonical };
}

interface Settlement {
  outcome: ProviderV2Outcome;
  retryAfterMs?: unknown;
  checkpoint?: ProtectedCheckpoint & { contentHash: string };
  unknown?: boolean;
}

type AccountingDisposition = "unspent" | "spent" | "invalid";

function accountingDisposition(outcome: ProviderV2Outcome): AccountingDisposition {
  const value = outcome as unknown as {
    kind?: unknown;
    attempted?: unknown;
    spent?: unknown;
    outcomeCode?: unknown;
    statusClass?: unknown;
  };
  if (value.attempted === false
    && value.spent === false
    && value.outcomeCode === "not_dispatched"
    && value.statusClass === "none"
    && value.kind !== "success") return "unspent";
  if (value.attempted === true
    && value.spent === true
    && value.outcomeCode !== "not_dispatched"
    && value.outcomeCode !== "unknown") return "spent";
  return "invalid";
}

async function settleAttempt(
  tx: Tx,
  input: DurableFinalizerInput,
  policy: ReadyPolicy,
  ids: DurableFinalizerIds,
  context: LockedContext,
  ledger: typeof providerCallLedger.$inferSelect,
  chunk: typeof transcriptionChunks.$inferSelect,
  settlement: Settlement,
): Promise<DurableFinalizerStepResult> {
  const outcome = settlement.outcome;
  const disposition = settlement.unknown ? "spent" : accountingDisposition(outcome);
  if (disposition === "unspent") await finishUnspentReservation(tx, ledger, false);
  else await moveReservationToSpent(tx, ledger);
  const classification = classifyDurableProviderOutcome(outcome);
  if (disposition !== "unspent") {
    const ambiguous = settlement.unknown || disposition === "invalid";
    const [completed] = await tx.update(providerCallLedger).set({
      dispatchState: ambiguous ? "spent" : "completed",
      outcomeCode: ambiguous ? "unknown" : outcome.outcomeCode,
      statusClass: ambiguous ? "none" : outcome.statusClass,
      reservedCostMicrounits: ambiguous ? 0n : ledger.reservedCostMicrounits,
      spentCostMicrounits: ledger.reservedCostMicrounits,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(eq(providerCallLedger.id, ledger.id), eq(providerCallLedger.dispatchState, "dispatching")))
      .returning({ id: providerCallLedger.id });
    if (!completed) throw new Error("durable provider settlement ledger mismatch");
  }

  if (deadlineExpired(context)) {
    await tx.update(transcriptionChunks).set({ state: "failed", updatedAt: sql`clock_timestamp()` })
      .where(eq(transcriptionChunks.id, chunk.id));
    await terminalInTransaction(tx, input, context, "operation_deadline_exceeded");
    return "terminal";
  }
  if (settlement.unknown || disposition === "invalid") {
    await tx.update(transcriptionChunks).set({ state: "failed", updatedAt: sql`clock_timestamp()` })
      .where(eq(transcriptionChunks.id, chunk.id));
    await terminalInTransaction(tx, input, context, disposition === "invalid" ? "persistence_failed" : "provider_unavailable");
    return "terminal";
  }

  if (classification === "success" && settlement.checkpoint) {
    await tx.update(transcriptionChunks).set({
      state: "succeeded",
      checkpointCiphertext: settlement.checkpoint.ciphertext,
      checkpointNonce: settlement.checkpoint.nonce,
      checkpointKeyVersion: settlement.checkpoint.keyVersion,
      checkpointContentHash: settlement.checkpoint.contentHash,
      nextEligibleAt: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(eq(transcriptionChunks.id, chunk.id));
    await schedule(tx, ids, context, `after-success:${chunk.id}:${ledger.attempt}`, context.databaseNow);
    return "continued";
  }

  if (classification === "timeout" && chunk.endMs - chunk.startMs > policy.splitFloorMs) {
    const midpoint = chunk.startMs + Math.floor((chunk.endMs - chunk.startMs) / 2);
    if (midpoint <= chunk.startMs || midpoint >= chunk.endMs) {
      await terminalInTransaction(tx, input, context, "provider_timeout");
      return "terminal";
    }
    const [maximum] = await tx.select({ ordinal: sql<number>`coalesce(max(${transcriptionChunks.ordinal}), -1)::int` })
      .from(transcriptionChunks).where(eq(transcriptionChunks.operationId, context.operation.id));
    const firstOrdinal = (maximum?.ordinal ?? -1) + 1;
    const version = chunk.version + 1;
    const children = [
      { ordinal: firstOrdinal, startMs: chunk.startMs, endMs: midpoint },
      { ordinal: firstOrdinal + 1, startMs: midpoint, endMs: chunk.endMs },
    ];
    await tx.update(transcriptionChunks).set({ state: "split", updatedAt: sql`clock_timestamp()` })
      .where(eq(transcriptionChunks.id, chunk.id));
    await tx.insert(transcriptionChunks).values(children.map((child, index) => ({
      id: ids.id("chunk", `${context.operation.id}:${chunk.id}:${version}:${index}`),
      operationId: context.operation.id,
      ordinal: child.ordinal,
      version,
      startMs: child.startMs,
      endMs: child.endMs,
      speakerRefHash: chunk.speakerRefHash,
      provenance: chunk.provenance,
      state: "planned",
      attempt: 0,
      retryCount: 0,
      splitParentId: chunk.id,
      leaseFence: input.claim.fence,
    }))).onConflictDoNothing();
    await schedule(tx, ids, context, `split:${chunk.id}:${ledger.attempt}`, context.databaseNow);
    return "continued";
  }

  if (classification === "retryable" && chunk.retryCount < 1) {
    const delay = boundedRetryAfterMs(settlement.retryAfterMs, policy);
    const nextEligibleAt = new Date(context.databaseNow.getTime() + delay);
    if (nextEligibleAt.getTime() >= authoritativeRecoveryDeadline(context.operation).getTime()) {
      await terminalInTransaction(tx, input, context, "operation_deadline_exceeded");
      return "terminal";
    }
    await tx.update(transcriptionChunks).set({
      state: "retry_scheduled",
      retryCount: 1,
      nextEligibleAt,
      providerCallLedgerId: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(eq(transcriptionChunks.id, chunk.id));
    await persistTruthfulScheduledPhase(tx, input, ids, context, nextEligibleAt);
    await schedule(tx, ids, context, `retry:${chunk.id}:${ledger.attempt}`, nextEligibleAt, chunk.id, "chunk.retry");
    return "continued";
  }

  if (policy.fallbackEnabled && (classification === "timeout" || classification === "retryable")) {
    await tx.update(transcriptionChunks).set({ state: "failed", updatedAt: sql`clock_timestamp()` })
      .where(eq(transcriptionChunks.id, chunk.id));
    await schedule(tx, ids, context, `fallback:${chunk.id}:${ledger.attempt}`, context.databaseNow, chunk.id);
    return "continued";
  }

  const code: ErrorCode = classification === "timeout" ? "provider_timeout"
    : classification === "terminal_authorization" || classification === "terminal_rejected" ? "provider_rejected"
      : classification === "terminal_attestation" ? "attestation_failed"
        : classification === "terminal_persistence" ? "persistence_failed"
          : "provider_unavailable";
  await tx.update(transcriptionChunks).set({ state: "failed", updatedAt: sql`clock_timestamp()` })
    .where(eq(transcriptionChunks.id, chunk.id));
  await terminalInTransaction(tx, input, context, code);
  return "terminal";
}

async function recoverAmbiguous(
  input: DurableFinalizerInput,
  policy: ReadyPolicy,
  ids: DurableFinalizerIds,
  ledgerId: string,
): Promise<DurableFinalizerStepResult> {
  return input.db.transaction(async (tx) => {
    const context = await lockContext(tx, input);
    if (!context) return "stale";
    const locked = await lockChunkBeforeLedger(tx, context.operation.id, ledgerId, "dispatching");
    if (!locked) return "stale";
    const { ledger, chunk } = locked;
    if (!chunk) return terminalInTransaction(tx, input, context, "persistence_failed").then(() => "terminal" as const);
    return settleAttempt(tx, input, policy, ids, context, ledger, chunk, { outcome: syntheticUnknown(), unknown: true });
  });
}

async function dispatchStep(
  input: DurableFinalizerInput,
  policy: ReadyPolicy,
  ids: DurableFinalizerIds,
  ledgerId: string,
): Promise<DurableFinalizerStepResult> {
  const before = await input.db.transaction(async (tx) => {
    const context = await lockContext(tx, input);
    if (!context) return { result: "stale" as const };
    const locked = await lockChunkBeforeLedger(tx, context.operation.id, ledgerId, "reserved");
    if (!locked) return { result: "stale" as const };
    const { ledger, chunk } = locked;
    if (deadlineExpired(context)) {
      await refundReservation(tx, ledger);
      await tx.update(providerCallLedger).set({
        dispatchState: "not_dispatched", outcomeCode: "not_dispatched", statusClass: "none",
        completedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()`,
      }).where(eq(providerCallLedger.id, ledger.id));
      await terminalInTransaction(tx, input, context, "operation_deadline_exceeded");
      return { result: "terminal" as const };
    }
    if (!chunk || chunk.state !== "reserved"
      || context.operation.sourceSampleRateHz === null || context.operation.sourceSampleCount === null) {
      await refundReservation(tx, ledger);
      await tx.update(providerCallLedger).set({
        dispatchState: "not_dispatched", outcomeCode: "not_dispatched", statusClass: "none",
        completedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()`,
      }).where(eq(providerCallLedger.id, ledger.id));
      await terminalInTransaction(tx, input, context, "persistence_failed");
      return { result: "terminal" as const };
    }
    if (!input.provider.ready || !input.protector.ready || !input.breaker.allowsDispatch()) {
      await finishUnspentReservation(tx, ledger, true);
      return { result: "parked" as const };
    }
    const range = reconstructProviderV2SampleRange(
      chunk.startMs,
      chunk.endMs,
      context.operation.sourceSampleRateHz,
      context.operation.sourceSampleCount,
      chunk.endMs === context.operation.plannedAudioMs,
    );
    return { context, ledger, chunk, range };
  });
  if ("result" in before && before.result) {
    return before.result === "parked" ? park(input) : before.result;
  }

  let encoded: { audio: Uint8Array; contentType: string };
  try {
    const started = await startMeetingFencedCall(
      input.db,
      before.context.meeting.id,
      async (tx) => {
        const context = await lockContext(tx, input);
        if (!context) return null;
        const locked = await lockChunkBeforeLedger(tx, context.operation.id, ledgerId, "reserved");
        return locked?.chunk?.id === before.chunk.id && locked.chunk.state === "reserved"
          ? {
            operationId: context.operation.id,
            startSample: before.range.startSample,
            endSample: before.range.endSample,
            sampleRate: context.operation.sourceSampleRateHz!,
            totalSamples: context.operation.sourceSampleCount!,
          }
          : null;
      },
      (authority) => input.recording.encode(authority),
    );
    if (started.kind === "stale") return "stale";
    encoded = await started.response;
  } catch {
    encoded = { audio: new Uint8Array(), contentType: "" };
  }
  if (!(encoded.audio instanceof Uint8Array)
    || encoded.audio.byteLength !== before.ledger.submittedBytes
    || encoded.audio.byteLength >= policy.plannerLimits.maxWavBytes
    || typeof encoded.contentType !== "string"
    || !encoded.contentType.startsWith("audio/")) {
    await input.db.transaction(async (tx) => {
      const context = await lockContext(tx, input);
      if (!context) return;
      const [ledger] = await tx.select().from(providerCallLedger).where(and(
        eq(providerCallLedger.id, ledgerId), eq(providerCallLedger.dispatchState, "reserved"),
      )).for("update");
      if (!ledger) return;
      await refundReservation(tx, ledger);
      await tx.update(providerCallLedger).set({
        dispatchState: "not_dispatched", outcomeCode: "not_dispatched", statusClass: "none",
        completedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()`,
      }).where(eq(providerCallLedger.id, ledger.id));
      await terminalInTransaction(tx, input, context, "validation_failed");
    });
    return "terminal";
  }

  const marked = await input.db.transaction(async (tx) => {
    const context = await lockContext(tx, input);
    if (!context) return "stale" as const;
    const locked = await lockChunkBeforeLedger(tx, context.operation.id, ledgerId, "reserved");
    if (!locked || !locked.chunk || locked.chunk.id !== before.chunk.id || locked.chunk.state !== "reserved") {
      return "stale" as const;
    }
    const { ledger: lockedLedger, chunk: lockedChunk } = locked;
    if (deadlineExpired(context)) {
      if (lockedLedger) {
        await refundReservation(tx, lockedLedger);
        await tx.update(providerCallLedger).set({
          dispatchState: "not_dispatched", outcomeCode: "not_dispatched", statusClass: "none",
          completedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()`,
        }).where(eq(providerCallLedger.id, lockedLedger.id));
      }
      await terminalInTransaction(tx, input, context, "operation_deadline_exceeded");
      return "terminal" as const;
    }
    await lockProjectGuard(tx, context.operation.projectId);
    const [concurrency] = await tx.select({ count: sql<number>`count(*)::int` }).from(providerCallLedger)
      .where(and(eq(providerCallLedger.projectId, context.operation.projectId), eq(providerCallLedger.dispatchState, "dispatching")));
    if ((concurrency?.count ?? 0) >= policy.maxConcurrentCalls) {
      const availableAt = clampRecoveryWakeToDeadline(
        context.operation,
        new Date(context.databaseNow.getTime() + policy.retryBackoffMs),
      );
      await persistTruthfulScheduledPhase(tx, input, ids, context, availableAt);
      await schedule(
        tx,
        ids,
        context,
        `concurrency:${before.chunk.id}:${before.ledger.attempt}:${input.claim.fence}`,
        availableAt,
        before.chunk.id,
      );
      return "deferred" as const;
    }
    const [ledger] = await tx.update(providerCallLedger).set({
      dispatchState: "dispatching",
      dispatchingAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(providerCallLedger.id, ledgerId),
      eq(providerCallLedger.dispatchState, "reserved"),
    )).returning({ id: providerCallLedger.id });
    if (!ledger) return "stale" as const;
    await tx.update(transcriptionChunks).set({ state: "dispatching", updatedAt: sql`clock_timestamp()` })
      .where(eq(transcriptionChunks.id, lockedChunk.id));
    return "marked" as const;
  });
  if (marked === "terminal" || marked === "stale") return marked;
  if (marked === "deferred") return "continued";
  input.fault?.("after_dispatch_marked");

  let providerResult: DurableProviderAttemptResult;
  try {
    const started = await startMeetingFencedCall(
      input.db,
      before.context.meeting.id,
      async (tx) => {
        const context = await lockContext(tx, input);
        if (!context) return null;
        const locked = await lockChunkBeforeLedger(tx, context.operation.id, ledgerId, "dispatching");
        return locked?.chunk?.id === before.chunk.id && locked.chunk.state === "dispatching"
          ? {
            audio: encoded.audio,
            contentType: encoded.contentType,
            language: context.meeting.language,
            attempt: locked.ledger.attempt,
            submittedAudioMs: locked.ledger.submittedAudioMs,
          }
          : null;
      },
      (authority) => input.provider.dispatch(authority),
    );
    if (started.kind === "stale") return "stale";
    const injected = await started.response;
    providerResult = canonicalProviderAttemptResult(injected) ?? { outcome: spentPersistenceUnknown() };
  } catch {
    providerResult = { outcome: thrownTransport() };
  }
  input.fault?.("after_provider");
  if (providerResult.outcome.kind === "authorization") input.breaker.trip("authorization");

  let checkpoint: Settlement["checkpoint"];
  if (providerResult.outcome.kind === "success") {
    const text = providerResult.outcome.data?.text;
    if (!isProviderV2TranscriptionText(text)) {
      providerResult = { outcome: invalidSuccessfulResponse() };
    } else {
      try {
        const protectedValue = await input.protector.protect(text);
        checkpoint = { ...protectedValue, contentHash: hash(text) };
      } catch {
        providerResult = { outcome: spentPersistenceUnknown() };
      }
    }
  }

  const settled = await input.db.transaction(async (tx) => {
    const context = await lockContext(tx, input);
    if (!context) return "stale";
    const locked = await lockChunkBeforeLedger(tx, context.operation.id, ledgerId, "dispatching");
    if (!locked) return "stale";
    const { ledger, chunk } = locked;
    if (!chunk) {
      await terminalInTransaction(tx, input, context, "persistence_failed");
      return "terminal";
    }
    return settleAttempt(tx, input, policy, ids, context, ledger, chunk, {
      outcome: providerResult.outcome,
      retryAfterMs: providerResult.retryAfterMs,
      checkpoint,
    });
  });
  if (checkpoint && settled === "continued") input.fault?.("after_checkpoint");
  return settled;
}

function failedLeafFallbackAuthorization(
  operation: typeof recoveryOperations.$inferSelect,
  chunk: typeof transcriptionChunks.$inferSelect,
  ledger: typeof providerCallLedger.$inferSelect | undefined,
  policy: ReadyPolicy,
): { readonly kind: "authorized" } | { readonly kind: "terminal"; readonly code: ErrorCode } {
  if (!ledger
    || chunk.operationId !== operation.id
    || chunk.state !== "failed"
    || chunk.provenance !== "provider"
    || chunk.providerCallLedgerId !== ledger.id
    || chunk.attempt < 1
    || chunk.checkpointCiphertext !== null
    || chunk.checkpointNonce !== null
    || chunk.checkpointKeyVersion !== null
    || chunk.checkpointContentHash !== null
    || ledger.operationId !== operation.id
    || ledger.projectId !== operation.projectId
    || ledger.chunkId !== chunk.id
    || ledger.attempt !== chunk.attempt
    || ledger.dispatchState !== "completed"
    || ledger.dispatchingAt === null
    || ledger.completedAt === null
    || ledger.submittedAudioMs !== chunk.endMs - chunk.startMs
    || ledger.submittedAudioMs <= 0
    || ledger.submittedBytes <= 0
    || ledger.reservedCostMicrounits !== ledger.spentCostMicrounits) {
    return { kind: "terminal", code: "persistence_failed" };
  }

  if (ledger.outcomeCode === "http_4xx" && ledger.statusClass === "4xx") {
    return { kind: "terminal", code: "provider_rejected" };
  }
  if (ledger.outcomeCode === "invalid_response" && (ledger.statusClass === "2xx" || ledger.statusClass === "none")) {
    return { kind: "terminal", code: "provider_rejected" };
  }
  if (ledger.outcomeCode === "provider_rejected" && ledger.statusClass === "none") {
    return { kind: "terminal", code: "provider_rejected" };
  }
  if (ledger.outcomeCode === "attestation_failed" && ledger.statusClass === "none") {
    return { kind: "terminal", code: "attestation_failed" };
  }

  const durationMs = chunk.endMs - chunk.startMs;
  const exhaustedTimeout = chunk.retryCount === 0
    && chunk.attempt === 1
    && durationMs <= policy.splitFloorMs
    && ((ledger.outcomeCode === "timeout" && ledger.statusClass === "network")
      || (ledger.outcomeCode === "http_408" && ledger.statusClass === "4xx"));
  const exhaustedUnavailable = chunk.retryCount === 1
    && chunk.attempt === 2
    && ((ledger.outcomeCode === "transport_error" && ledger.statusClass === "network")
      || (ledger.outcomeCode === "http_429" && ledger.statusClass === "4xx")
      || (ledger.outcomeCode === "http_5xx" && ledger.statusClass === "5xx"));
  return exhaustedTimeout || exhaustedUnavailable
    ? { kind: "authorized" }
    : { kind: "terminal", code: "persistence_failed" };
}

async function fallbackStep(
  input: DurableFinalizerInput,
  policy: ReadyPolicy,
  ids: DurableFinalizerIds,
): Promise<DurableFinalizerStepResult> {
  if (!policy.fallbackEnabled || !input.fallback?.ready || !input.protector.ready) return park(input);
  const prepared = await input.db.transaction(async (tx) => {
    const context = await lockContext(tx, input);
    if (!context) return { result: "stale" as const };
    if (deadlineExpired(context)) return { result: "deadline" as const };
    if (context.operation.sourceSampleRateHz === null || context.operation.sourceSampleCount === null) {
      return { result: "persistence" as const };
    }
    const chunks = await tx.select().from(transcriptionChunks)
      .where(eq(transcriptionChunks.operationId, context.operation.id))
      .orderBy(asc(transcriptionChunks.startMs), asc(transcriptionChunks.endMs), asc(transcriptionChunks.id))
      .for("update");
    const leaves = currentLeaves(chunks);
    const failed = leaves.find((chunk) => chunk.state === "failed");
    if (!failed) return { result: "stale" as const };
    if (leaves.length < 1 || leaves.some((chunk) => !chunk.speakerRefHash)) {
      return { result: "coverage" as const };
    }
    const [ledger] = failed.providerCallLedgerId
      ? await tx.select().from(providerCallLedger).where(eq(providerCallLedger.id, failed.providerCallLedgerId)).for("update")
      : [];
    const authorization = failedLeafFallbackAuthorization(context.operation, failed, ledger, policy);
    if (authorization.kind === "terminal") {
      await terminalInTransaction(tx, input, context, authorization.code);
      return { result: "terminal" as const };
    }
    return {
      context,
      failed,
      sampleRate: context.operation.sourceSampleRateHz,
      sampleCount: context.operation.sourceSampleCount,
      leaves: leaves.map((chunk) => ({
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        speakerRef: chunk.speakerRefHash!,
      })),
    };
  });
  if ("result" in prepared) {
    if (prepared.result === "stale") return "stale";
    if (prepared.result === "terminal") return "terminal";
    if (prepared.result === "deadline") return terminal(input, "operation_deadline_exceeded");
    return terminal(input, prepared.result === "coverage" ? "coverage_incomplete" : "persistence_failed");
  }

  if (!policy.fallbackEnabled) return park(input);

  let rawCoverage: unknown;
  try {
    const started = await startMeetingFencedCall(
      input.db,
      prepared.context.meeting.id,
      async (tx) => {
        const context = await lockContext(tx, input);
        if (!context) return null;
        const [failed] = await tx.select().from(transcriptionChunks).where(and(
          eq(transcriptionChunks.id, prepared.failed.id),
          eq(transcriptionChunks.operationId, context.operation.id),
          eq(transcriptionChunks.state, "failed"),
        )).for("update");
        const [ledger] = failed?.providerCallLedgerId
          ? await tx.select().from(providerCallLedger)
            .where(eq(providerCallLedger.id, failed.providerCallLedgerId)).for("update")
          : [];
        return failed && failedLeafFallbackAuthorization(context.operation, failed, ledger, policy).kind === "authorized"
          ? {
            operationId: context.operation.id,
            meetingId: context.meeting.id,
            sampleRate: prepared.sampleRate,
            sampleCount: prepared.sampleCount,
            leaves: prepared.leaves,
          }
          : null;
      },
      (authority) => input.fallback!.coverage(authority),
    );
    if (started.kind === "stale") return "stale";
    rawCoverage = await started.response;
  } catch {
    return terminal(input, "persistence_failed");
  }
  const coverage = validateVexaFallbackCoverage({
    sampleRate: prepared.sampleRate,
    sampleCount: prepared.sampleCount,
    leaves: prepared.leaves,
  }, rawCoverage);
  if (coverage.kind !== "accepted") return terminal(input, "coverage_incomplete");
  const selected = coverage.leaves.find((leaf) => leaf.startMs === prepared.failed.startMs
    && leaf.endMs === prepared.failed.endMs
    && leaf.speakerRef === prepared.failed.speakerRefHash);
  if (!selected) return terminal(input, "coverage_incomplete");

  let checkpoint: ProtectedCheckpoint & { contentHash: string };
  try {
    checkpoint = { ...(await input.protector.protect(selected.text)), contentHash: hash(selected.text) };
  } catch {
    return terminal(input, "persistence_failed");
  }
  const result = await input.db.transaction(async (tx) => {
    const context = await lockContext(tx, input);
    if (!context) return "stale" as const;
    if (deadlineExpired(context)) {
      await terminalInTransaction(tx, input, context, "operation_deadline_exceeded");
      return "terminal" as const;
    }
    const [chunk] = await tx.update(transcriptionChunks).set({
      state: "fallback",
      provenance: "vexa_fallback",
      checkpointCiphertext: checkpoint.ciphertext,
      checkpointNonce: checkpoint.nonce,
      checkpointKeyVersion: checkpoint.keyVersion,
      checkpointContentHash: checkpoint.contentHash,
      nextEligibleAt: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(transcriptionChunks.id, prepared.failed.id),
      eq(transcriptionChunks.operationId, context.operation.id),
      eq(transcriptionChunks.state, "failed"),
      eq(transcriptionChunks.startMs, selected.startMs),
      eq(transcriptionChunks.endMs, selected.endMs),
      eq(transcriptionChunks.speakerRefHash, selected.speakerRef),
    )).returning({ id: transcriptionChunks.id });
    if (!chunk) return "stale" as const;
    await schedule(tx, ids, context, `after-fallback:${chunk.id}`, context.databaseNow);
    return "continued" as const;
  });
  if (result === "continued") input.fault?.("after_fallback_checkpoint");
  return result;
}

async function publish(
  input: DurableFinalizerInput,
  policy: ReadyPolicy,
  ids: DurableFinalizerIds,
): Promise<DurableFinalizerStepResult> {
  input.fault?.("before_publication");
  const result = await input.db.transaction(async (tx) => {
    const context = await lockContext(tx, input);
    if (!context) return "stale" as const;
    if (deadlineExpired(context)) {
      await terminalInTransaction(tx, input, context, "operation_deadline_exceeded");
      return "terminal" as const;
    }
    const chunks = await tx.select().from(transcriptionChunks)
      .where(eq(transcriptionChunks.operationId, context.operation.id))
      .orderBy(asc(transcriptionChunks.startMs), asc(transcriptionChunks.endMs), asc(transcriptionChunks.id))
      .for("update");
    const leaves = currentLeaves(chunks);
    let expectedStart = 0;
    const raw = [] as Array<{
      start: number;
      end: number;
      text: string;
      speaker: string;
      language: string | null;
      provenance: "provider" | "vexa_fallback";
    }>;
    const speakerNames = new Map<string, string>();
    for (const chunk of leaves) {
      if (chunk.startMs !== expectedStart
        || chunk.endMs <= chunk.startMs
        || !((chunk.state === "succeeded" && chunk.provenance === "provider")
          || (chunk.state === "fallback" && chunk.provenance === "vexa_fallback"))
        || !chunk.speakerRefHash) {
        await terminalInTransaction(tx, input, context, "coverage_incomplete");
        return "terminal" as const;
      }
      if (!chunk.checkpointCiphertext
        || !chunk.checkpointNonce
        || !chunk.checkpointKeyVersion
        || !chunk.checkpointContentHash) {
        await terminalInTransaction(tx, input, context, "persistence_failed");
        return "terminal" as const;
      }
      try {
        const text = await input.protector.unprotect({
          ciphertext: chunk.checkpointCiphertext,
          nonce: chunk.checkpointNonce,
          keyVersion: chunk.checkpointKeyVersion,
        });
        if (!isProviderV2TranscriptionText(text) || hash(text) !== chunk.checkpointContentHash) {
          throw new Error("invalid checkpoint");
        }
        let speaker = speakerNames.get(chunk.speakerRefHash);
        if (!speaker) {
          speaker = `Speaker ${speakerNames.size + 1}`;
          speakerNames.set(chunk.speakerRefHash, speaker);
        }
        raw.push({
          start: chunk.startMs / 1_000,
          end: chunk.endMs / 1_000,
          text,
          speaker,
          language: context.meeting.language,
          provenance: chunk.provenance as "provider" | "vexa_fallback",
        });
        expectedStart = chunk.endMs;
      } catch {
        await terminalInTransaction(tx, input, context, "persistence_failed");
        return "terminal" as const;
      }
    }
    if (leaves.length < 1 || expectedStart !== context.operation.plannedAudioMs) {
      await terminalInTransaction(tx, input, context, "coverage_incomplete");
      return "terminal" as const;
    }
    const normalized = normalizeSegments(raw, context.meeting.language);
    const normalizedCoversEveryLeaf = normalized.segments.length === leaves.length
      && normalized.duration_seconds === context.operation.plannedAudioMs / 1_000
      && normalized.segments.every((segment, index) =>
        segment.start === raw[index]?.start && segment.end === raw[index]?.end);
    if (!normalized.text.trim() || !normalizedCoversEveryLeaf) {
      await terminalInTransaction(tx, input, context, "coverage_incomplete");
      return "terminal" as const;
    }
    const hasFallback = raw.some((segment) => segment.provenance === "vexa_fallback");
    const hasProvider = raw.some((segment) => segment.provenance === "provider");
    const transcript = {
      language: normalized.language,
      durationSeconds: normalized.duration_seconds,
      segmentsJson: {
        speakers: normalized.speakers,
        segments: normalized.segments.map((segment, index) => ({ ...segment, provenance: raw[index]!.provenance })),
        text: normalized.text,
      },
      provider: hasFallback ? (hasProvider ? "provider-v2+vexa" : "vexa") : "provider-v2",
      fallbackFrom: hasFallback ? "provider-v2" : null,
      fallbackReason: hasFallback ? "provider_exhausted" : null,
    };
    await tx.insert(transcripts).values({ meetingId: context.meeting.id, ...transcript })
      .onConflictDoUpdate({ target: transcripts.meetingId, set: transcript });
    const [meeting] = await tx.update(meetings).set({
      status: "completed",
      errorCode: null,
      errorMessage: null,
      activeRecoveryOperationId: null,
      recoveryPhase: "completed",
      nextRecoveryEligibleAt: null,
      lastRecoveryOutcome: "completed",
      transcriptRevision: sql`${meetings.transcriptRevision} + 1`,
      completedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(meetings.id, context.meeting.id),
      eq(meetings.status, "processing"),
      eq(meetings.activeRecoveryOperationId, context.operation.id),
    )).returning({ revision: meetings.transcriptRevision });
    if (!meeting) throw new Error("durable publication meeting fence mismatch");
    const [operation] = await tx.update(recoveryOperations).set({
      state: "completed",
      phase: "completed",
      failureCode: null,
      workerLeaseOwnerHash: null,
      workerLeaseExpiresAt: null,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    }).where(operationLeaseWhere(input)).returning({ id: recoveryOperations.id });
    if (!operation) throw new Error("durable publication operation fence mismatch");
    const [job] = await tx.update(outboxJobs).set({
      state: "delivered",
      leaseOwnerHash: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(leaseWhere(input)).returning({ id: outboxJobs.id });
    if (!job) throw new Error("durable publication job fence mismatch");
    await cancelOtherWork(tx, operation.id, job.id);
    const notification = nextJob(ids, operation.id, `completion:${meeting.revision}`);
    await tx.insert(outboxJobs).values({
      ...notification,
      projectId: context.operation.projectId,
      operationId: operation.id,
      eventType: "notification.deliver",
      state: "pending",
      availableAt: context.databaseNow,
    }).onConflictDoNothing();
    return "completed" as const;
  });
  if (result === "completed") input.fault?.("after_publication");
  return result;
}

async function preserveFutureWaiting(
  input: DurableFinalizerInput,
  policy: ReadyPolicy,
  ids: DurableFinalizerIds,
): Promise<DurableFinalizerStepResult> {
  return input.db.transaction(async (tx) => {
    const context = await lockContext(tx, input);
    if (!context) return "stale";
    if (deadlineExpired(context)) {
      await terminalInTransaction(tx, input, context, "operation_deadline_exceeded");
      return "terminal";
    }
    const waitingReferences = await tx.select({
      id: transcriptionChunks.id,
      nextEligibleAt: transcriptionChunks.nextEligibleAt,
    }).from(transcriptionChunks).where(and(
      eq(transcriptionChunks.operationId, context.operation.id),
      eq(transcriptionChunks.state, "retry_scheduled"),
      sql`${transcriptionChunks.nextEligibleAt} > clock_timestamp()`,
    )).orderBy(asc(transcriptionChunks.nextEligibleAt), asc(transcriptionChunks.id));
    if (waitingReferences.length < 1) return "stale";
    const waitingIds = waitingReferences.map((chunk) => chunk.id);
    const successors = await tx.select().from(outboxJobs).where(and(
      eq(outboxJobs.operationId, context.operation.id),
      eq(outboxJobs.eventType, "chunk.retry"),
      inArray(outboxJobs.chunkId, waitingIds),
      inArray(outboxJobs.state, ["pending", "leased", "failed"]),
    )).orderBy(asc(outboxJobs.availableAt), asc(outboxJobs.id)).for("update");
    const waiting = await tx.select().from(transcriptionChunks).where(and(
      inArray(transcriptionChunks.id, waitingIds),
      eq(transcriptionChunks.operationId, context.operation.id),
      eq(transcriptionChunks.state, "retry_scheduled"),
      sql`${transcriptionChunks.nextEligibleAt} > clock_timestamp()`,
    )).orderBy(asc(transcriptionChunks.nextEligibleAt), asc(transcriptionChunks.id)).for("update");
    if (waiting.length < 1) return "stale";
    const earliest = waiting[0]!.nextEligibleAt!;
    await persistTruthfulScheduledPhase(tx, input, ids, context, earliest);
    let deferUntil: Date | null = null;
    for (const chunk of waiting) {
      const nextEligibleAt = chunk.nextEligibleAt!;
      const other = successors.filter((job) => job.chunkId === chunk.id && job.id !== context.job.id);
      const pending = other.filter((job) => job.state === "pending");
      const keep = pending[0] ?? other.find((job) => job.state === "failed") ?? null;
      if (keep) {
        await tx.update(outboxJobs).set({
          state: "pending",
          availableAt: clampRecoveryWakeToDeadline(context.operation, nextEligibleAt),
          leaseOwnerHash: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          updatedAt: sql`clock_timestamp()`,
        }).where(and(
          eq(outboxJobs.id, keep.id),
          inArray(outboxJobs.state, ["pending", "failed"]),
        ));
        const duplicateIds = other.filter((job) => job.id !== keep.id && job.state !== "leased").map((job) => job.id);
        if (duplicateIds.length > 0) {
          await tx.update(outboxJobs).set({
            state: "cancelled",
            leaseOwnerHash: null,
            leaseExpiresAt: null,
            updatedAt: sql`clock_timestamp()`,
          }).where(inArray(outboxJobs.id, duplicateIds));
        }
        continue;
      }
      if (context.job.id === input.claim.id
        && context.job.eventType === "chunk.retry"
        && context.job.chunkId === chunk.id) {
        deferUntil = clampRecoveryWakeToDeadline(context.operation, nextEligibleAt);
        continue;
      }
      await schedule(
        tx,
        ids,
        context,
        `waiting:${chunk.id}:${chunk.retryCount}:${nextEligibleAt.toISOString()}`,
        nextEligibleAt,
        chunk.id,
        "chunk.retry",
      );
    }
    if (!deferUntil) return "continued";
    const [deferred] = await tx.update(outboxJobs).set({
      state: "pending",
      availableAt: clampRecoveryWakeToDeadline(context.operation, deferUntil),
      leaseOwnerHash: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(leaseWhere(input)).returning({ id: outboxJobs.id });
    if (!deferred) return "stale";
    const [operation] = await tx.update(recoveryOperations).set({
      workerLeaseOwnerHash: null,
      workerLeaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(operationLeaseWhere(input)).returning({ id: recoveryOperations.id });
    if (!operation) throw new Error("future waiting operation fence mismatch");
    return "waiting";
  });
}

async function persistDelayedThresholdStep(
  input: DurableFinalizerInput,
  policy: ReadyPolicy,
  ids: DurableFinalizerIds,
): Promise<DurableFinalizerStepResult> {
  return input.db.transaction(async (tx) => {
    const context = await lockContext(tx, input);
    if (!context) return "stale";
    if (deadlineExpired(context)) {
      await terminalInTransaction(tx, input, context, "operation_deadline_exceeded");
      return "terminal";
    }
    if (!context.operation.delayedAt
      || context.databaseNow.getTime() < context.operation.delayedAt.getTime()
      || (context.operation.phase === "delayed" && context.meeting.recoveryPhase === "delayed")) {
      return "stale";
    }
    await persistTruthfulScheduledPhase(tx, input, ids, context, context.databaseNow);
    await schedule(
      tx,
      ids,
      context,
      `delayed-observed:${context.operation.delayedAt.toISOString()}`,
      context.databaseNow,
    );
    return "continued";
  });
}

/**
 * Execute one bounded durable state-machine step. There is deliberately no retry/chunk loop: the
 * database partition, ledger, and scheduled outbox row determine the next delivery after restart.
 */
export async function runDurableFinalizerStep(input: DurableFinalizerInput): Promise<DurableFinalizerStepResult> {
  if (!durableFinalizerPolicyIsReady(input.policy)
    || !input.recording
    || !input.provider
    || !input.breaker
    || !input.protector
    || typeof input.priceAttempt !== "function") return park(input);
  const policy = input.policy;
  const ids = input.ids ?? DEFAULT_IDS;
  const initial = await input.db.transaction((tx) => lockContext(tx, input));
  if (!initial) return "stale";
  if (initial.operation.sourceSampleRateHz === null || initial.operation.sourceSampleCount === null) {
    if (deadlineExpired(initial)) return terminal(input, "operation_deadline_exceeded");
    return planStep(input, policy, initial, ids);
  }

  const chunks = await input.db.select().from(transcriptionChunks)
    .where(eq(transcriptionChunks.operationId, initial.operation.id))
    .orderBy(asc(transcriptionChunks.startMs), asc(transcriptionChunks.id));
  const leaves = currentLeaves(chunks);
  const dispatching = leaves.find((chunk) => chunk.state === "dispatching" && chunk.providerCallLedgerId);
  if (dispatching?.providerCallLedgerId) return recoverAmbiguous(input, policy, ids, dispatching.providerCallLedgerId);
  const reserved = leaves.find((chunk) => chunk.state === "reserved" && chunk.providerCallLedgerId);
  if (reserved?.providerCallLedgerId) return dispatchStep(input, policy, ids, reserved.providerCallLedgerId);
  if (deadlineExpired(initial)) return terminal(input, "operation_deadline_exceeded");
  if (initial.operation.delayedAt
    && initial.databaseNow.getTime() >= initial.operation.delayedAt.getTime()
    && (initial.operation.phase !== "delayed" || initial.meeting.recoveryPhase !== "delayed")) {
    return persistDelayedThresholdStep(input, policy, ids);
  }
  if (leaves.length > 0 && leaves.every((chunk) => chunk.state === "succeeded" || chunk.state === "fallback")) {
    return publish(input, policy, ids);
  }
  if (leaves.some((chunk) => chunk.state === "failed")) {
    return policy.fallbackEnabled ? fallbackStep(input, policy, ids) : park(input);
  }

  const dueRetry = leaves.find((chunk) => chunk.state === "retry_scheduled"
    && chunk.nextEligibleAt !== null
    && chunk.nextEligibleAt.getTime() <= initial.databaseNow.getTime());
  if (dueRetry) {
    const changed = await input.db.transaction(async (tx) => {
      const context = await lockContext(tx, input);
      if (!context) return false;
      const [chunk] = await tx.update(transcriptionChunks).set({
        state: "planned", nextEligibleAt: null, updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(transcriptionChunks.id, dueRetry.id),
        eq(transcriptionChunks.state, "retry_scheduled"),
        sql`${transcriptionChunks.nextEligibleAt} <= clock_timestamp()`,
      )).returning({ id: transcriptionChunks.id });
      if (!chunk) return false;
      await schedule(tx, ids, context, `retry-due:${chunk.id}:${dueRetry.attempt}`, context.databaseNow, chunk.id);
      return true;
    });
    return changed ? "continued" : "stale";
  }
  const planned = leaves.find((chunk) => chunk.state === "planned");
  if (planned) return reserveStep(input, policy, ids, planned.id);
  if (leaves.some((chunk) => chunk.state === "retry_scheduled"
    && chunk.nextEligibleAt !== null
    && chunk.nextEligibleAt.getTime() > initial.databaseNow.getTime())) {
    return preserveFutureWaiting(input, policy, ids);
  }
  return terminal(input, "coverage_incomplete");
}

export const PROVIDER_V2_FINALIZER_EXTERNAL_BLOCKERS = Object.freeze([
  "production attestation-verifying provider boundary is unavailable",
  "production Vexa fallback coverage boundary is unavailable",
  "operator numeric policy and pricing approval is unavailable",
  "checkpoint protection and retention approval is unavailable",
] as const);

export interface OfflineDurableFinalizerAdapterInput
  extends Omit<DurableFinalizerInput, "claim"> {
  readonly mode: "offline_contract_only";
}

/** Explicit offline A4 adapter. Its brand and ready dependencies cannot be used by production construction. */
export function createOfflineDurableFinalizerDispatchAdapter(
  input: OfflineDurableFinalizerAdapterInput,
): RecoveryDispatchAdapter & { readonly mode: "offline_contract_only" } {
  if (input.mode !== "offline_contract_only") throw new TypeError("offline finalizer adapter requires its test-only brand");
  return Object.freeze({
    mode: "offline_contract_only" as const,
    async dispatch(claim: OutboxClaim) {
      const result = await runDurableFinalizerStep({ ...input, claim });
      if (result === "continued") return "continue" as const;
      if (result === "completed" || result === "terminal") return "acknowledged" as const;
      if (result === "parked") return "already_parked" as const;
      if (result === "waiting") return "already_waiting" as const;
      return "stale" as const;
    },
  });
}
