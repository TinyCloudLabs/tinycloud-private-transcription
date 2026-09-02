import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { createDb } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import {
  meetings,
  outboxJobs,
  projectRecoveryBuckets,
  providerCallLedger,
  recoveryOperations,
  transcriptionChunks,
  transcripts,
} from "../../src/db/schema.ts";
import type { ProviderV2Outcome } from "../../src/providers/transcription/provider-v2.ts";
import {
  createOfflineDurableFinalizerDispatchAdapter,
  runDurableFinalizerStep,
  type CheckpointProtector,
  type DurableDispatchBreaker,
  type DurableFinalizerFaultPoint,
  type DurableFinalizerPolicy,
  type DurableProviderAttemptResult,
  type DurableProviderBoundary,
  type DurableRecordingBoundary,
} from "../../src/worker/recovery-finalizer.ts";
import {
  claimOutboxJob,
  continueOutboxJob,
  enforceParkedOperationDeadline,
  reapExpiredOutboxJobs,
  repairOutboxJobs,
  runOutboxDeliveryOnce,
  type DurableDeliveryPolicy,
  type OutboxClaim,
} from "../../src/worker/outbox.ts";
import { createIsolatedDatabase, type IsolatedDatabase } from "./a2-db.ts";
import { deleteMeetingById } from "../../src/services/meetings.ts";
import { silentLogger } from "../../src/log.ts";
import type { AppContext } from "../../src/context.ts";

setDefaultTimeout(30_000);

const HARNESS_WAIT_MS = 1_000;

async function within<T>(promise: Promise<T>, label: string, maxMs = HARNESS_WAIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${maxMs}ms`)), maxMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const DELIVERY: DurableDeliveryPolicy = {
  leaseMs: 60_000,
  maxAttempts: 20,
  maxAgeMs: 3_600_000,
  retryDelayMs: 1,
  idleMs: 1,
};

const POLICY: DurableFinalizerPolicy = {
  fallbackEnabled: false,
  maxOperationCalls: 12,
  maxOperationAudioMs: 10_000,
  maxOperationCostMicrounits: 100_000n,
  maxConcurrentCalls: 1,
  splitFloorMs: 200,
  retryBackoffMs: 1_000,
  maxRetryAfterMs: 5_000,
  operationDeadlineMs: 60_000,
  delayedThresholdMs: 30_000,
  projectLimits: {
    manualCycles: 5,
    automaticCycles: 0,
    sharedCalls: 50,
    sharedAudioMs: 100_000,
    sharedCostMicrounits: 500_000n,
  },
  plannerLimits: {
    maxSourceDurationMs: 10_000,
    maxSourcePcmBytes: 100_000,
    providerMaxChunkDurationMs: 5_001,
    providerMaxWavBytes: 100_000,
    maxChunkDurationMs: 5_001,
    maxWavBytes: 100_000,
    maxChunks: 10,
    maxTotalSubmittedAudioMs: 10_000,
    maxPlanningCandidates: 1_000,
    quietSearchMs: 10,
    quietWindowMs: 5,
    silenceThresholdDbfs: -60,
  },
};

let isolated: IsolatedDatabase;
let db: ReturnType<typeof createDb>;
let sequence = 0;

function success(text: string): DurableProviderAttemptResult {
  return {
    outcome: {
      kind: "success",
      data: { text },
      attempted: true,
      spent: true,
      outcomeCode: "success",
      statusClass: "2xx",
    },
  };
}

const timeout = (code: "timeout" | "http_408" = "timeout"): DurableProviderAttemptResult => ({
  outcome: {
    kind: "timeout",
    errorCode: "provider_timeout",
    attempted: true,
    spent: true,
    outcomeCode: code,
    statusClass: code === "timeout" ? "network" : "4xx",
  },
});

function unavailable(code: "transport_error" | "http_429" | "http_5xx", retryAfterMs?: unknown): DurableProviderAttemptResult {
  return {
    outcome: {
      kind: "unavailable",
      errorCode: "provider_unavailable",
      attempted: true,
      spent: true,
      outcomeCode: code,
      statusClass: code === "transport_error" ? "network" : code === "http_5xx" ? "5xx" : "4xx",
    },
    retryAfterMs,
  };
}

function rejected(kind: "rejected" | "authorization" | "invalid_response" | "attestation_failed"): DurableProviderAttemptResult {
  const table: Record<typeof kind, ProviderV2Outcome> = {
    rejected: { kind: "rejected", errorCode: "provider_rejected", attempted: true, spent: true, outcomeCode: "http_4xx", statusClass: "4xx" },
    authorization: { kind: "authorization", errorCode: "provider_rejected", attempted: true, spent: true, outcomeCode: "http_4xx", statusClass: "4xx" },
    invalid_response: { kind: "invalid_response", errorCode: "provider_rejected", attempted: true, spent: true, outcomeCode: "invalid_response", statusClass: "2xx" },
    attestation_failed: { kind: "attestation_failed", errorCode: "attestation_failed", attempted: true, spent: true, outcomeCode: "attestation_failed", statusClass: "none" },
  };
  return { outcome: table[kind] };
}

function preDispatchRefusal(): DurableProviderAttemptResult {
  return {
    outcome: {
      kind: "attestation_failed",
      errorCode: "attestation_failed",
      attempted: false,
      spent: false,
      outcomeCode: "not_dispatched",
      statusClass: "none",
    },
  };
}

function invalidAccounting(): DurableProviderAttemptResult {
  return {
    outcome: {
      kind: "unavailable",
      errorCode: "provider_unavailable",
      attempted: false,
      spent: false,
      outcomeCode: "transport_error",
      statusClass: "network",
    },
  };
}

async function seedOperation(sampleCount = 1_000) {
  sequence += 1;
  const projectId = `prj_b3_${sequence}`;
  const meetingId = `mtg_b3_${sequence}`;
  const operationId = `rcv_b3_${sequence}`;
  const jobId = `obx_b3_seed_${sequence}`;
  await isolated.sql`insert into projects (id, name, webhook_secret) values (${projectId}, 'synthetic', 'opaque')`;
  await isolated.sql`
    insert into meetings (
      id, project_id, meeting_url, platform, status, language, metadata, budget_provenance,
      manual_recovery_cycles_consumed, recovery_phase
    ) values (
      ${meetingId}, ${projectId}, 'https://synthetic.invalid/opaque', 'jitsi', 'processing', 'en', '{}',
      'tracked', 1, 'queued'
    )
  `;
  await isolated.sql`
    insert into recovery_operations (
      id, project_id, meeting_id, idempotency_key_hash, kind, state, phase, ordinal,
      correlation_id, actor_class, reason_code, accepted_at, deadline_at
    ) values (
      ${operationId}, ${projectId}, ${meetingId}, ${sequence.toString(16).padStart(64, "0")},
      'manual', 'accepted', 'queued', 1, 'synthetic', 'user', 'user_requested',
      clock_timestamp(), clock_timestamp() + interval '60 seconds'
    )
  `;
  await isolated.sql`update meetings set active_recovery_operation_id = ${operationId} where id = ${meetingId}`;
  await isolated.sql`
    insert into project_recovery_buckets (project_id, bucket_minute, manual_cycles)
    values (${projectId}, date_trunc('minute', clock_timestamp()), 1)
  `;
  await isolated.sql`
    insert into outbox_jobs (id, project_id, operation_id, event_type, dedupe_key_hash)
    values (${jobId}, ${projectId}, ${operationId}, 'operation.accepted', ${(`f${sequence}`).padEnd(64, "0")})
  `;
  return { projectId, meetingId, operationId, jobId, sampleCount };
}

async function seedFailedFallbackLeaf(fixture: Awaited<ReturnType<typeof seedOperation>>) {
  const chunkId = `chk_b3_fallback_fence_${sequence}`;
  const ledgerId = `led_b3_fallback_fence_${sequence}`;
  const speakerRef = createHash("sha256").update("speaker-a").digest("hex");
  await isolated.sql`
    update recovery_operations set
      state = 'active', phase = 'transcribing', planned_audio_ms = ${fixture.sampleCount},
      source_sample_rate_hz = 1000, source_sample_count = ${fixture.sampleCount},
      submitted_audio_ms = ${fixture.sampleCount}, spent_calls = 1,
      spent_cost_microunits = ${BigInt(fixture.sampleCount)}
    where id = ${fixture.operationId}
  `;
  await isolated.sql`update meetings set recovery_phase = 'transcribing' where id = ${fixture.meetingId}`;
  await isolated.sql`
    insert into transcription_chunks (
      id, operation_id, ordinal, version, start_ms, end_ms, speaker_ref_hash,
      provenance, state, attempt, retry_count, lease_fence
    ) values (
      ${chunkId}, ${fixture.operationId}, 0, 1, 0, ${fixture.sampleCount}, ${speakerRef},
      'provider', 'failed', 1, 0, 1
    )
  `;
  await isolated.sql`
    insert into provider_call_ledger (
      id, project_id, operation_id, chunk_id, reservation_key_hash, kind,
      submitted_audio_ms, submitted_bytes, reserved_cost_microunits,
      spent_cost_microunits, attempt, dispatch_state, outcome_code, status_class,
      lease_fence, budget_bucket_minute, dispatching_at, completed_at
    ) values (
      ${ledgerId}, ${fixture.projectId}, ${fixture.operationId}, ${chunkId},
      ${(sequence + 60_000).toString(16).padStart(64, "0")}, 'manual',
      ${fixture.sampleCount}, ${44 + fixture.sampleCount * 2}, ${BigInt(fixture.sampleCount)},
      ${BigInt(fixture.sampleCount)}, 1, 'completed', 'timeout', 'network', 1,
      (select bucket_minute from project_recovery_buckets where project_id = ${fixture.projectId}),
      clock_timestamp(), clock_timestamp()
    )
  `;
  await db.update(transcriptionChunks).set({ providerCallLedgerId: ledgerId })
    .where(eq(transcriptionChunks.id, chunkId));
  return { chunkId, ledgerId, speakerRef };
}

function fixtureBoundaries(
  fixture: Awaited<ReturnType<typeof seedOperation>>,
  responses: DurableProviderAttemptResult[],
  intervals = [{ speaker: "speaker-a", startSample: 0, endSample: fixture.sampleCount }],
  fallbackCoverage?: unknown,
) {
  let prepares = 0;
  let encodes = 0;
  const dispatches: Array<{ attempt: number; audioMs: number; bytes: number }> = [];
  const recording: DurableRecordingBoundary = {
    async prepare() {
      prepares += 1;
      return {
        pcm: {
          sampleRate: 1_000,
          sampleCount: fixture.sampleCount,
          durationMs: fixture.sampleCount,
          samples: new Int16Array(fixture.sampleCount).fill(4_000),
        },
        speakerIntervals: intervals,
      };
    },
    async encode(input) {
      encodes += 1;
      return {
        audio: new Uint8Array(44 + (input.endSample - input.startSample) * 2).fill(7),
        contentType: "audio/wav",
      };
    },
  };
  const provider: DurableProviderBoundary = {
    ready: true,
    async dispatch(input) {
      dispatches.push({ attempt: input.attempt, audioMs: input.submittedAudioMs, bytes: input.audio.byteLength });
      const next = responses.shift();
      if (!next) throw new Error("synthetic response queue exhausted");
      return next;
    },
  };
  let tripped = false;
  const breaker: DurableDispatchBreaker = {
    allowsDispatch: () => !tripped,
    trip: () => { tripped = true; },
  };
  const protector: CheckpointProtector = {
    ready: true,
    async protect(plaintext) {
      return { ciphertext: Buffer.from(`sealed:${plaintext}`).toString("base64"), nonce: "synthetic-nonce", keyVersion: "synthetic-v1" };
    },
    async unprotect(checkpoint) {
      const decoded = Buffer.from(checkpoint.ciphertext, "base64").toString();
      if (!decoded.startsWith("sealed:")) throw new Error("corrupt");
      return decoded.slice(7);
    },
  };
  let fallbackReady = fallbackCoverage !== undefined;
  let fallbackCalls = 0;
  const fallback = {
    get ready() { return fallbackReady; },
    async coverage() { fallbackCalls += 1; return fallbackCoverage; },
  };
  return {
    recording, provider, breaker, protector, fallback, dispatches,
    prepares: () => prepares,
    encodes: () => encodes,
    tripped: () => tripped,
    fallbackCalls: () => fallbackCalls,
    setFallbackReady: (ready: boolean) => { fallbackReady = ready; },
  };
}

async function oneStep(
  fixture: Awaited<ReturnType<typeof seedOperation>>,
  boundaries: ReturnType<typeof fixtureBoundaries>,
  options: {
    fault?: (point: DurableFinalizerFaultPoint) => void;
    policy?: DurableFinalizerPolicy;
    database?: typeof db;
  } = {},
) {
  const owner = `synthetic-b3-worker-${sequence}`;
  const claim = await claimOutboxJob({ db, owner, policy: DELIVERY });
  if (!claim) return null;
  const result = await runDurableFinalizerStep({
    db: options.database ?? db,
    claim,
    owner,
    policy: options.policy ?? POLICY,
    recording: boundaries.recording,
    provider: boundaries.provider,
    breaker: boundaries.breaker,
    protector: boundaries.protector,
    fallback: boundaries.fallback,
    priceAttempt: ({ submittedAudioMs }) => BigInt(submittedAudioMs),
    fault: options.fault,
  });
  if (result === "continued") {
    expect(await continueOutboxJob({ db, jobId: claim.id, owner, fence: claim.fence })).toBe(true);
  }
  return { claim, result };
}

function pauseAfterSelectingTableOnce<T extends object>(
  database: T,
  table: object,
): { database: T; entered: Promise<void>; release(): void } {
  let selected = false;
  const entered = deferred();
  const released = deferred();

  const wrapBuilder = (builder: object, matches: boolean, locksForUpdate = false): object => new Proxy(builder, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "then" && matches && locksForUpdate && !selected && typeof value === "function") {
        return (fulfilled: (value: unknown) => unknown, rejected: (reason: unknown) => unknown) => value.call(
          target,
          async (result: unknown) => {
            selected = true;
            entered.resolve();
            await released.promise;
            return fulfilled(result);
          },
          (error: unknown) => {
            if (!selected) entered.reject(error);
            return rejected(error);
          },
        );
      }
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => wrapBuilder(
        value.apply(target, args),
        matches || (property === "from" && args[0] === table),
        locksForUpdate || (property === "for" && args[0] === "update"),
      );
    },
  });
  const wrapTransaction = (transaction: object): object => new Proxy(transaction, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "select" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) => wrapBuilder(value.apply(target, args), false);
    },
  });
  const wrapped = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "transaction" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (callback: (transaction: unknown) => unknown, ...args: unknown[]) => {
        try {
          return await value.call(
            target,
            async (transaction: { execute(statement: unknown): Promise<unknown> }) => {
              await transaction.execute(sql`set local lock_timeout = '500ms'`);
              await transaction.execute(sql`set local statement_timeout = '750ms'`);
              return callback(wrapTransaction(transaction));
            },
            ...args,
          );
        } catch (error) {
          if (!selected) entered.reject(error);
          throw error;
        }
      };
    },
  });
  return { database: wrapped, entered: entered.promise, release: released.resolve };
}

function withBoundedTransactions<T extends object>(database: T): T {
  return new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "transaction" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (callback: (transaction: unknown) => unknown, ...args: unknown[]) => value.call(
        target,
        async (transaction: { execute(statement: unknown): Promise<unknown> }) => {
          await transaction.execute(sql`set local lock_timeout = '500ms'`);
          await transaction.execute(sql`set local statement_timeout = '750ms'`);
          return callback(transaction);
        },
        ...args,
      );
    },
  });
}

function pauseAfterCommittedTransaction<T extends object>(
  database: T,
  ordinal: number,
): { database: T; entered: Promise<void>; release(): void } {
  const entered = deferred();
  const released = deferred();
  let completed = 0;
  const wrapped = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "transaction" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        try {
          const result = await value.apply(target, args);
          completed += 1;
          if (completed === ordinal) {
            entered.resolve();
            await released.promise;
          }
          return result;
        } catch (error) {
          if (completed < ordinal) entered.reject(error);
          throw error;
        }
      };
    },
  });
  return { database: wrapped, entered: entered.promise, release: released.resolve };
}

function pauseTransactionAfterInvocation<T extends object>(
  database: T,
  invoked: () => boolean,
): { database: T; entered: Promise<void>; release(): void } {
  const entered = deferred();
  const released = deferred();
  let paused = false;
  const wrapped = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "transaction" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (callback: (transaction: unknown) => unknown, ...args: unknown[]) => {
        try {
          return await value.call(target, async (transaction: unknown) => {
            const result = await callback(transaction);
            if (!paused && invoked()) {
              paused = true;
              entered.resolve();
              await released.promise;
            }
            return result;
          }, ...args);
        } catch (error) {
          if (!paused) entered.reject(error);
          throw error;
        }
      };
    },
  });
  return { database: wrapped, entered: entered.promise, release: released.resolve };
}

async function waitForMutualDatabaseBlocking(maxMs = 200): Promise<boolean> {
  const deadline = performance.now() + maxMs;
  do {
    const [row] = await isolated.sql<{ mutuallyBlocked: number }[]>`
      select count(*)::int as "mutuallyBlocked"
      from pg_stat_activity a
      where a.datname = current_database()
        and cardinality(pg_blocking_pids(a.pid)) > 0
        and exists (
          select 1
          from pg_stat_activity b
          where b.pid = any(pg_blocking_pids(a.pid))
            and a.pid = any(pg_blocking_pids(b.pid))
        )
    `;
    if ((row?.mutuallyBlocked ?? 0) >= 2) return true;
    await Bun.sleep(2);
  } while (performance.now() < deadline);
  return false;
}

async function waitForMeetingDeletionLock(maxMs = 250): Promise<boolean> {
  const deadline = performance.now() + maxMs;
  do {
    const [blocked] = await isolated.sql<{ count: number }[]>`
      select count(*)::int as count
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and cardinality(pg_blocking_pids(pid)) > 0
        and query ilike '%meetings%for update%'
    `;
    if ((blocked?.count ?? 0) > 0) return true;
    await Bun.sleep(2);
  } while (performance.now() < deadline);
  return false;
}

async function controlledInverseOrderProbe(meetingId: string, operationId: string): Promise<{
  cycleObserved: boolean;
  boundedTransactionFailures: number;
}> {
  const meetingReady = deferred();
  const operationReady = deferred();
  const crossReady = deferred();
  const errors: unknown[] = [];
  let meetingPid: number | null = null;
  let operationPid: number | null = null;
  let meetingDone = false;
  let operationDone = false;
  const meetingFirst = db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local deadlock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '2s'`);
    const [backend] = await tx.execute(sql<{ pid: number }>`select pg_backend_pid()::int as pid`);
    meetingPid = backend?.pid ?? null;
    await tx.select().from(meetings).where(eq(meetings.id, meetingId)).for("update");
    meetingReady.resolve();
    await within(operationReady.promise, "inverse-order operation readiness");
    await within(crossReady.promise, "inverse-order cross release");
    await tx.select().from(recoveryOperations).where(eq(recoveryOperations.id, operationId)).for("update");
  }).catch((error) => {
    meetingReady.reject(error);
    operationReady.reject(error);
    errors.push(error);
  }).finally(() => { meetingDone = true; });
  const operationFirst = db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local deadlock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '2s'`);
    const [backend] = await tx.execute(sql<{ pid: number }>`select pg_backend_pid()::int as pid`);
    operationPid = backend?.pid ?? null;
    await tx.select().from(recoveryOperations).where(eq(recoveryOperations.id, operationId)).for("update");
    operationReady.resolve();
    await within(meetingReady.promise, "inverse-order meeting readiness");
    await within(crossReady.promise, "inverse-order cross release");
    await tx.select().from(meetings).where(eq(meetings.id, meetingId)).for("update");
  }).catch((error) => {
    operationReady.reject(error);
    meetingReady.reject(error);
    errors.push(error);
  }).finally(() => { operationDone = true; });
  try {
    await within(Promise.all([meetingReady.promise, operationReady.promise]), "inverse-order setup");
    crossReady.resolve();
    const cycleObserved = await waitForMutualDatabaseBlocking();
    if (cycleObserved && operationPid !== null) {
      await isolated.sql`select pg_cancel_backend(${operationPid})`;
    }
    await within(Promise.all([meetingFirst, operationFirst]), "inverse-order rollback and settlement");
    return {
      cycleObserved,
      boundedTransactionFailures: errors.length,
    };
  } finally {
    crossReady.resolve();
    const activePids: number[] = [];
    if (!meetingDone && meetingPid !== null) activePids.push(meetingPid);
    if (!operationDone && operationPid !== null) activePids.push(operationPid);
    for (const pid of activePids) await isolated.sql`select pg_cancel_backend(${pid})`;
    await within(Promise.allSettled([meetingFirst, operationFirst]), "inverse-order cleanup");
  }
}

async function drive(
  fixture: Awaited<ReturnType<typeof seedOperation>>,
  boundaries: ReturnType<typeof fixtureBoundaries>,
  maximum = 40,
  policy: DurableFinalizerPolicy = POLICY,
) {
  for (let index = 0; index < maximum; index++) {
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    if (meeting?.status === "completed" || meeting?.status === "failed") return meeting;
    const result = await oneStep(fixture, boundaries, { policy });
    if (!result) {
      await isolated.sql`
        update outbox_jobs set available_at = clock_timestamp()
        where operation_id = ${fixture.operationId} and state = 'pending'
      `;
      await isolated.sql`
        update transcription_chunks set next_eligible_at = clock_timestamp()
        where operation_id = ${fixture.operationId} and state = 'retry_scheduled'
      `;
    }
  }
  throw new Error("synthetic durable drive did not terminate");
}

async function ledgerTotals(operationId: string) {
  const rows = await db.select().from(providerCallLedger).where(eq(providerCallLedger.operationId, operationId));
  return {
    rows,
    calls: rows.length,
    audioMs: rows.reduce((sum, row) => sum + row.submittedAudioMs, 0),
    cost: rows.reduce((sum, row) => sum + row.spentCostMicrounits, 0n),
  };
}

beforeEach(async () => {
  isolated = await createIsolatedDatabase("ptx_b3_finalizer");
  const migrated = await runMigrations(isolated.url);
  await migrated.$client.close();
  db = createDb(isolated.url);
});

afterEach(async () => {
  await db?.$client.close();
  await isolated?.drop();
});

describe("B3 durable chunk finalizer", () => {
  test("delete and finalizer acquire meeting/recovery locks in one order without detector-assisted deadlock", async () => {
    const fixture = await seedOperation(250);
    const boundaries = fixtureBoundaries(fixture, []);
    const inverseOrder = await controlledInverseOrderProbe(fixture.meetingId, fixture.operationId);
    expect(inverseOrder.cycleObserved).toBe(true);
    expect(inverseOrder.boundedTransactionFailures).toBeGreaterThanOrEqual(1);

    const barrier = pauseAfterSelectingTableOnce(db, meetings);
    let finalizing: ReturnType<typeof oneStep> | null = null;
    let deleting: Promise<void> | null = null;
    try {
      finalizing = oneStep(fixture, boundaries, { database: barrier.database });
      await within(barrier.entered, "finalizer meeting FOR UPDATE readiness");

      const ctx = {
        db: withBoundedTransactions(db),
        vexa: { stopBot: async () => ({}), deleteMeeting: async () => ({}) },
        log: silentLogger,
      } as unknown as AppContext;
      deleting = deleteMeetingById(ctx, fixture.projectId, fixture.meetingId);
      let deletionBlocked = false;
      const deadline = performance.now() + 250;
      do {
        const [blocked] = await isolated.sql<{ count: number }[]>`
          select count(*)::int as count
          from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and cardinality(pg_blocking_pids(pid)) > 0
            and query ilike '%meetings%for update%'
        `;
        if ((blocked?.count ?? 0) > 0) {
          deletionBlocked = true;
          break;
        }
        await Bun.sleep(2);
      } while (performance.now() < deadline);
      expect(deletionBlocked).toBe(true);

      const releasedAt = performance.now();
      barrier.release();
      const completed = Promise.all([finalizing, deleting]);
      await expect(within(completed, "lock-order completion")).resolves.toBeArrayOfSize(2);
      expect(performance.now() - releasedAt).toBeLessThan(400);
    } finally {
      barrier.release();
      const cleanup: Promise<unknown>[] = [];
      if (finalizing) cleanup.push(finalizing);
      if (deleting) cleanup.push(deleting);
      await within(Promise.allSettled(cleanup), "lock-order cleanup");
    }
  });

  test("a committed delete fence wins a provider/finalizer race without publication or a second call", async () => {
    const fixture = await seedOperation(250);
    const boundaries = fixtureBoundaries(fixture, []);
    const entered = deferred();
    const released = deferred();
    boundaries.provider.dispatch = async () => {
      boundaries.dispatches.push({ attempt: 1, audioMs: 250, bytes: 544 });
      entered.resolve();
      await released.promise;
      return success("must not publish");
    };

    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    let finalizing: ReturnType<typeof oneStep> | null = null;
    try {
      finalizing = oneStep(fixture, boundaries);
      await within(entered.promise, "provider invocation readiness");
      const ctx = {
        db,
        vexa: { stopBot: async () => ({}), deleteMeeting: async () => ({}) },
        log: silentLogger,
      } as unknown as AppContext;
      await within(deleteMeetingById(ctx, fixture.projectId, fixture.meetingId), "provider-in-flight deletion");
      released.resolve();
      expect((await within(finalizing, "provider-in-flight finalizer settlement"))?.result).toBe("stale");
    } finally {
      released.resolve();
      if (finalizing) await within(Promise.allSettled([finalizing]), "provider-in-flight cleanup");
    }
    expect(boundaries.dispatches).toHaveLength(1);
    expect(await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId))).toHaveLength(0);
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    const [ledger] = await db.select().from(providerCallLedger).where(eq(providerCallLedger.operationId, fixture.operationId));
    const [bucket] = await db.select().from(projectRecoveryBuckets).where(eq(projectRecoveryBuckets.projectId, fixture.projectId));
    const [chunk] = await db.select().from(transcriptionChunks).where(eq(transcriptionChunks.operationId, fixture.operationId));
    expect(meeting).toMatchObject({ deletedAt: expect.any(Date), activeRecoveryOperationId: null, transcriptRevision: 0 });
    expect(operation).toMatchObject({
      state: "cancelled", failureCode: "deleted", reservedCalls: 0, spentCalls: 1,
      submittedAudioMs: 250, reservedCostMicrounits: 0n, spentCostMicrounits: 250n,
    });
    expect(ledger).toMatchObject({
      dispatchState: "spent", outcomeCode: "unknown", statusClass: "none",
      reservedCostMicrounits: 250n, spentCostMicrounits: 250n,
    });
    expect(bucket).toMatchObject({
      reservedCalls: 0, spentCalls: 1, reservedAudioMs: 0, spentAudioMs: 250,
      reservedCostMicrounits: 0n, spentCostMicrounits: 250n,
    });
    expect(chunk).toMatchObject({ leaseOwnerHash: null, leaseExpiresAt: null, leaseFence: 3, state: "failed" });
  });

  test("provider-v2 recording preparation is suppressed when deletion commits after the stale pre-read", async () => {
    const fixture = await seedOperation(250);
    const boundaries = fixtureBoundaries(fixture, []);
    const gap = pauseAfterCommittedTransaction(db, 1);
    const ctx = {
      db,
      vexa: { stopBot: async () => ({}), deleteMeeting: async () => ({}) },
      log: silentLogger,
    } as unknown as AppContext;
    let finalizing: ReturnType<typeof oneStep> | null = null;
    try {
      finalizing = oneStep(fixture, boundaries, { database: gap.database });
      await within(gap.entered, "provider-v2 preparation pre-read commit");
      await within(deleteMeetingById(ctx, fixture.projectId, fixture.meetingId), "provider-v2 preparation deletion-first commit");
      gap.release();
      expect((await within(finalizing, "provider-v2 preparation deletion-first settlement"))?.result).toBe("stale");
      expect(boundaries.prepares()).toBe(0);
    } finally {
      gap.release();
      if (finalizing) await within(Promise.allSettled([finalizing]), "provider-v2 preparation deletion-first cleanup");
    }
  });

  test("provider-v2 recording preparation handoff blocks deletion but its pending response does not", async () => {
    const fixture = await seedOperation(250);
    const boundaries = fixtureBoundaries(fixture, []);
    const response = deferred();
    boundaries.recording.prepare = async () => {
      await response.promise;
      return {
        pcm: { sampleRate: 1_000, sampleCount: 250, durationMs: 250, samples: new Int16Array(250).fill(4_000) },
        speakerIntervals: [{ speaker: "speaker-a", startSample: 0, endSample: 250 }],
      };
    };
    let invocations = 0;
    const originalPrepare = boundaries.recording.prepare;
    boundaries.recording.prepare = async (input) => {
      invocations += 1;
      return originalPrepare(input);
    };
    const handoff = pauseTransactionAfterInvocation(db, () => invocations === 1);
    const ctx = {
      db,
      vexa: { stopBot: async () => ({}), deleteMeeting: async () => ({}) },
      log: silentLogger,
    } as unknown as AppContext;
    let finalizing: ReturnType<typeof oneStep> | null = null;
    let deleting: Promise<void> | null = null;
    try {
      finalizing = oneStep(fixture, boundaries, { database: handoff.database });
      await within(handoff.entered, "provider-v2 preparation handoff");
      deleting = deleteMeetingById(ctx, fixture.projectId, fixture.meetingId);
      expect(await waitForMeetingDeletionLock()).toBe(true);
      handoff.release();
      await within(deleting, "provider-v2 preparation post-handoff deletion");
      expect(invocations).toBe(1);
      response.resolve();
      expect((await within(finalizing, "provider-v2 preparation response settlement"))?.result).toBe("stale");
    } finally {
      handoff.release();
      response.resolve();
      const cleanup: Promise<unknown>[] = [];
      if (finalizing) cleanup.push(finalizing);
      if (deleting) cleanup.push(deleting);
      await within(Promise.allSettled(cleanup), "provider-v2 preparation invocation-first cleanup");
    }
  });

  test("provider-v2 recording encoding is suppressed when deletion commits after authorization", async () => {
    const fixture = await seedOperation(250);
    const boundaries = fixtureBoundaries(fixture, []);
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    const gap = pauseAfterCommittedTransaction(db, 2);
    const ctx = {
      db,
      vexa: { stopBot: async () => ({}), deleteMeeting: async () => ({}) },
      log: silentLogger,
    } as unknown as AppContext;
    let finalizing: ReturnType<typeof oneStep> | null = null;
    try {
      finalizing = oneStep(fixture, boundaries, { database: gap.database });
      await within(gap.entered, "provider-v2 encoding authorization commit");
      await within(deleteMeetingById(ctx, fixture.projectId, fixture.meetingId), "provider-v2 encoding deletion-first commit");
      gap.release();
      expect((await within(finalizing, "provider-v2 encoding deletion-first settlement"))?.result).toBe("stale");
      expect(boundaries.encodes()).toBe(0);
    } finally {
      gap.release();
      if (finalizing) await within(Promise.allSettled([finalizing]), "provider-v2 encoding deletion-first cleanup");
    }
  });

  test("provider-v2 recording encoding handoff blocks deletion but its pending response does not", async () => {
    const fixture = await seedOperation(250);
    const boundaries = fixtureBoundaries(fixture, []);
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    const response = deferred();
    let invocations = 0;
    boundaries.recording.encode = async (input) => {
      invocations += 1;
      await response.promise;
      return { audio: new Uint8Array(44 + (input.endSample - input.startSample) * 2).fill(7), contentType: "audio/wav" };
    };
    const handoff = pauseTransactionAfterInvocation(db, () => invocations === 1);
    const ctx = {
      db,
      vexa: { stopBot: async () => ({}), deleteMeeting: async () => ({}) },
      log: silentLogger,
    } as unknown as AppContext;
    let finalizing: ReturnType<typeof oneStep> | null = null;
    let deleting: Promise<void> | null = null;
    try {
      finalizing = oneStep(fixture, boundaries, { database: handoff.database });
      await within(handoff.entered, "provider-v2 encoding handoff");
      deleting = deleteMeetingById(ctx, fixture.projectId, fixture.meetingId);
      expect(await waitForMeetingDeletionLock()).toBe(true);
      handoff.release();
      await within(deleting, "provider-v2 encoding post-handoff deletion");
      expect(invocations).toBe(1);
      response.resolve();
      expect((await within(finalizing, "provider-v2 encoding response settlement"))?.result).toBe("stale");
    } finally {
      handoff.release();
      response.resolve();
      const cleanup: Promise<unknown>[] = [];
      if (finalizing) cleanup.push(finalizing);
      if (deleting) cleanup.push(deleting);
      await within(Promise.allSettled(cleanup), "provider-v2 encoding invocation-first cleanup");
    }
  });

  test("provider-v2 deletion-first commits in the marked-to-invocation gap and suppresses dispatch", async () => {
    const fixture = await seedOperation(250);
    const boundaries = fixtureBoundaries(fixture, [success("must not run")]);
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    const gap = pauseAfterCommittedTransaction(db, 4);
    const ctx = {
      db,
      vexa: { stopBot: async () => ({}), deleteMeeting: async () => ({}) },
      log: silentLogger,
    } as unknown as AppContext;
    let finalizing: ReturnType<typeof oneStep> | null = null;
    try {
      finalizing = oneStep(fixture, boundaries, { database: gap.database });
      await within(gap.entered, "provider-v2 marked transaction commit");
      await within(deleteMeetingById(ctx, fixture.projectId, fixture.meetingId), "provider-v2 deletion-first commit");
      gap.release();
      expect((await within(finalizing, "provider-v2 deletion-first settlement"))?.result).toBe("stale");
      expect(boundaries.dispatches).toHaveLength(0);
      const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
      const [ledger] = await db.select().from(providerCallLedger).where(eq(providerCallLedger.operationId, fixture.operationId));
      const [bucket] = await db.select().from(projectRecoveryBuckets).where(eq(projectRecoveryBuckets.projectId, fixture.projectId));
      expect(operation).toMatchObject({ state: "cancelled", failureCode: "deleted", reservedCalls: 0, spentCalls: 1 });
      expect(ledger).toMatchObject({ dispatchState: "spent", outcomeCode: "unknown", statusClass: "none" });
      expect(bucket).toMatchObject({ reservedCalls: 0, spentCalls: 1, reservedAudioMs: 0, spentAudioMs: 250 });
    } finally {
      gap.release();
      if (finalizing) await within(Promise.allSettled([finalizing]), "provider-v2 deletion-first cleanup");
    }
  });

  test("provider-v2 invocation-first holds deletion only through dispatch handoff, not the response wait", async () => {
    const fixture = await seedOperation(250);
    const boundaries = fixtureBoundaries(fixture, []);
    const response = deferred();
    boundaries.provider.dispatch = async (input) => {
      boundaries.dispatches.push({ attempt: input.attempt, audioMs: input.submittedAudioMs, bytes: input.audio.byteLength });
      await response.promise;
      return success("must not publish");
    };
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    const handoff = pauseTransactionAfterInvocation(db, () => boundaries.dispatches.length === 1);
    const ctx = {
      db,
      vexa: { stopBot: async () => ({}), deleteMeeting: async () => ({}) },
      log: silentLogger,
    } as unknown as AppContext;
    let finalizing: ReturnType<typeof oneStep> | null = null;
    let deleting: Promise<void> | null = null;
    try {
      finalizing = oneStep(fixture, boundaries, { database: handoff.database });
      await within(handoff.entered, "provider-v2 dispatch handoff");
      deleting = deleteMeetingById(ctx, fixture.projectId, fixture.meetingId);
      expect(await waitForMeetingDeletionLock()).toBe(true);
      handoff.release();
      await within(deleting, "provider-v2 post-handoff deletion");
      expect(boundaries.dispatches).toHaveLength(1);
      response.resolve();
      expect((await within(finalizing, "provider-v2 invocation-first settlement"))?.result).toBe("stale");
    } finally {
      handoff.release();
      response.resolve();
      const cleanup: Promise<unknown>[] = [];
      if (finalizing) cleanup.push(finalizing);
      if (deleting) cleanup.push(deleting);
      await within(Promise.allSettled(cleanup), "provider-v2 invocation-first cleanup");
    }
  });

  test("provider-v2 fallback coverage is suppressed when deletion commits after leaf authorization", async () => {
    const fixture = await seedOperation(200);
    const { speakerRef } = await seedFailedFallbackLeaf(fixture);
    const boundaries = fixtureBoundaries(fixture, [], undefined, [
      { startMs: 0, endMs: 200, speakerRef, text: "must not run", provenance: "vexa_fallback" },
    ]);
    const policy = { ...POLICY, fallbackEnabled: true } as DurableFinalizerPolicy;
    const gap = pauseAfterCommittedTransaction(db, 2);
    const ctx = {
      db,
      vexa: { stopBot: async () => ({}), deleteMeeting: async () => ({}) },
      log: silentLogger,
    } as unknown as AppContext;
    let finalizing: ReturnType<typeof oneStep> | null = null;
    try {
      finalizing = oneStep(fixture, boundaries, { database: gap.database, policy });
      await within(gap.entered, "provider-v2 fallback authorization commit");
      await within(deleteMeetingById(ctx, fixture.projectId, fixture.meetingId), "provider-v2 fallback deletion-first commit");
      gap.release();
      expect((await within(finalizing, "provider-v2 fallback deletion-first settlement"))?.result).toBe("stale");
      expect(boundaries.fallbackCalls()).toBe(0);
    } finally {
      gap.release();
      if (finalizing) await within(Promise.allSettled([finalizing]), "provider-v2 fallback deletion-first cleanup");
    }
  });

  test("provider-v2 fallback revalidates its completed ledger authority at call start", async () => {
    const fixture = await seedOperation(200);
    const { ledgerId, speakerRef } = await seedFailedFallbackLeaf(fixture);
    const boundaries = fixtureBoundaries(fixture, [], undefined, [
      { startMs: 0, endMs: 200, speakerRef, text: "must not run", provenance: "vexa_fallback" },
    ]);
    const policy = { ...POLICY, fallbackEnabled: true } as DurableFinalizerPolicy;
    const gap = pauseAfterCommittedTransaction(db, 2);
    let finalizing: ReturnType<typeof oneStep> | null = null;
    try {
      finalizing = oneStep(fixture, boundaries, { database: gap.database, policy });
      await within(gap.entered, "provider-v2 fallback original authorization commit");
      await db.update(providerCallLedger).set({ outcomeCode: "invalid_response", statusClass: "2xx" })
        .where(eq(providerCallLedger.id, ledgerId));
      gap.release();
      await within(finalizing, "provider-v2 fallback authority-loss settlement");
      expect(boundaries.fallbackCalls()).toBe(0);
    } finally {
      gap.release();
      if (finalizing) await within(Promise.allSettled([finalizing]), "provider-v2 fallback authority-loss cleanup");
    }
  });

  test("provider-v2 fallback handoff blocks deletion but its pending response does not", async () => {
    const fixture = await seedOperation(200);
    const { speakerRef } = await seedFailedFallbackLeaf(fixture);
    const boundaries = fixtureBoundaries(fixture, [], undefined, [
      { startMs: 0, endMs: 200, speakerRef, text: "fallback", provenance: "vexa_fallback" },
    ]);
    const policy = { ...POLICY, fallbackEnabled: true } as DurableFinalizerPolicy;
    const response = deferred();
    let invocations = 0;
    boundaries.fallback.coverage = async () => {
      invocations += 1;
      await response.promise;
      return [{ startMs: 0, endMs: 200, speakerRef, text: "fallback", provenance: "vexa_fallback" }];
    };
    const handoff = pauseTransactionAfterInvocation(db, () => invocations === 1);
    const ctx = {
      db,
      vexa: { stopBot: async () => ({}), deleteMeeting: async () => ({}) },
      log: silentLogger,
    } as unknown as AppContext;
    let finalizing: ReturnType<typeof oneStep> | null = null;
    let deleting: Promise<void> | null = null;
    try {
      finalizing = oneStep(fixture, boundaries, { database: handoff.database, policy });
      await within(handoff.entered, "provider-v2 fallback handoff");
      deleting = deleteMeetingById(ctx, fixture.projectId, fixture.meetingId);
      expect(await waitForMeetingDeletionLock()).toBe(true);
      handoff.release();
      await within(deleting, "provider-v2 fallback post-handoff deletion");
      expect(invocations).toBe(1);
      response.resolve();
      expect((await within(finalizing, "provider-v2 fallback response settlement"))?.result).toBe("stale");
    } finally {
      handoff.release();
      response.resolve();
      const cleanup: Promise<unknown>[] = [];
      if (finalizing) cleanup.push(finalizing);
      if (deleting) cleanup.push(deleting);
      await within(Promise.allSettled(cleanup), "provider-v2 fallback invocation-first cleanup");
    }
  });

  test("B4 publishes one atomic mixed provider/fallback revision with exact per-segment provenance", async () => {
    const fixture = await seedOperation(1_000);
    const speakerA = createHash("sha256").update("speaker-a").digest("hex");
    const speakerB = createHash("sha256").update("speaker-b").digest("hex");
    const boundaries = fixtureBoundaries(
      fixture,
      [success("provider leaf"), unavailable("http_5xx"), unavailable("http_5xx")],
      [
        { speaker: "speaker-a", startSample: 0, endSample: 500 },
        { speaker: "speaker-b", startSample: 500, endSample: 1_000 },
      ],
      [
        { startMs: 0, endMs: 500, speakerRef: speakerA, text: "unused complete coverage", provenance: "vexa_fallback" },
        { startMs: 500, endMs: 1_000, speakerRef: speakerB, text: "fallback leaf", provenance: "vexa_fallback" },
      ],
    );
    const policy = { ...POLICY, fallbackEnabled: true } as DurableFinalizerPolicy;
    for (let index = 0; index < 40; index++) {
      const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
      if (meeting?.status === "completed" || meeting?.status === "failed") break;
      const step = await oneStep(fixture, boundaries, { policy });
      if (!step) {
        await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
        await isolated.sql`update transcription_chunks set next_eligible_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'retry_scheduled'`;
      }
    }
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(meeting).toMatchObject({ status: "completed", transcriptRevision: 1 });
    expect(boundaries.dispatches).toHaveLength(3);
    expect(boundaries.fallbackCalls()).toBe(1);
    const chunks = await db.select().from(transcriptionChunks)
      .where(eq(transcriptionChunks.operationId, fixture.operationId));
    expect(chunks.sort((a, b) => a.startMs - b.startMs).map(({ state, provenance }) => ({ state, provenance }))).toEqual([
      { state: "succeeded", provenance: "provider" },
      { state: "fallback", provenance: "vexa_fallback" },
    ]);
    const [stored] = await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId));
    expect(stored).toMatchObject({ provider: "provider-v2+vexa", fallbackFrom: "provider-v2", fallbackReason: "provider_exhausted" });
    expect((stored!.segmentsJson as { segments: Array<{ provenance: string }> }).segments.map((segment) => segment.provenance))
      .toEqual(["provider", "vexa_fallback"]);
    const notifications = await db.select().from(outboxJobs).where(and(
      eq(outboxJobs.operationId, fixture.operationId), eq(outboxJobs.eventType, "notification.deliver"),
    ));
    expect(notifications).toHaveLength(1);
  });

  test.each([
    ["leading gap", [
      { startMs: 1, endMs: 1_000, speakerRef: createHash("sha256").update("speaker-a").digest("hex"), text: "late", provenance: "vexa_fallback" },
    ]],
    ["interior gap", [
      { startMs: 0, endMs: 400, speakerRef: createHash("sha256").update("speaker-a").digest("hex"), text: "left", provenance: "vexa_fallback" },
      { startMs: 401, endMs: 1_000, speakerRef: createHash("sha256").update("speaker-a").digest("hex"), text: "right", provenance: "vexa_fallback" },
    ]],
    ["blank interval", [
      { startMs: 0, endMs: 1_000, speakerRef: createHash("sha256").update("speaker-a").digest("hex"), text: " \t", provenance: "vexa_fallback" },
    ]],
    ["trailing gap", [
      { startMs: 0, endMs: 999, speakerRef: createHash("sha256").update("speaker-a").digest("hex"), text: "short", provenance: "vexa_fallback" },
    ]],
  ] as const)("B4 %s blocks completion without publication", async (_name, coverage) => {
    const fixture = await seedOperation(1_000);
    const boundaries = fixtureBoundaries(
      fixture,
      [unavailable("http_5xx"), unavailable("http_5xx")],
      undefined,
      coverage,
    );
    const policy = { ...POLICY, fallbackEnabled: true } as DurableFinalizerPolicy;
    for (let index = 0; index < 30; index++) {
      const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
      if (meeting?.status === "completed" || meeting?.status === "failed") break;
      const step = await oneStep(fixture, boundaries, { policy });
      if (!step) {
        await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
        await isolated.sql`update transcription_chunks set next_eligible_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'retry_scheduled'`;
      }
    }
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(meeting).toMatchObject({ status: "failed", errorCode: "coverage_incomplete", transcriptRevision: 0 });
    expect(await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId))).toHaveLength(0);
    expect(boundaries.dispatches).toHaveLength(2);
  });

  test("B4 fallback policy switch-off parks the next fallback step and switch-on resumes without changing durable truth", async () => {
    const fixture = await seedOperation(1_000);
    const speakerA = createHash("sha256").update("speaker-a").digest("hex");
    const speakerB = createHash("sha256").update("speaker-b").digest("hex");
    const boundaries = fixtureBoundaries(
      fixture,
      [unavailable("http_5xx"), unavailable("http_5xx"), unavailable("http_5xx"), unavailable("http_5xx")],
      [
        { speaker: "speaker-a", startSample: 0, endSample: 500 },
        { speaker: "speaker-b", startSample: 500, endSample: 1_000 },
      ],
      [
        { startMs: 0, endMs: 500, speakerRef: speakerA, text: "first complete", provenance: "vexa_fallback" },
        { startMs: 500, endMs: 1_000, speakerRef: speakerB, text: "second complete", provenance: "vexa_fallback" },
      ],
    );
    const policy = { ...POLICY, fallbackEnabled: true };
    let hasProtectedFallback = false;
    for (let index = 0; index < 30; index++) {
      const step = await oneStep(fixture, boundaries, { policy });
      if (!step) {
        await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
        await isolated.sql`update transcription_chunks set next_eligible_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'retry_scheduled'`;
      }
      const fallbackLeaves = await db.select().from(transcriptionChunks).where(and(
        eq(transcriptionChunks.operationId, fixture.operationId), eq(transcriptionChunks.state, "fallback"),
      ));
      hasProtectedFallback ||= fallbackLeaves.length === 1;
      const failedLeaves = await db.select().from(transcriptionChunks).where(and(
        eq(transcriptionChunks.operationId, fixture.operationId), eq(transcriptionChunks.state, "failed"),
      ));
      if (hasProtectedFallback && failedLeaves.length === 1) break;
    }
    expect(hasProtectedFallback).toBe(true);
    policy.fallbackEnabled = false;
    const beforeLedger = await ledgerTotals(fixture.operationId);
    const beforeChunks = await db.select().from(transcriptionChunks).where(eq(transcriptionChunks.operationId, fixture.operationId));
    const [beforeOperation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    expect((await oneStep(fixture, boundaries, { policy }))?.result).toBe("parked");
    const afterLedger = await ledgerTotals(fixture.operationId);
    const afterChunks = await db.select().from(transcriptionChunks).where(eq(transcriptionChunks.operationId, fixture.operationId));
    const [afterOperation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    expect(afterLedger).toEqual(beforeLedger);
    expect(afterChunks).toEqual(beforeChunks);
    expect(afterOperation).toMatchObject({
      plannedAudioMs: beforeOperation!.plannedAudioMs,
      submittedAudioMs: beforeOperation!.submittedAudioMs,
      reservedCalls: beforeOperation!.reservedCalls,
      spentCalls: beforeOperation!.spentCalls,
      reservedCostMicrounits: beforeOperation!.reservedCostMicrounits,
      spentCostMicrounits: beforeOperation!.spentCostMicrounits,
      deadlineAt: beforeOperation!.deadlineAt,
      state: "delayed",
      phase: "disabled",
      completedAt: null,
    });
    expect(boundaries.dispatches).toHaveLength(4);
    expect(boundaries.fallbackCalls()).toBe(1);
    expect(await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId))).toHaveLength(0);
    policy.fallbackEnabled = true;
    expect(await repairOutboxJobs({ db, policy: DELIVERY, limit: 10 })).toMatchObject({ requeued: 1 });
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
    for (let index = 0; index < 12; index++) {
      const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
      if (meeting?.status === "completed") break;
      const step = await oneStep(fixture, boundaries, { policy });
      if (!step) await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
    }
    const [completed] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(completed).toMatchObject({ status: "completed", transcriptRevision: 1 });
    expect(await ledgerTotals(fixture.operationId)).toEqual(beforeLedger);
    expect(boundaries.dispatches).toHaveLength(4);
    expect(boundaries.fallbackCalls()).toBe(2);
  });

  test("B4 restart after a protected fallback checkpoint converges without duplicate calls, chunks, revision, or notification", async () => {
    const fixture = await seedOperation(1_000);
    const speaker = createHash("sha256").update("speaker-a").digest("hex");
    const boundaries = fixtureBoundaries(fixture, [unavailable("http_5xx"), unavailable("http_5xx")], undefined, [
      { startMs: 0, endMs: 1_000, speakerRef: speaker, text: "durable fallback", provenance: "vexa_fallback" },
    ]);
    const policy = { ...POLICY, fallbackEnabled: true } as DurableFinalizerPolicy;
    let crashedClaim: OutboxClaim | null = null;
    for (let index = 0; index < 12; index++) {
      try {
        const step = await oneStep(fixture, boundaries, {
          policy,
          fault(point) { if (point === "after_fallback_checkpoint") throw new Error("synthetic fallback acknowledgement loss"); },
        });
        if (!step) {
          await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
          await isolated.sql`update transcription_chunks set next_eligible_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'retry_scheduled'`;
        }
      } catch (error) {
        expect(error).toMatchObject({ message: "synthetic fallback acknowledgement loss" });
        const [leased] = await db.select().from(outboxJobs).where(and(
          eq(outboxJobs.operationId, fixture.operationId), eq(outboxJobs.state, "leased"),
        ));
        crashedClaim = leased ? {
          id: leased.id,
          projectId: leased.projectId,
          operationId: leased.operationId!,
          eventType: leased.eventType,
          chunkId: leased.chunkId,
          fence: leased.leaseFence,
          attempt: leased.attempt,
        } : null;
        break;
      }
    }
    expect(crashedClaim).not.toBeNull();
    const protectedLeaves = await db.select().from(transcriptionChunks).where(and(
      eq(transcriptionChunks.operationId, fixture.operationId), eq(transcriptionChunks.state, "fallback"),
    ));
    expect(protectedLeaves).toHaveLength(1);
    await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${crashedClaim!.id}`;
    expect((await reapExpiredOutboxJobs({ db, policy: DELIVERY, limit: 10 })).requeued).toBe(1);
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
    for (let index = 0; index < 12; index++) {
      const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
      if (meeting?.status === "completed") break;
      const step = await oneStep(fixture, boundaries, { policy });
      if (!step) await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
    }
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(meeting).toMatchObject({ status: "completed", transcriptRevision: 1 });
    expect(boundaries.dispatches).toHaveLength(2);
    expect(boundaries.fallbackCalls()).toBe(1);
    expect(await db.select().from(transcriptionChunks).where(eq(transcriptionChunks.operationId, fixture.operationId))).toHaveLength(1);
    expect(await db.select().from(outboxJobs).where(and(
      eq(outboxJobs.operationId, fixture.operationId), eq(outboxJobs.eventType, "notification.deliver"),
    ))).toHaveLength(1);
    expect(await runDurableFinalizerStep({
      db,
      claim: crashedClaim!,
      owner: `synthetic-b3-worker-${sequence}`,
      policy,
      recording: boundaries.recording,
      provider: boundaries.provider,
      breaker: boundaries.breaker,
      protector: boundaries.protector,
      fallback: boundaries.fallback,
      priceAttempt: ({ submittedAudioMs }) => BigInt(submittedAudioMs),
    })).toBe("stale");
  });

  test.each([
    ["authorization", rejected("authorization"), "provider_rejected"],
    ["attestation", rejected("attestation_failed"), "attestation_failed"],
    ["invalid response", rejected("invalid_response"), "provider_rejected"],
    ["persistence", { outcome: {
      kind: "persistence_failed", errorCode: "persistence_failed", attempted: true, spent: true,
      outcomeCode: "unknown", statusClass: "none",
    } } as DurableProviderAttemptResult, "persistence_failed"],
  ] as const)("B4 %s failure never selects fallback", async (_name, response, expectedCode) => {
    const fixture = await seedOperation(1_000);
    const speaker = createHash("sha256").update("speaker-a").digest("hex");
    const boundaries = fixtureBoundaries(fixture, [response], undefined, [
      { startMs: 0, endMs: 1_000, speakerRef: speaker, text: "must remain unused", provenance: "vexa_fallback" },
    ]);
    const policy = { ...POLICY, fallbackEnabled: true } as DurableFinalizerPolicy;
    for (let index = 0; index < 8; index++) {
      const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
      if (meeting?.status === "failed") break;
      await oneStep(fixture, boundaries, { policy });
    }
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(meeting).toMatchObject({ status: "failed", errorCode: expectedCode, transcriptRevision: 0 });
    expect(boundaries.fallbackCalls()).toBe(0);
    expect(await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId))).toHaveLength(0);
  });

  test.each([
    ["authorization ledger", "authorization", "provider_rejected"],
    ["attestation ledger", "attestation", "attestation_failed"],
    ["invalid-response ledger", "invalid_response", "provider_rejected"],
    ["permanent HTTP 4xx ledger", "permanent_4xx", "provider_rejected"],
    ["missing referenced ledger", "missing", "persistence_failed"],
    ["retry-not-exhausted leaf", "retry_not_exhausted", "persistence_failed"],
    ["stale ledger attempt", "stale_attempt", "persistence_failed"],
    ["outcome/status mismatch", "status_mismatch", "persistence_failed"],
    ["unsettled accounting shape", "unsettled", "persistence_failed"],
  ] as const)("B4 restart authorization rejects %s before any fallback call", async (_name, corruption, expectedCode) => {
    const fixture = await seedOperation(1_000);
    const speaker = createHash("sha256").update("speaker-a").digest("hex");
    const boundaries = fixtureBoundaries(fixture, [unavailable("http_5xx"), unavailable("http_5xx")], undefined, [
      { startMs: 0, endMs: 1_000, speakerRef: speaker, text: "must remain unused", provenance: "vexa_fallback" },
    ]);
    const policy = { ...POLICY, fallbackEnabled: true } as DurableFinalizerPolicy;
    let failed: typeof transcriptionChunks.$inferSelect | undefined;
    for (let index = 0; index < 12 && !failed; index++) {
      const step = await oneStep(fixture, boundaries, { policy });
      if (!step) {
        await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
        await isolated.sql`update transcription_chunks set next_eligible_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'retry_scheduled'`;
      }
      [failed] = await db.select().from(transcriptionChunks).where(and(
        eq(transcriptionChunks.operationId, fixture.operationId),
        eq(transcriptionChunks.state, "failed"),
      ));
    }
    expect(failed).toMatchObject({ state: "failed", retryCount: 1, attempt: 2 });
    expect(boundaries.fallbackCalls()).toBe(0);

    if (corruption === "missing") {
      await isolated.sql`update transcription_chunks set provider_call_ledger_id = null where id = ${failed!.id}`;
    } else if (corruption === "retry_not_exhausted") {
      await isolated.sql`update transcription_chunks set retry_count = 0 where id = ${failed!.id}`;
    } else if (corruption === "stale_attempt") {
      const [firstLedger] = await db.select().from(providerCallLedger).where(and(
        eq(providerCallLedger.chunkId, failed!.id),
        eq(providerCallLedger.attempt, 1),
      ));
      await isolated.sql`update transcription_chunks set provider_call_ledger_id = ${firstLedger!.id} where id = ${failed!.id}`;
    } else if (corruption === "unsettled") {
      await isolated.sql`
        update provider_call_ledger set dispatch_state = 'spent', completed_at = null
        where id = ${failed!.providerCallLedgerId}
      `;
    } else {
      const tuple = corruption === "attestation"
        ? ["attestation_failed", "none"]
        : corruption === "invalid_response"
          ? ["invalid_response", "2xx"]
          : corruption === "status_mismatch"
            ? ["http_5xx", "4xx"]
            : ["http_4xx", "4xx"];
      await isolated.sql`
        update provider_call_ledger set outcome_code = ${tuple[0]}, status_class = ${tuple[1]}
        where id = ${failed!.providerCallLedgerId}
      `;
    }

    expect((await oneStep(fixture, boundaries, { policy }))?.result).toBe("terminal");
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(meeting).toMatchObject({ status: "failed", errorCode: expectedCode, transcriptRevision: 0 });
    expect(boundaries.fallbackCalls()).toBe(0);
    expect(await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId))).toHaveLength(0);
  });

  test.each([
    ["network timeout at split floor", 200, [timeout()]],
    ["HTTP 408 at split floor", 200, [timeout("http_408")]],
    ["transport after one durable retry", 1_000, [unavailable("transport_error"), unavailable("transport_error")]],
    ["HTTP 429 after one durable retry", 1_000, [unavailable("http_429"), unavailable("http_429")]],
    ["HTTP 5xx after one durable retry", 1_000, [unavailable("http_5xx"), unavailable("http_5xx")]],
  ] as const)("B4 ledger truth authorizes only exhausted %s", async (_name, sampleCount, responses) => {
    const fixture = await seedOperation(sampleCount);
    const speaker = createHash("sha256").update("speaker-a").digest("hex");
    const boundaries = fixtureBoundaries(fixture, [...responses], undefined, [
      { startMs: 0, endMs: sampleCount, speakerRef: speaker, text: "authorized fallback", provenance: "vexa_fallback" },
    ]);
    const policy = { ...POLICY, fallbackEnabled: true } as DurableFinalizerPolicy;
    expect(await drive(fixture, boundaries, 40, policy)).toMatchObject({ status: "completed", transcriptRevision: 1 });
    expect(boundaries.dispatches).toHaveLength(responses.length);
    expect(boundaries.fallbackCalls()).toBe(1);
  });
  test("a well-formed pre-dispatch refusal is unspent while inconsistent accounting fails closed as spent unknown", async () => {
    const refused = await seedOperation(200);
    const refusedBoundaries = fixtureBoundaries(refused, [preDispatchRefusal()]);
    expect((await drive(refused, refusedBoundaries)).errorCode).toBe("attestation_failed");
    const refusedLedger = await ledgerTotals(refused.operationId);
    expect(refusedLedger.rows).toEqual([expect.objectContaining({
      dispatchState: "not_dispatched",
      outcomeCode: "not_dispatched",
      spentCostMicrounits: 0n,
    })]);
    const [refusedOperation] = await db.select().from(recoveryOperations)
      .where(eq(recoveryOperations.id, refused.operationId));
    const [refusedBucket] = await db.select().from(projectRecoveryBuckets)
      .where(eq(projectRecoveryBuckets.projectId, refused.projectId));
    expect(refusedOperation).toMatchObject({ reservedCalls: 0, spentCalls: 0, submittedAudioMs: 0, reservedCostMicrounits: 0n, spentCostMicrounits: 0n });
    expect(refusedBucket).toMatchObject({ reservedCalls: 0, spentCalls: 0, reservedAudioMs: 0, spentAudioMs: 0, reservedCostMicrounits: 0n, spentCostMicrounits: 0n });

    const inconsistent = await seedOperation(200);
    const inconsistentBoundaries = fixtureBoundaries(inconsistent, [invalidAccounting()]);
    expect((await drive(inconsistent, inconsistentBoundaries)).errorCode).toBe("persistence_failed");
    const inconsistentLedger = await ledgerTotals(inconsistent.operationId);
    expect(inconsistentLedger.rows).toEqual([expect.objectContaining({
      dispatchState: "spent",
      outcomeCode: "unknown",
      spentCostMicrounits: 200n,
    })]);
    const [inconsistentOperation] = await db.select().from(recoveryOperations)
      .where(eq(recoveryOperations.id, inconsistent.operationId));
    expect(inconsistentOperation).toMatchObject({ reservedCalls: 0, spentCalls: 1, submittedAudioMs: 200, spentCostMicrounits: 200n });
  });

  test("incoherent success-shaped tuples and accessor-shaped results fail closed as spent unknown without checkpointing", async () => {
    let accessorCalls = 0;
    const cases: Array<{ name: string; result: DurableProviderAttemptResult }> = [
      {
        name: "success-with-5xx",
        result: {
          outcome: {
            kind: "success",
            data: { text: "must never be protected" },
            attempted: true,
            spent: true,
            outcomeCode: "http_5xx",
            statusClass: "5xx",
          } as unknown as ProviderV2Outcome,
        },
      },
      {
        name: "unavailable-with-success",
        result: {
          outcome: {
            kind: "unavailable",
            errorCode: "provider_unavailable",
            attempted: true,
            spent: true,
            outcomeCode: "success",
            statusClass: "2xx",
          } as unknown as ProviderV2Outcome,
        },
      },
      {
        name: "accessor-result",
        result: Object.defineProperty({}, "outcome", {
          enumerable: true,
          get() {
            accessorCalls += 1;
            return success("accessor text").outcome;
          },
        }) as DurableProviderAttemptResult,
      },
    ];

    for (const item of cases) {
      const fixture = await seedOperation(180);
      const boundaries = fixtureBoundaries(fixture, [item.result]);
      const protectedValues: string[] = [];
      boundaries.protector.protect = async (text) => {
        protectedValues.push(text);
        return { ciphertext: "forbidden", nonce: "forbidden", keyVersion: "forbidden" };
      };
      const meeting = await drive(fixture, boundaries);
      expect(meeting, item.name).toMatchObject({ status: "failed", errorCode: "persistence_failed", transcriptRevision: 0 });
      expect(protectedValues, item.name).toEqual([]);
      expect(await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId)), item.name).toEqual([]);
      const ledger = await ledgerTotals(fixture.operationId);
      expect(ledger.rows, item.name).toEqual([expect.objectContaining({
        dispatchState: "spent",
        outcomeCode: "unknown",
        statusClass: "none",
        spentCostMicrounits: 180n,
      })]);
      const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
      const [bucket] = await db.select().from(projectRecoveryBuckets).where(eq(projectRecoveryBuckets.projectId, fixture.projectId));
      expect(operation, item.name).toMatchObject({ reservedCalls: 0, spentCalls: 1, submittedAudioMs: 180, spentCostMicrounits: 180n });
      expect(bucket, item.name).toMatchObject({ reservedCalls: 0, spentCalls: 1, reservedAudioMs: 0, spentAudioMs: 180, spentCostMicrounits: 180n });
    }
    expect(accessorCalls).toBe(0);
  });

  test("a nested success text accessor is never invoked and settles once as spent unknown", async () => {
    const fixture = await seedOperation(180);
    let accessorCalls = 0;
    let protectorCalls = 0;
    const data = Object.defineProperty({}, "text", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "must never cross the provider boundary";
      },
    });
    const boundaries = fixtureBoundaries(fixture, [{
      outcome: {
        kind: "success",
        data,
        attempted: true,
        spent: true,
        outcomeCode: "success",
        statusClass: "2xx",
      } as unknown as ProviderV2Outcome,
    }]);
    boundaries.protector.protect = async () => {
      protectorCalls += 1;
      return { ciphertext: "forbidden", nonce: "forbidden", keyVersion: "forbidden" };
    };

    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    const terminal = await oneStep(fixture, boundaries);
    expect(terminal?.result).toBe("terminal");
    expect(accessorCalls).toBe(0);
    expect(protectorCalls).toBe(0);
    expect(boundaries.dispatches).toHaveLength(1);

    const ledger = await ledgerTotals(fixture.operationId);
    expect(ledger.rows).toEqual([expect.objectContaining({
      dispatchState: "spent",
      outcomeCode: "unknown",
      statusClass: "none",
      submittedAudioMs: 180,
      reservedCostMicrounits: 0n,
      spentCostMicrounits: 180n,
    })]);
    expect({ calls: ledger.calls, audioMs: ledger.audioMs, cost: ledger.cost }).toEqual({
      calls: 1,
      audioMs: 180,
      cost: 180n,
    });
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    const [bucket] = await db.select().from(projectRecoveryBuckets).where(eq(projectRecoveryBuckets.projectId, fixture.projectId));
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    const [chunk] = await db.select().from(transcriptionChunks).where(eq(transcriptionChunks.operationId, fixture.operationId));
    expect(operation).toMatchObject({
      state: "failed",
      phase: "failed",
      failureCode: "persistence_failed",
      reservedCalls: 0,
      spentCalls: 1,
      submittedAudioMs: 180,
      reservedCostMicrounits: 0n,
      spentCostMicrounits: 180n,
    });
    expect(bucket).toMatchObject({
      reservedCalls: 0,
      spentCalls: 1,
      reservedAudioMs: 0,
      spentAudioMs: 180,
      reservedCostMicrounits: 0n,
      spentCostMicrounits: 180n,
    });
    expect(meeting).toMatchObject({
      status: "failed",
      errorCode: "persistence_failed",
      transcriptRevision: 0,
      activeRecoveryOperationId: null,
    });
    expect(chunk).toMatchObject({
      state: "failed",
      checkpointCiphertext: null,
      checkpointNonce: null,
      checkpointKeyVersion: null,
      checkpointContentHash: null,
    });
    expect(await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId))).toEqual([]);
    expect(await db.select().from(outboxJobs).where(and(
      eq(outboxJobs.operationId, fixture.operationId),
      eq(outboxJobs.eventType, "notification.deliver"),
    ))).toEqual([]);

    const owner = `synthetic-b3-worker-${sequence}`;
    expect(await runDurableFinalizerStep({
      db,
      claim: terminal!.claim,
      owner,
      policy: POLICY,
      recording: boundaries.recording,
      provider: boundaries.provider,
      breaker: boundaries.breaker,
      protector: boundaries.protector,
      priceAttempt: ({ submittedAudioMs }) => BigInt(submittedAudioMs),
    })).toBe("stale");
    expect(await oneStep(fixture, boundaries)).toBeNull();
    expect(accessorCalls).toBe(0);
    expect(protectorCalls).toBe(0);
    expect(boundaries.dispatches).toHaveLength(1);
    expect(await ledgerTotals(fixture.operationId)).toEqual(ledger);
  });

  test("a pre-plan finalizer park still reaches its accepted hard deadline with zero calls", async () => {
    const fixture = await seedOperation(200);
    const boundaries = fixtureBoundaries(fixture, [success("unused")]);
    expect((await oneStep(fixture, boundaries, {
      policy: { ...POLICY, maxOperationCalls: null },
    }))?.result).toBe("parked");
    expect(boundaries.prepares()).toBe(0);
    expect(boundaries.dispatches).toHaveLength(0);
    await isolated.sql`update recovery_operations set deadline_at = clock_timestamp() - interval '1 millisecond' where id = ${fixture.operationId}`;
    expect(await enforceParkedOperationDeadline({ db })).not.toBeNull();
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(operation).toMatchObject({ state: "failed", failureCode: "operation_deadline_exceeded", reservedCalls: 0, spentCalls: 0 });
    expect(meeting).toMatchObject({ status: "failed", errorCode: "operation_deadline_exceeded", activeRecoveryOperationId: null });
    expect(await ledgerTotals(fixture.operationId)).toMatchObject({ calls: 0, audioMs: 0, cost: 0n });
  });

  test("parking unwinds the chunk and reservation, then repair and re-enable complete at exact paid caps", async () => {
    const fixture = await seedOperation(300);
    const boundaries = fixtureBoundaries(fixture, [success("resumed")]);
    (boundaries.provider as { ready: boolean }).ready = false;
    const exactCaps: DurableFinalizerPolicy = {
      ...POLICY,
      maxOperationCalls: 1,
      maxOperationAudioMs: 300,
      maxOperationCostMicrounits: 300n,
    };
    expect((await oneStep(fixture, boundaries, { policy: exactCaps }))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries, { policy: exactCaps }))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries, { policy: exactCaps }))?.result).toBe("parked");
    expect(boundaries.dispatches).toHaveLength(0);
    const [parkedChunk] = await db.select().from(transcriptionChunks)
      .where(eq(transcriptionChunks.operationId, fixture.operationId));
    expect(parkedChunk).toMatchObject({ state: "planned", providerCallLedgerId: null });
    const [parkedOperation] = await db.select().from(recoveryOperations)
      .where(eq(recoveryOperations.id, fixture.operationId));
    const [parkedMeeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(parkedOperation).toMatchObject({ state: "delayed", phase: "disabled", reservedCalls: 0, spentCalls: 0 });
    expect(parkedMeeting.recoveryPhase).toBe("disabled");

    (boundaries.provider as { ready: boolean }).ready = true;
    expect(await repairOutboxJobs({ db, policy: DELIVERY, limit: 10 })).toMatchObject({ requeued: 1 });
    const meeting = await drive(fixture, boundaries);
    expect(meeting).toMatchObject({ status: "completed", transcriptRevision: 1 });
    expect(boundaries.dispatches).toHaveLength(1);
    const ledger = await ledgerTotals(fixture.operationId);
    expect(ledger.rows.sort((a, b) => a.attempt - b.attempt)
      .map((row) => [row.dispatchState, row.outcomeCode, row.spentCostMicrounits])).toEqual([
      ["not_dispatched", "not_dispatched", 0n],
      ["completed", "success", 300n],
    ]);
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    const [bucket] = await db.select().from(projectRecoveryBuckets).where(eq(projectRecoveryBuckets.projectId, fixture.projectId));
    expect(operation).toMatchObject({ reservedCalls: 0, spentCalls: 1, submittedAudioMs: 300, reservedCostMicrounits: 0n, spentCostMicrounits: 300n });
    expect(bucket).toMatchObject({ reservedCalls: 0, spentCalls: 1, reservedAudioMs: 0, spentAudioMs: 300, reservedCostMicrounits: 0n, spentCostMicrounits: 300n });
  });

  test("invalid success data, attestation failure, ordinary 400, and unproved 413 settle terminally without retries", async () => {
    const cases = [
      { name: "invalid-success", result: rejected("invalid_response"), code: "provider_rejected", outcome: "invalid_response" },
      { name: "attestation", result: rejected("attestation_failed"), code: "attestation_failed", outcome: "attestation_failed" },
      { name: "http-400", result: rejected("rejected"), code: "provider_rejected", outcome: "http_4xx" },
      { name: "http-413-unproved", result: rejected("rejected"), code: "provider_rejected", outcome: "http_4xx" },
    ] as const;
    for (const item of cases) {
      const fixture = await seedOperation(100);
      const boundaries = fixtureBoundaries(fixture, [item.result]);
      const meeting = await drive(fixture, boundaries);
      expect(meeting.errorCode, item.name).toBe(item.code);
      expect(boundaries.dispatches, item.name).toHaveLength(1);
      const ledger = await ledgerTotals(fixture.operationId);
      expect(ledger.rows, item.name).toEqual([expect.objectContaining({ outcomeCode: item.outcome, spentCostMicrounits: 100n })]);
    }
  });

  test("a whitespace-only trailing success is spent invalid and cannot revise or notify a partial transcript", async () => {
    const fixture = await seedOperation(1_000);
    await db.insert(transcripts).values({
      meetingId: fixture.meetingId,
      language: "en",
      durationSeconds: 9,
      segmentsJson: { marker: "unchanged" },
      provider: "synthetic-existing",
    });
    await db.update(meetings).set({ transcriptRevision: 4 }).where(eq(meetings.id, fixture.meetingId));
    const boundaries = fixtureBoundaries(
      fixture,
      [success("first leaf"), success("\t \n")],
      [
        { speaker: "a", startSample: 0, endSample: 500 },
        { speaker: "b", startSample: 500, endSample: 1_000 },
      ],
    );

    const meeting = await drive(fixture, boundaries);
    expect(meeting).toMatchObject({
      status: "failed",
      errorCode: "provider_rejected",
      transcriptRevision: 4,
      activeRecoveryOperationId: null,
    });
    expect(boundaries.dispatches).toHaveLength(2);
    const ledger = await ledgerTotals(fixture.operationId);
    expect(ledger.rows.map((row) => [row.dispatchState, row.outcomeCode, row.spentCostMicrounits])).toEqual([
      ["completed", "success", 500n],
      ["completed", "invalid_response", 500n],
    ]);
    expect({ calls: ledger.calls, audioMs: ledger.audioMs, cost: ledger.cost }).toEqual({
      calls: 2,
      audioMs: 1_000,
      cost: 1_000n,
    });
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    const [bucket] = await db.select().from(projectRecoveryBuckets).where(eq(projectRecoveryBuckets.projectId, fixture.projectId));
    expect(operation).toMatchObject({
      state: "failed",
      failureCode: "provider_rejected",
      reservedCalls: 0,
      spentCalls: 2,
      submittedAudioMs: 1_000,
      reservedCostMicrounits: 0n,
      spentCostMicrounits: 1_000n,
    });
    expect(bucket).toMatchObject({
      reservedCalls: 0,
      spentCalls: 2,
      reservedAudioMs: 0,
      spentAudioMs: 1_000,
      reservedCostMicrounits: 0n,
      spentCostMicrounits: 1_000n,
    });
    expect(await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId))).toEqual([
      expect.objectContaining({ durationSeconds: 9, segmentsJson: { marker: "unchanged" }, provider: "synthetic-existing" }),
    ]);
    expect(await db.select().from(outboxJobs).where(and(
      eq(outboxJobs.operationId, fixture.operationId),
      eq(outboxJobs.eventType, "notification.deliver"),
    ))).toHaveLength(0);
  });

  test("publication rejects an internally valid protected whitespace leaf in an otherwise complete partition", async () => {
    const fixture = await seedOperation(1_000);
    const boundaries = fixtureBoundaries(
      fixture,
      [success("first leaf"), success("dishonest trailing leaf")],
      [
        { speaker: "a", startSample: 0, endSample: 500 },
        { speaker: "b", startSample: 500, endSample: 1_000 },
      ],
    );
    for (let index = 0; index < 5; index++) {
      expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    }
    const whitespace = " \t\n ";
    const protectedWhitespace = Buffer.from(`sealed:${whitespace}`).toString("base64");
    const whitespaceHash = createHash("sha256").update(whitespace).digest("hex");
    await db.update(transcriptionChunks).set({
      checkpointCiphertext: protectedWhitespace,
      checkpointContentHash: whitespaceHash,
    }).where(and(
      eq(transcriptionChunks.operationId, fixture.operationId),
      eq(transcriptionChunks.startMs, 500),
      eq(transcriptionChunks.state, "succeeded"),
    ));

    expect((await oneStep(fixture, boundaries))?.result).toBe("terminal");
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    expect(meeting).toMatchObject({ status: "failed", transcriptRevision: 0, activeRecoveryOperationId: null });
    expect(operation).toMatchObject({ state: "failed", spentCalls: 2, submittedAudioMs: 1_000 });
    expect(boundaries.dispatches).toHaveLength(2);
    expect(await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId))).toHaveLength(0);
    expect(await db.select().from(outboxJobs).where(and(
      eq(outboxJobs.operationId, fixture.operationId),
      eq(outboxJobs.eventType, "notification.deliver"),
    ))).toHaveLength(0);
  });

  test("crash after durable dispatch marking but before the provider call becomes one spent unknown", async () => {
    const fixture = await seedOperation(250);
    const boundaries = fixtureBoundaries(fixture, [success("must-not-run")]);
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    await expect(oneStep(fixture, boundaries, {
      fault: (point) => { if (point === "after_dispatch_marked") throw new Error("synthetic pre-call crash"); },
    })).rejects.toThrow("synthetic pre-call crash");
    expect(boundaries.dispatches).toHaveLength(0);
    await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where operation_id = ${fixture.operationId} and state = 'leased'`;
    await reapExpiredOutboxJobs({ db, policy: DELIVERY, limit: 10 });
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
    expect((await drive(fixture, boundaries)).errorCode).toBe("provider_unavailable");
    expect(boundaries.dispatches).toHaveLength(0);
    expect((await ledgerTotals(fixture.operationId)).rows).toEqual([
      expect.objectContaining({ dispatchState: "spent", outcomeCode: "unknown", spentCostMicrounits: 250n }),
    ]);
  });

  test("valid, invalid, and over-cap Retry-After use database time and crossing the delayed threshold is truthful", async () => {
    const cases = [
      { name: "valid", retryAfterMs: 5_000, expectedMs: 5_000 },
      { name: "invalid", retryAfterMs: "5000", expectedMs: 1_000 },
      { name: "over-cap", retryAfterMs: 5_001, expectedMs: 1_000 },
    ] as const;
    const timingPolicy: DurableFinalizerPolicy = { ...POLICY, delayedThresholdMs: 2_000 };
    for (const item of cases) {
      const fixture = await seedOperation(100);
      const boundaries = fixtureBoundaries(fixture, [unavailable("http_429", item.retryAfterMs)]);
      expect((await oneStep(fixture, boundaries, { policy: timingPolicy }))?.result).toBe("continued");
      expect((await oneStep(fixture, boundaries, { policy: timingPolicy }))?.result).toBe("continued");
      expect((await oneStep(fixture, boundaries, { policy: timingPolicy }))?.result).toBe("continued");
      const [timing] = await isolated.sql<Array<{ delay_ms: number }>>`
        select extract(epoch from (c.next_eligible_at - l.completed_at)) * 1000 as delay_ms
        from transcription_chunks c join provider_call_ledger l on l.chunk_id = c.id
        where c.operation_id = ${fixture.operationId}
      `;
      expect(Number(timing!.delay_ms), item.name).toBeGreaterThan(item.expectedMs - 100);
      expect(Number(timing!.delay_ms), item.name).toBeLessThanOrEqual(item.expectedMs);
      const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
      const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
      expect(operation.phase, item.name).toBe("transcribing");
      expect(meeting.recoveryPhase, item.name).toBe("transcribing");
    }
  });

  test("a large timeout is spent, split exactly once, never retransmitted, and publishes one protected complete partition", async () => {
    const fixture = await seedOperation();
    const boundaries = fixtureBoundaries(fixture, [timeout(), success("left"), success("right")]);
    const meeting = await drive(fixture, boundaries);
    expect(meeting).toMatchObject({ status: "completed", transcriptRevision: 1, activeRecoveryOperationId: null });
    expect(boundaries.prepares()).toBe(1);
    expect(boundaries.dispatches.map((call) => call.audioMs)).toEqual([1_000, 500, 500]);
    expect(boundaries.dispatches.filter((call) => call.audioMs === 1_000)).toHaveLength(1);

    const chunks = await db.select().from(transcriptionChunks).where(eq(transcriptionChunks.operationId, fixture.operationId));
    expect(chunks.filter((chunk) => chunk.state === "split")).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.state === "succeeded").map((chunk) => [chunk.startMs, chunk.endMs]).sort()).toEqual([[0, 500], [500, 1_000]]);
    expect(JSON.stringify(chunks)).not.toContain("left");
    expect(JSON.stringify(chunks)).not.toContain("right");
    const totals = await ledgerTotals(fixture.operationId);
    expect({ calls: totals.calls, audioMs: totals.audioMs, cost: totals.cost }).toEqual({ calls: 3, audioMs: 2_000, cost: 2_000n });
    expect(totals.rows.map((row) => row.outcomeCode)).toEqual(["timeout", "success", "success"]);
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    expect(operation).toMatchObject({ reservedCalls: 0, spentCalls: 3, submittedAudioMs: 2_000, spentCostMicrounits: 2_000n });
    const [bucket] = await db.select().from(projectRecoveryBuckets).where(eq(projectRecoveryBuckets.projectId, fixture.projectId));
    expect(bucket).toMatchObject({ reservedCalls: 0, spentCalls: 3, reservedAudioMs: 0, spentAudioMs: 2_000 });
    expect(await db.select().from(outboxJobs).where(and(eq(outboxJobs.operationId, fixture.operationId), eq(outboxJobs.eventType, "notification.deliver")))).toHaveLength(1);
    expect(await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId))).toHaveLength(1);
  });

  test("a sibling checkpoint remains private while 429 retries once durably and a terminal 400 prevents partial publication", async () => {
    const fixture = await seedOperation(1_000);
    const boundaries = fixtureBoundaries(
      fixture,
      [success("private-sibling"), unavailable("http_429", 5_000), rejected("rejected")],
      [
        { speaker: "a", startSample: 0, endSample: 500 },
        { speaker: "b", startSample: 500, endSample: 1_000 },
      ],
    );
    const meeting = await drive(fixture, boundaries);
    expect(meeting).toMatchObject({ status: "failed", errorCode: "provider_rejected", transcriptRevision: 0 });
    expect(boundaries.dispatches.map((call) => call.attempt)).toEqual([1, 1, 2]);
    const chunks = await db.select().from(transcriptionChunks).where(eq(transcriptionChunks.operationId, fixture.operationId));
    expect(chunks.some((chunk) => chunk.state === "succeeded")).toBe(true);
    expect(chunks.some((chunk) => chunk.state === "failed")).toBe(true);
    expect(JSON.stringify(chunks)).not.toContain("private-sibling");
    expect(await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId))).toHaveLength(0);
    expect((await ledgerTotals(fixture.operationId)).calls).toBe(3);
  });

  test("restart after dispatch ambiguity spends unknown exactly once and never re-dispatches that reservation", async () => {
    const fixture = await seedOperation(400);
    const boundaries = fixtureBoundaries(fixture, [success("lost-response"), success("retry-result")]);
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued"); // plan
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued"); // reserve
    await expect(oneStep(fixture, boundaries, {
      fault: (point) => { if (point === "after_provider") throw new Error("synthetic crash after dispatch"); },
    })).rejects.toThrow("synthetic crash after dispatch");
    expect(boundaries.dispatches).toHaveLength(1);
    await isolated.sql`
      update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
      where operation_id = ${fixture.operationId} and state = 'leased'
    `;
    expect((await reapExpiredOutboxJobs({ db, policy: DELIVERY, limit: 10 })).requeued).toBe(1);
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
    const meeting = await drive(fixture, boundaries);
    expect(meeting).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
    expect(boundaries.dispatches).toHaveLength(1);
    const totals = await ledgerTotals(fixture.operationId);
    expect(totals.rows.map((row) => row.outcomeCode)).toEqual(["unknown"]);
    expect(totals.calls).toBe(1);
  });

  test("persisted checkpoint survives crash/restart and is published without another provider call", async () => {
    const fixture = await seedOperation(300);
    const boundaries = fixtureBoundaries(fixture, [success("checkpointed")]);
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    await expect(oneStep(fixture, boundaries, {
      fault: (point) => { if (point === "after_checkpoint") throw new Error("synthetic crash after checkpoint"); },
    })).rejects.toThrow("synthetic crash after checkpoint");
    expect(boundaries.dispatches).toHaveLength(1);
    await isolated.sql`
      update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
      where operation_id = ${fixture.operationId} and state = 'leased'
    `;
    await reapExpiredOutboxJobs({ db, policy: DELIVERY, limit: 10 });
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
    expect((await drive(fixture, boundaries)).status).toBe("completed");
    expect(boundaries.dispatches).toHaveLength(1);
    const [stored] = await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId));
    expect(JSON.stringify(stored?.segmentsJson)).toContain("checkpointed");
  });

  test("corrupt checkpoint, stale fence, unavailable protector, and deadline exhaustion fail closed with zero extra calls", async () => {
    const fixture = await seedOperation(300);
    const boundaries = fixtureBoundaries(fixture, [success("protected")]);
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    await isolated.sql`
      update transcription_chunks set checkpoint_content_hash = ${"0".repeat(64)}
      where operation_id = ${fixture.operationId} and state = 'succeeded'
    `;
    expect((await oneStep(fixture, boundaries))?.result).toBe("terminal");
    const [failed] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(failed).toMatchObject({ status: "failed", errorCode: "persistence_failed", transcriptRevision: 0 });
    expect(boundaries.dispatches).toHaveLength(1);

    const unavailableFixture = await seedOperation(300);
    const unavailableBoundaries = fixtureBoundaries(unavailableFixture, [success("must-not-dispatch")]);
    const unavailable = {
      ...unavailableBoundaries,
      protector: { ...unavailableBoundaries.protector, ready: false },
    };
    expect((await oneStep(unavailableFixture, unavailable))?.result).toBe("continued");
    expect((await oneStep(unavailableFixture, unavailable))?.result).toBe("continued");
    expect((await oneStep(unavailableFixture, unavailable))?.result).toBe("parked");
    expect(unavailable.dispatches).toHaveLength(0);
    const unavailableLedger = await ledgerTotals(unavailableFixture.operationId);
    expect(unavailableLedger.rows).toHaveLength(1);
    expect(unavailableLedger.rows[0]).toMatchObject({ dispatchState: "not_dispatched", outcomeCode: "not_dispatched", spentCostMicrounits: 0n });

    const deadlineFixture = await seedOperation(300);
    const deadlineBoundaries = fixtureBoundaries(deadlineFixture, [success("must-not-dispatch")]);
    await isolated.sql`update recovery_operations set deadline_at = clock_timestamp() - interval '1 millisecond' where id = ${deadlineFixture.operationId}`;
    expect((await oneStep(deadlineFixture, deadlineBoundaries))?.result).toBe("terminal");
    expect(deadlineBoundaries.dispatches).toHaveLength(0);
    const [deadlineMeeting] = await db.select().from(meetings).where(eq(meetings.id, deadlineFixture.meetingId));
    expect(deadlineMeeting.errorCode).toBe("operation_deadline_exceeded");
  });

  test("authorization trips the breaker and the offline adapter remains explicitly non-production", async () => {
    const first = await seedOperation(300);
    const boundaries = fixtureBoundaries(first, [rejected("authorization")]);
    const adapter = createOfflineDurableFinalizerDispatchAdapter({
      mode: "offline_contract_only",
      db,
      owner: `synthetic-b3-worker-${sequence}`,
      policy: POLICY,
      recording: boundaries.recording,
      provider: boundaries.provider,
      breaker: boundaries.breaker,
      protector: boundaries.protector,
      priceAttempt: ({ submittedAudioMs }) => BigInt(submittedAudioMs),
    });
    expect(adapter.mode).toBe("offline_contract_only");
    expect((await oneStep(first, boundaries))?.result).toBe("continued");
    expect((await oneStep(first, boundaries))?.result).toBe("continued");
    expect((await oneStep(first, boundaries))?.result).toBe("terminal");
    expect(boundaries.tripped()).toBe(true);
    expect(boundaries.dispatches).toHaveLength(1);

    const second = await seedOperation(300);
    const secondBoundaries = { ...fixtureBoundaries(second, [success("must-not-run")]), breaker: boundaries.breaker };
    expect((await oneStep(second, secondBoundaries))?.result).toBe("continued");
    expect((await oneStep(second, secondBoundaries))?.result).toBe("continued");
    expect((await oneStep(second, secondBoundaries))?.result).toBe("parked");
    expect(secondBoundaries.dispatches).toHaveLength(0);
  });

  test("the complete deterministic plan is durable before the first call and a stale fence cannot mutate or spend", async () => {
    const fixture = await seedOperation(1_000);
    const boundaries = fixtureBoundaries(
      fixture,
      [success("a"), success("b")],
      [
        { speaker: "a", startSample: 0, endSample: 400 },
        { speaker: "b", startSample: 400, endSample: 1_000 },
      ],
    );
    const planned = await oneStep(fixture, boundaries);
    expect(planned?.result).toBe("continued");
    expect(boundaries.dispatches).toHaveLength(0);
    const chunks = await db.select().from(transcriptionChunks)
      .where(eq(transcriptionChunks.operationId, fixture.operationId));
    expect(chunks.map((chunk) => [chunk.startMs, chunk.endMs]).sort()).toEqual([[0, 400], [400, 1_000]]);
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    expect(operation).toMatchObject({ sourceSampleRateHz: 1_000, sourceSampleCount: 1_000, plannedAudioMs: 1_000 });

    const owner = `synthetic-b3-worker-${sequence}`;
    const claim = (await claimOutboxJob({ db, owner, policy: DELIVERY }))!;
    const stale: OutboxClaim = { ...claim, fence: claim.fence + 1 };
    expect(await runDurableFinalizerStep({
      db,
      claim: stale,
      owner,
      policy: POLICY,
      recording: boundaries.recording,
      provider: boundaries.provider,
      breaker: boundaries.breaker,
      protector: boundaries.protector,
      priceAttempt: ({ submittedAudioMs }) => BigInt(submittedAudioMs),
    })).toBe("stale");
    expect(boundaries.dispatches).toHaveLength(0);
    expect((await ledgerTotals(fixture.operationId)).calls).toBe(0);
    await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${claim.id}`;
    await reapExpiredOutboxJobs({ db, policy: DELIVERY, limit: 10 });
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where id = ${claim.id}`;
    expect((await drive(fixture, boundaries)).status).toBe("completed");
  });

  test("all-timeout recursive splitting allows cap equality and rejects the next paid reservation", async () => {
    const fixture = await seedOperation(1_000);
    const boundaries = fixtureBoundaries(fixture, [timeout(), timeout("http_408"), timeout(), timeout()]);
    const exactCaps: DurableFinalizerPolicy = {
      ...POLICY,
      maxOperationCalls: 4,
      maxOperationAudioMs: 2_000,
      maxOperationCostMicrounits: 2_000n,
      splitFloorMs: 50,
    };
    let meeting;
    for (let index = 0; index < 30; index++) {
      [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
      if (meeting?.status === "failed") break;
      const step = await oneStep(fixture, boundaries, { policy: exactCaps });
      if (!step) await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
    }
    expect(meeting).toMatchObject({ status: "failed", errorCode: "budget_exhausted", transcriptRevision: 0 });
    expect(boundaries.dispatches.map((call) => call.audioMs)).toEqual([1_000, 500, 250, 125]);
    const totals = await ledgerTotals(fixture.operationId);
    expect({ calls: totals.calls, audioMs: totals.audioMs, cost: totals.cost }).toEqual({ calls: 4, audioMs: 1_875, cost: 1_875n });
    expect(totals.calls).toBeLessThanOrEqual(exactCaps.maxOperationCalls!);
    expect(totals.audioMs).toBeLessThanOrEqual(exactCaps.maxOperationAudioMs!);
    expect(await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId))).toHaveLength(0);
  });

  test.each(["transport_error", "http_5xx"] as const)("%s receives exactly one durable leaf retry across deliveries", async (code) => {
    const fixture = await seedOperation(150);
    const boundaries = fixtureBoundaries(fixture, [unavailable(code, 500), unavailable(code, 50_000)]);
    const meeting = await drive(fixture, boundaries);
    expect(meeting).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
    expect(boundaries.dispatches.map((call) => call.attempt)).toEqual([1, 2]);
    const [chunk] = await db.select().from(transcriptionChunks)
      .where(eq(transcriptionChunks.operationId, fixture.operationId));
    expect(chunk).toMatchObject({ retryCount: 1, state: "failed" });
    expect((await ledgerTotals(fixture.operationId)).calls).toBe(2);
  });

  test("crash after reservation resumes the same reservation; crash after publication cannot duplicate revision or notification", async () => {
    const fixture = await seedOperation(300);
    const boundaries = fixtureBoundaries(fixture, [success("once")]);
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    await expect(oneStep(fixture, boundaries, {
      fault: (point) => { if (point === "after_reservation") throw new Error("synthetic reservation crash"); },
    })).rejects.toThrow("synthetic reservation crash");
    expect(boundaries.dispatches).toHaveLength(0);
    expect((await ledgerTotals(fixture.operationId)).rows).toHaveLength(1);
    await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where operation_id = ${fixture.operationId} and state = 'leased'`;
    await reapExpiredOutboxJobs({ db, policy: DELIVERY, limit: 10 });
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect(boundaries.dispatches).toHaveLength(1);

    await expect(oneStep(fixture, boundaries, {
      fault: (point) => { if (point === "after_publication") throw new Error("synthetic publication acknowledgement crash"); },
    })).rejects.toThrow("synthetic publication acknowledgement crash");
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(meeting).toMatchObject({ status: "completed", transcriptRevision: 1 });
    expect(await claimOutboxJob({ db, owner: "synthetic-duplicate", policy: DELIVERY })).toBeNull();
    expect(await db.select().from(outboxJobs).where(and(
      eq(outboxJobs.operationId, fixture.operationId),
      eq(outboxJobs.eventType, "notification.deliver"),
    ))).toEqual([expect.objectContaining({ state: "pending" })]);
    expect(boundaries.dispatches).toHaveLength(1);
  });

  test("crash immediately after complete plan persistence reaps and reclaims without duplicate plan, reservation, or call", async () => {
    const fixture = await seedOperation(1_000);
    const boundaries = fixtureBoundaries(
      fixture,
      [success("first"), success("second")],
      [
        { speaker: "a", startSample: 0, endSample: 400 },
        { speaker: "b", startSample: 400, endSample: 1_000 },
      ],
    );
    const [before] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    const driftedPolicy = { ...POLICY, operationDeadlineMs: 120_000 };
    await expect(oneStep(fixture, boundaries, {
      policy: driftedPolicy,
      fault(point) { if (point === "after_plan") throw new Error("synthetic after-plan crash"); },
    })).rejects.toThrow("synthetic after-plan crash");
    expect(boundaries.dispatches).toHaveLength(0);
    const planned = await db.select().from(transcriptionChunks).where(eq(transcriptionChunks.operationId, fixture.operationId));
    expect(planned.map((chunk) => [chunk.startMs, chunk.endMs]).sort()).toEqual([[0, 400], [400, 1_000]]);
    const [afterPlan] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    expect(afterPlan.deadlineAt).toEqual(before.deadlineAt);

    await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where operation_id = ${fixture.operationId} and state = 'leased'`;
    expect(await reapExpiredOutboxJobs({ db, policy: DELIVERY, limit: 10 })).toMatchObject({ requeued: 1 });
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
    expect((await drive(fixture, boundaries)).status).toBe("completed");
    expect(boundaries.prepares()).toBe(1);
    expect(boundaries.dispatches).toHaveLength(2);
    expect(await db.select().from(transcriptionChunks).where(eq(transcriptionChunks.operationId, fixture.operationId))).toHaveLength(2);
    const ledger = await ledgerTotals(fixture.operationId);
    expect({ calls: ledger.calls, audioMs: ledger.audioMs, cost: ledger.cost }).toEqual({ calls: 2, audioMs: 1_000, cost: 1_000n });
  });

  test("crash immediately before publication exposes no partial result, then reaps into one atomic revision and notification", async () => {
    const fixture = await seedOperation(300);
    const boundaries = fixtureBoundaries(fixture, [success("publish exactly once")]);
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    await expect(oneStep(fixture, boundaries, {
      fault(point) { if (point === "before_publication") throw new Error("synthetic before-publication crash"); },
    })).rejects.toThrow("synthetic before-publication crash");
    let [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(meeting).toMatchObject({ status: "processing", transcriptRevision: 0 });
    expect(await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId))).toEqual([]);
    expect(await db.select().from(outboxJobs).where(and(
      eq(outboxJobs.operationId, fixture.operationId),
      eq(outboxJobs.eventType, "notification.deliver"),
    ))).toEqual([]);

    await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where operation_id = ${fixture.operationId} and state = 'leased'`;
    expect(await reapExpiredOutboxJobs({ db, policy: DELIVERY, limit: 10 })).toMatchObject({ requeued: 1 });
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
    expect((await drive(fixture, boundaries)).status).toBe("completed");
    [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(meeting).toMatchObject({ status: "completed", transcriptRevision: 1 });
    expect(await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId))).toHaveLength(1);
    expect(await db.select().from(outboxJobs).where(and(
      eq(outboxJobs.operationId, fixture.operationId),
      eq(outboxJobs.eventType, "notification.deliver"),
    ))).toEqual([expect.objectContaining({ state: "pending" })]);
    expect(boundaries.dispatches).toHaveLength(1);
  });

  test("a canonical 5xx survives post-schedule pre-ack loss with one successor, one retry, and exact counters", async () => {
    const fixture = await seedOperation(250);
    const boundaries = fixtureBoundaries(fixture, [unavailable("http_5xx", 1_000), success("retry success")]);
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    const owner = `synthetic-5xx-worker-${sequence}`;
    const handler = async (claim: OutboxClaim) => {
      const result = await runDurableFinalizerStep({
        db, claim, owner, policy: POLICY,
        recording: boundaries.recording, provider: boundaries.provider,
        breaker: boundaries.breaker, protector: boundaries.protector,
        priceAttempt: ({ submittedAudioMs }) => BigInt(submittedAudioMs),
      });
      return result === "continued" ? "continue" as const
        : result === "completed" || result === "terminal" ? "acknowledged" as const
          : result === "waiting" ? "already_waiting" as const
            : "stale" as const;
    };
    await expect(runOutboxDeliveryOnce({
      db, owner, policy: DELIVERY, repairEnabled: true, handler,
      fault(point) { if (point === "after_handler") throw new Error("synthetic scheduled-response loss"); },
    })).rejects.toThrow("synthetic scheduled-response loss");
    expect(boundaries.dispatches).toHaveLength(1);
    const [waiting] = await db.select().from(transcriptionChunks).where(and(
      eq(transcriptionChunks.operationId, fixture.operationId),
      eq(transcriptionChunks.state, "retry_scheduled"),
    ));
    expect(waiting).toMatchObject({ retryCount: 1 });

    await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where operation_id = ${fixture.operationId} and state = 'leased'`;
    expect(await reapExpiredOutboxJobs({ db, policy: DELIVERY, limit: 10 })).toMatchObject({ requeued: 1 });
    await isolated.sql`update transcription_chunks set next_eligible_at = clock_timestamp() where id = ${waiting!.id}`;
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
    expect((await drive(fixture, boundaries)).status).toBe("completed");
    expect(boundaries.dispatches.map((call) => call.attempt)).toEqual([1, 2]);
    const successors = await db.select().from(outboxJobs).where(and(
      eq(outboxJobs.operationId, fixture.operationId),
      eq(outboxJobs.chunkId, waiting!.id),
      eq(outboxJobs.eventType, "chunk.retry"),
    ));
    expect(successors).toHaveLength(1);
    const ledger = await ledgerTotals(fixture.operationId);
    expect(ledger.rows.map((row) => [row.attempt, row.outcomeCode, row.spentCostMicrounits]))
      .toEqual([[1, "http_5xx", 250n], [2, "success", 250n]]);
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    const [bucket] = await db.select().from(projectRecoveryBuckets).where(eq(projectRecoveryBuckets.projectId, fixture.projectId));
    expect(operation).toMatchObject({ reservedCalls: 0, spentCalls: 2, submittedAudioMs: 500, spentCostMicrounits: 500n });
    expect(bucket).toMatchObject({ reservedCalls: 0, spentCalls: 2, reservedAudioMs: 0, spentAudioMs: 500, spentCostMicrounits: 500n });
  });

  test("the former long-audio/deadline shape completes at explicit equality caps without partial completion", async () => {
    const fixture = await seedOperation(9_000);
    const boundaries = fixtureBoundaries(fixture, [success("first bounded chunk"), success("second bounded chunk")]);
    const exactCaps: DurableFinalizerPolicy = {
      ...POLICY,
      maxOperationCalls: 2,
      maxOperationAudioMs: 9_000,
      maxOperationCostMicrounits: 9_000n,
    };
    let meeting;
    for (let index = 0; index < 20; index++) {
      [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
      if (meeting?.status === "completed" || meeting?.status === "failed") break;
      await oneStep(fixture, boundaries, { policy: exactCaps });
    }
    expect(meeting).toMatchObject({ status: "completed", transcriptRevision: 1 });
    expect(boundaries.dispatches.map((call) => call.audioMs)).toEqual([5_000, 4_000]);
    const totals = await ledgerTotals(fixture.operationId);
    expect({ calls: totals.calls, audioMs: totals.audioMs, cost: totals.cost }).toEqual({ calls: 2, audioMs: 9_000, cost: 9_000n });
  });

  test.each(["gap", "overlap"] as const)("a %s in the authoritative leaf partition cannot publish", async (shape) => {
    const fixture = await seedOperation(1_000);
    const boundaries = fixtureBoundaries(
      fixture,
      [success("first"), success("second")],
      [
        { speaker: "a", startSample: 0, endSample: 500 },
        { speaker: "b", startSample: 500, endSample: 1_000 },
      ],
    );
    for (let index = 0; index < 5; index++) expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    const chunks = await db.select().from(transcriptionChunks)
      .where(eq(transcriptionChunks.operationId, fixture.operationId));
    const second = chunks.sort((a, b) => a.startMs - b.startMs)[1]!;
    await db.update(transcriptionChunks).set({ startMs: shape === "gap" ? 501 : 499 })
      .where(eq(transcriptionChunks.id, second.id));
    expect((await oneStep(fixture, boundaries))?.result).toBe("terminal");
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(meeting).toMatchObject({ status: "failed", errorCode: "coverage_incomplete", transcriptRevision: 0 });
    expect(await db.select().from(transcripts).where(eq(transcripts.meetingId, fixture.meetingId))).toHaveLength(0);
  });

  test("after-handler loss and an early successor preserve genuine future waiting without false delay or provider work", async () => {
    const fixture = await seedOperation(500);
    const boundaries = fixtureBoundaries(fixture, [unavailable("http_429", 40_000)]);
    const waitingPolicy: DurableFinalizerPolicy = {
      ...POLICY,
      retryBackoffMs: 40_000,
      maxRetryAfterMs: 50_000,
      delayedThresholdMs: 20_000,
      operationDeadlineMs: 60_000,
    };
    expect((await oneStep(fixture, boundaries, { policy: waitingPolicy }))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries, { policy: waitingPolicy }))?.result).toBe("continued");
    const owner = `synthetic-waiting-worker-${sequence}`;
    const handler = async (claim: OutboxClaim) => {
      const result = await runDurableFinalizerStep({
        db, claim, owner, policy: waitingPolicy,
        recording: boundaries.recording,
        provider: boundaries.provider,
        breaker: boundaries.breaker,
        protector: boundaries.protector,
        priceAttempt: ({ submittedAudioMs }) => BigInt(submittedAudioMs),
      });
      if (result === "continued") return "continue" as const;
      if (result === "completed" || result === "terminal") return "acknowledged" as const;
      if (result === "parked") return "already_parked" as const;
      return "stale" as const;
    };
    await expect(runOutboxDeliveryOnce({
      db, owner, policy: DELIVERY, repairEnabled: true, handler,
      fault(point) { if (point === "after_handler") throw new Error("synthetic after-handler loss"); },
    })).rejects.toThrow("synthetic after-handler loss");
    expect(boundaries.dispatches).toHaveLength(1);
    let [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    let [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(operation).toMatchObject({ state: "active", phase: "transcribing", spentCalls: 1, reservedCalls: 0 });
    expect(meeting).toMatchObject({ status: "processing", recoveryPhase: "transcribing" });
    const [waitingChunk] = await db.select().from(transcriptionChunks)
      .where(and(eq(transcriptionChunks.operationId, fixture.operationId), eq(transcriptionChunks.state, "retry_scheduled")));
    expect(waitingChunk?.nextEligibleAt).not.toBeNull();
    const thresholdJobs = await db.select().from(outboxJobs).where(and(
      eq(outboxJobs.operationId, fixture.operationId),
      eq(outboxJobs.eventType, "operation.resume"),
      eq(outboxJobs.state, "pending"),
    ));
    expect(thresholdJobs.some((job) => operation!.delayedAt && job.availableAt.getTime() === operation!.delayedAt.getTime())).toBe(true);

    await isolated.sql`
      update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
      where operation_id = ${fixture.operationId} and state = 'leased'
    `;
    await reapExpiredOutboxJobs({ db, policy: { ...DELIVERY, retryDelayMs: 1 }, limit: 10 });
    await isolated.sql`
      update outbox_jobs set available_at = clock_timestamp()
      where operation_id = ${fixture.operationId} and state = 'pending' and event_type = 'operation.resume'
        and available_at < ${operation!.delayedAt!}
    `;
    expect((await runOutboxDeliveryOnce({ db, owner, policy: DELIVERY, repairEnabled: true, handler })).outcome).toBe("delivered");
    expect(boundaries.dispatches).toHaveLength(1);
    expect(await db.select().from(outboxJobs).where(and(
      eq(outboxJobs.operationId, fixture.operationId),
      eq(outboxJobs.chunkId, waitingChunk!.id),
      eq(outboxJobs.eventType, "chunk.retry"),
      eq(outboxJobs.state, "pending"),
    ))).toHaveLength(1);

    await isolated.sql`
      update outbox_jobs set available_at = clock_timestamp()
      where operation_id = ${fixture.operationId} and chunk_id = ${waitingChunk!.id} and event_type = 'chunk.retry' and state = 'pending'
    `;
    const earlyClaim = (await claimOutboxJob({ db, owner, policy: DELIVERY }))!;
    await runDurableFinalizerStep({
      db, claim: earlyClaim, owner, policy: waitingPolicy,
      recording: boundaries.recording, provider: boundaries.provider,
      breaker: boundaries.breaker, protector: boundaries.protector,
      priceAttempt: ({ submittedAudioMs }) => BigInt(submittedAudioMs),
    });
    const [deferred] = await db.select().from(outboxJobs).where(eq(outboxJobs.id, earlyClaim.id));
    expect(deferred).toMatchObject({ state: "pending", leaseOwnerHash: null, leaseExpiresAt: null });
    expect(deferred!.availableAt.getTime()).toBe(waitingChunk!.nextEligibleAt!.getTime());
    expect(boundaries.dispatches).toHaveLength(1);

    await isolated.sql`
      update recovery_operations set delayed_at = clock_timestamp() - interval '1 millisecond'
      where id = ${fixture.operationId}
    `;
    await isolated.sql`
      update outbox_jobs set available_at = clock_timestamp()
      where operation_id = ${fixture.operationId} and event_type = 'operation.resume' and state = 'pending'
    `;
    const thresholdClaim = (await claimOutboxJob({ db, owner, policy: DELIVERY }))!;
    const thresholdResult = await runDurableFinalizerStep({
      db, claim: thresholdClaim, owner, policy: waitingPolicy,
      recording: boundaries.recording, provider: boundaries.provider,
      breaker: boundaries.breaker, protector: boundaries.protector,
      priceAttempt: ({ submittedAudioMs }) => BigInt(submittedAudioMs),
    });
    if (thresholdResult === "continued") {
      expect(await continueOutboxJob({ db, jobId: thresholdClaim.id, owner, fence: thresholdClaim.fence })).toBe(true);
    }
    [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(operation).toMatchObject({ state: "delayed", phase: "delayed", spentCalls: 1 });
    expect(meeting).toMatchObject({ status: "processing", recoveryPhase: "delayed" });
    expect(boundaries.dispatches).toHaveLength(1);

    await isolated.sql`
      update recovery_operations set deadline_at = clock_timestamp() - interval '1 millisecond'
      where id = ${fixture.operationId}
    `;
    await isolated.sql`
      update outbox_jobs set available_at = clock_timestamp()
      where operation_id = ${fixture.operationId} and state = 'pending'
    `;
    const deadlineClaim = (await claimOutboxJob({ db, owner, policy: DELIVERY }))!;
    expect((await runDurableFinalizerStep({
      db, claim: deadlineClaim, owner, policy: waitingPolicy,
      recording: boundaries.recording, provider: boundaries.provider,
      breaker: boundaries.breaker, protector: boundaries.protector,
      priceAttempt: ({ submittedAudioMs }) => BigInt(submittedAudioMs),
    }))).toBe("terminal");
    [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(meeting).toMatchObject({ status: "failed", errorCode: "operation_deadline_exceeded" });
    expect(boundaries.dispatches).toHaveLength(1);
  });

  test("concurrency deferral is one zero-call step and keeps its fenced reservation", async () => {
    const fixture = await seedOperation(400);
    const boundaries = fixtureBoundaries(fixture, [success("unused")]);
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    const [reserved] = await db.select().from(providerCallLedger)
      .where(eq(providerCallLedger.operationId, fixture.operationId));
    const blockerChunkId = `chk_b3_blocker_${sequence}`;
    const blockerLedgerId = `led_b3_blocker_${sequence}`;
    await isolated.sql`
      insert into transcription_chunks (
        id, operation_id, ordinal, version, start_ms, end_ms, speaker_ref_hash,
        provenance, state, attempt, retry_count, lease_fence
      ) values (
        ${blockerChunkId}, ${fixture.operationId}, 99, 1, 0, 1, ${"c".repeat(64)},
        'provider', 'split', 1, 0, 1
      )
    `;
    await isolated.sql`
      insert into provider_call_ledger (
        id, project_id, operation_id, chunk_id, reservation_key_hash, kind,
        submitted_audio_ms, submitted_bytes, reserved_cost_microunits,
        spent_cost_microunits, attempt, dispatch_state, lease_fence,
        budget_bucket_minute, dispatching_at
      ) values (
        ${blockerLedgerId}, ${fixture.projectId}, ${fixture.operationId}, ${blockerChunkId},
        ${(sequence + 30_000).toString(16).padStart(64, "0")}, 'manual', 1, 46, 0, 0, 1,
        'dispatching', 1, ${reserved!.budgetBucketMinute}, clock_timestamp()
      )
    `;
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect(boundaries.dispatches).toHaveLength(0);
    const [stillReserved] = await db.select().from(providerCallLedger).where(eq(providerCallLedger.id, reserved!.id));
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(stillReserved).toMatchObject({ dispatchState: "reserved", outcomeCode: null, spentCostMicrounits: 0n });
    expect(operation).toMatchObject({ state: "active", phase: "transcribing", reservedCalls: 1, spentCalls: 0 });
    expect(meeting).toMatchObject({ status: "processing", recoveryPhase: "transcribing" });
  });

  test("concurrency backoff is clamped to the accepted deadline, then refunds the un-dispatched reservation exactly once", async () => {
    const fixture = await seedOperation(400);
    const boundaries = fixtureBoundaries(fixture, [success("must not run")]);
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    expect((await oneStep(fixture, boundaries))?.result).toBe("continued");
    const [reserved] = await db.select().from(providerCallLedger)
      .where(eq(providerCallLedger.operationId, fixture.operationId));
    const blockerMeetingId = `mtg_b3_blocker_${sequence}`;
    const blockerOperationId = `rcv_b3_blocker_${sequence}`;
    const blockerChunkId = `chk_b3_cross_deadline_${sequence}`;
    const blockerLedgerId = `led_b3_cross_deadline_${sequence}`;
    await isolated.sql`
      insert into meetings (
        id, project_id, meeting_url, platform, status, metadata, budget_provenance,
        manual_recovery_cycles_consumed, recovery_phase
      ) values (
        ${blockerMeetingId}, ${fixture.projectId}, 'https://synthetic.invalid/blocker', 'jitsi',
        'processing', '{}', 'tracked', 1, 'transcribing'
      )
    `;
    await isolated.sql`
      insert into recovery_operations (
        id, project_id, meeting_id, idempotency_key_hash, kind, state, phase, ordinal,
        reserved_calls, reserved_cost_microunits, correlation_id, actor_class, reason_code,
        accepted_at, deadline_at
      ) values (
        ${blockerOperationId}, ${fixture.projectId}, ${blockerMeetingId}, ${(sequence + 40_000).toString(16).padStart(64, "0")},
        'manual', 'active', 'transcribing', 1, 1, 1, 'synthetic-blocker', 'system', 'user_requested',
        clock_timestamp(), clock_timestamp() + interval '1 hour'
      )
    `;
    await isolated.sql`update meetings set active_recovery_operation_id = ${blockerOperationId} where id = ${blockerMeetingId}`;
    await isolated.sql`
      insert into transcription_chunks (
        id, operation_id, ordinal, version, start_ms, end_ms, speaker_ref_hash,
        provenance, state, attempt, retry_count, lease_fence
      ) values (
        ${blockerChunkId}, ${blockerOperationId}, 0, 1, 0, 1, ${"d".repeat(64)},
        'provider', 'dispatching', 1, 0, 1
      )
    `;
    await isolated.sql`
      insert into provider_call_ledger (
        id, project_id, operation_id, chunk_id, reservation_key_hash, kind,
        submitted_audio_ms, submitted_bytes, reserved_cost_microunits,
        spent_cost_microunits, attempt, dispatch_state, lease_fence,
        budget_bucket_minute, dispatching_at
      ) values (
        ${blockerLedgerId}, ${fixture.projectId}, ${blockerOperationId}, ${blockerChunkId},
        ${(sequence + 50_000).toString(16).padStart(64, "0")}, 'manual', 1, 46, 1, 0, 1,
        'dispatching', 1, ${reserved!.budgetBucketMinute}, clock_timestamp()
      )
    `;
    await db.update(transcriptionChunks).set({ providerCallLedgerId: blockerLedgerId }).where(eq(transcriptionChunks.id, blockerChunkId));
    await db.update(projectRecoveryBuckets).set({
      reservedCalls: sql`${projectRecoveryBuckets.reservedCalls} + 1`,
      reservedAudioMs: sql`${projectRecoveryBuckets.reservedAudioMs} + 1`,
      reservedCostMicrounits: sql`${projectRecoveryBuckets.reservedCostMicrounits} + 1`,
    }).where(eq(projectRecoveryBuckets.projectId, fixture.projectId));

    const crossingPolicy = { ...POLICY, retryBackoffMs: 10_000 };
    await isolated.sql`update recovery_operations set deadline_at = clock_timestamp() + interval '1 second' where id = ${fixture.operationId}`;
    expect((await oneStep(fixture, boundaries, { policy: crossingPolicy }))?.result).toBe("continued");
    expect(boundaries.dispatches).toHaveLength(0);
    const [operationBeforeDeadline] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    const deadlineWake = await db.select().from(outboxJobs).where(and(
      eq(outboxJobs.operationId, fixture.operationId),
      eq(outboxJobs.state, "pending"),
    ));
    expect(deadlineWake.some((job) => job.availableAt.getTime() <= operationBeforeDeadline!.deadlineAt!.getTime())).toBe(true);

    await isolated.sql`update recovery_operations set deadline_at = clock_timestamp() - interval '1 millisecond' where id = ${fixture.operationId}`;
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where operation_id = ${fixture.operationId} and state = 'pending'`;
    const terminalStep = await oneStep(fixture, boundaries, { policy: crossingPolicy });
    expect(terminalStep?.result).toBe("terminal");
    expect(boundaries.dispatches).toHaveLength(0);
    const [targetLedger] = await db.select().from(providerCallLedger).where(eq(providerCallLedger.id, reserved!.id));
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    const [bucket] = await db.select().from(projectRecoveryBuckets).where(eq(projectRecoveryBuckets.projectId, fixture.projectId));
    expect(targetLedger).toMatchObject({ dispatchState: "not_dispatched", outcomeCode: "not_dispatched", spentCostMicrounits: 0n });
    expect(operation).toMatchObject({ state: "failed", failureCode: "operation_deadline_exceeded", reservedCalls: 0, spentCalls: 0, reservedCostMicrounits: 0n, spentCostMicrounits: 0n });
    expect(meeting).toMatchObject({ status: "failed", errorCode: "operation_deadline_exceeded", activeRecoveryOperationId: null });
    expect(bucket).toMatchObject({ reservedCalls: 1, spentCalls: 0, reservedAudioMs: 1, spentAudioMs: 0, reservedCostMicrounits: 1n, spentCostMicrounits: 0n });
  });
});
