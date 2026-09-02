import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDb } from "../../src/db/client.ts";
import type { AppContext } from "../../src/context.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import {
  meetings,
  outboxJobs,
  projectRecoveryBuckets,
  providerCallLedger,
  recoveryOperations,
  transcriptionChunks,
} from "../../src/db/schema.ts";
import {
  acknowledgeOutboxJob,
  claimOutboxJob,
  heartbeatOutboxJob,
  outboxQueueHealth,
  parkOutboxJob,
  reapExpiredOutboxJobs,
  repairOutboxJobs,
  retryOutboxJob,
  type DurableDeliveryPolicy,
} from "../../src/worker/outbox.ts";
import {
  runProductionRecoveryDeliveryOnce,
  startProductionRecoveryRuntime,
  type RecoveryDispatchAdapter,
} from "../../src/worker/recovery-runtime.ts";
import type {
  RecoveryOperationalReadiness,
  RecoveryOperationalReadinessSource,
} from "../../src/services/recovery-readiness.ts";
import { startWorker } from "../../src/worker/index.ts";
import { createIsolatedDatabase, type IsolatedDatabase } from "./a2-db.ts";

const POLICY: DurableDeliveryPolicy = {
  leaseMs: 60_000,
  maxAttempts: 3,
  maxAgeMs: 3_600_000,
  retryDelayMs: 1_000,
  idleMs: 1_000,
};

const PRODUCTION_ENVIRONMENT = {
  RECOVERY_V2_ENABLED: "true",
  RECOVERY_PROVIDER_ENABLED: "true",
  RECOVERY_FINALIZER_ENABLED: "true",
  RECOVERY_A3_BUDGET_CONFIG_READY: "true",
  RECOVERY_B_PROVIDER_CONFIG_READY: "true",
  RECOVERY_B_FINALIZER_CONFIG_READY: "true",
  RECOVERY_DELIVERY_LEASE_MS: "60000",
  RECOVERY_DELIVERY_MAX_ATTEMPTS: "3",
  RECOVERY_DELIVERY_MAX_AGE_MS: "3600000",
  RECOVERY_DELIVERY_RETRY_DELAY_MS: "1000",
  RECOVERY_DELIVERY_IDLE_MS: "1000",
};

const MAINTENANCE_ONLY_ENVIRONMENT = {
  ...PRODUCTION_ENVIRONMENT,
  RECOVERY_V2_ENABLED: "false",
  RECOVERY_PROVIDER_ENABLED: "false",
  RECOVERY_FINALIZER_ENABLED: "false",
};

const READY: RecoveryOperationalReadiness = {
  recoveryAcceptanceEnabled: true,
  maintenanceConfigured: true,
  providerEnabled: true,
  finalizerEnabled: true,
  dispatchAdapterReady: true,
  providerAdapterReady: true,
  a3BudgetConfigReady: true,
  bProviderConfigReady: true,
  bFinalizerConfigReady: true,
  apiBuildRevision: "api-synthetic-a4",
  workerBuildRevision: "worker-synthetic-a4",
  apiContractVersion: "recovery-v2",
  workerContractVersion: "recovery-v2",
  finalizerVersion: "finalizer-v2",
  schemaVersion: "0003",
  configVersion: "config-synthetic-a4",
};

let isolated: IsolatedDatabase;
let db: ReturnType<typeof createDb>;
let sequence = 0;

setDefaultTimeout(30_000);

async function seedAcceptedJob(overrides: { attempt?: number; createdOffset?: string } = {}) {
  sequence += 1;
  const projectId = `prj_a4_${sequence}`;
  const meetingId = `mtg_a4_${sequence}`;
  const operationId = `rcv_a4_${sequence}`;
  const jobId = `obx_a4_${sequence}`;
  await isolated.sql`insert into projects (id, name, webhook_secret) values (${projectId}, 'synthetic', 'opaque')`;
  await isolated.sql`
    insert into meetings (
      id, project_id, meeting_url, platform, status, metadata, budget_provenance,
      manual_recovery_cycles_consumed, recovery_phase
    ) values (${meetingId}, ${projectId}, 'https://synthetic.invalid/opaque', 'jitsi', 'processing', '{}', 'tracked', 1, 'queued')
  `;
  await isolated.sql`
    insert into recovery_operations (
      id, project_id, meeting_id, idempotency_key_hash, kind, state, phase, ordinal,
      correlation_id, actor_class, reason_code, accepted_at, deadline_at
    ) values (
      ${operationId}, ${projectId}, ${meetingId}, ${"a".repeat(64)}, 'manual', 'accepted', 'queued', 1,
      'synthetic-correlation', 'user', 'user_requested', clock_timestamp(), clock_timestamp() + interval '1 hour'
    )
  `;
  await isolated.sql`update meetings set active_recovery_operation_id = ${operationId} where id = ${meetingId}`;
  await isolated.sql`
    insert into project_recovery_buckets (project_id, bucket_minute, manual_cycles)
    values (${projectId}, date_trunc('minute', clock_timestamp()), 1)
  `;
  await isolated.sql`
    insert into outbox_jobs (
      id, project_id, operation_id, event_type, dedupe_key_hash, state, attempt, created_at, updated_at
    ) values (
      ${jobId}, ${projectId}, ${operationId}, 'operation.accepted', ${sequence.toString(16).padStart(64, "0")},
      'pending', ${overrides.attempt ?? 0}, clock_timestamp() + ${overrides.createdOffset ?? "0 seconds"}::interval,
      clock_timestamp()
    )
  `;
  return { projectId, meetingId, operationId, jobId };
}

async function complete(fixture: Awaited<ReturnType<typeof seedAcceptedJob>>) {
  await db.transaction(async (tx) => {
    await tx.update(recoveryOperations).set({
      state: "completed",
      phase: "completed",
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    }).where(eq(recoveryOperations.id, fixture.operationId));
    await tx.update(meetings).set({
      status: "completed",
      recoveryPhase: "completed",
      lastRecoveryOutcome: "completed",
      activeRecoveryOperationId: null,
    }).where(eq(meetings.id, fixture.meetingId));
  });
}

async function seedSiblingJob(fixture: Awaited<ReturnType<typeof seedAcceptedJob>>, suffix: string) {
  const jobId = `${fixture.jobId}_${suffix}`;
  await isolated.sql`
    insert into outbox_jobs (
      id, project_id, operation_id, event_type, dedupe_key_hash, state, created_at, updated_at
    ) values (
      ${jobId}, ${fixture.projectId}, ${fixture.operationId}, 'operation.resume',
      ${(sequence + suffix.length + 100_000).toString(16).padStart(64, "0")}, 'pending', clock_timestamp(), clock_timestamp()
    )
  `;
  return jobId;
}

async function state(jobId: string) {
  const [job] = await db.select().from(outboxJobs).where(eq(outboxJobs.id, jobId));
  return job!;
}

async function economicCounts(projectId: string) {
  const [row] = await isolated.sql<{ cycles: number; ledger: number }[]>`
    select
      coalesce((select sum(manual_cycles)::int from project_recovery_buckets where project_id = ${projectId}), 0) cycles,
      (select count(*)::int from provider_call_ledger where project_id = ${projectId}) ledger
  `;
  return row!;
}

async function attachProviderReservation(
  fixture: Awaited<ReturnType<typeof seedAcceptedJob>>,
  dispatchState: "reserved" | "dispatching",
) {
  const chunkId = `chk_a4_${sequence}_${dispatchState}`;
  const ledgerId = `led_a4_${sequence}_${dispatchState}`;
  const [bucket] = await db.select().from(projectRecoveryBuckets)
    .where(eq(projectRecoveryBuckets.projectId, fixture.projectId));
  await isolated.sql`
    insert into transcription_chunks (
      id, operation_id, ordinal, version, start_ms, end_ms, speaker_ref_hash,
      provenance, state, attempt, retry_count, lease_fence
    ) values (
      ${chunkId}, ${fixture.operationId}, 0, 1, 0, 1000, ${"b".repeat(64)},
      'provider', ${dispatchState}, 1, 0, 1
    )
  `;
  await isolated.sql`
    insert into provider_call_ledger (
      id, project_id, operation_id, chunk_id, reservation_key_hash, kind,
      submitted_audio_ms, submitted_bytes, reserved_cost_microunits,
      spent_cost_microunits, attempt, dispatch_state, lease_fence,
      budget_bucket_minute
    ) values (
      ${ledgerId}, ${fixture.projectId}, ${fixture.operationId}, ${chunkId},
      ${(sequence + (dispatchState === "dispatching" ? 10_000 : 20_000)).toString(16).padStart(64, "0")},
      'manual', 1000, 2044, 1000, 0, 1, ${dispatchState}, 1,
      ${bucket!.bucketMinute}
    )
  `;
  if (dispatchState === "dispatching") {
    await isolated.sql`update provider_call_ledger set dispatching_at = clock_timestamp() where id = ${ledgerId}`;
  }
  await db.update(transcriptionChunks).set({ providerCallLedgerId: ledgerId })
    .where(eq(transcriptionChunks.id, chunkId));
  await db.update(projectRecoveryBuckets).set({
    reservedCalls: sql`${projectRecoveryBuckets.reservedCalls} + 1`,
    reservedAudioMs: sql`${projectRecoveryBuckets.reservedAudioMs} + 1000`,
    reservedCostMicrounits: sql`${projectRecoveryBuckets.reservedCostMicrounits} + 1000`,
  }).where(eq(projectRecoveryBuckets.projectId, fixture.projectId));
  await db.update(recoveryOperations).set({ reservedCalls: 1, reservedCostMicrounits: 1000n })
    .where(eq(recoveryOperations.id, fixture.operationId));
  return { chunkId, ledgerId };
}

beforeEach(async () => {
  isolated = await createIsolatedDatabase("ptx_a4_delivery");
  const migrationDb = await runMigrations(isolated.url);
  await migrationDb.$client.close();
  db = createDb(isolated.url);
});

afterEach(async () => {
  await db?.$client.close();
  await isolated?.drop();
});

describe("A4 database outbox delivery authority", () => {
  test("one production tick re-reads readiness, repairs at database now, claims with a new fence, and invokes a typed adapter", async () => {
    const fixture = await seedAcceptedJob();
    const siblingId = await seedSiblingJob(fixture, "parked_sibling");
    const readiness: RecoveryOperationalReadiness = {
      ...READY,
      dispatchAdapterReady: false,
      providerAdapterReady: false,
    };
    let reads = 0;
    const readinessSource: RecoveryOperationalReadinessSource = {
      read: () => { reads += 1; return { ...readiness }; },
    };
    let invocations = 0;
    const adapter: RecoveryDispatchAdapter = {
      async dispatch(claim) {
        invocations += 1;
        const [job] = await db.select().from(outboxJobs).where(eq(outboxJobs.id, claim.id));
        const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, claim.operationId));
        expect(job).toMatchObject({ state: "leased", leaseFence: claim.fence, attempt: 2 });
        expect(operation).toMatchObject({ state: "active", workerLeaseFence: claim.fence });
      },
    };
    expect(await runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-dynamic-off",
      environment: PRODUCTION_ENVIRONMENT,
      readinessSource,
      dispatchAdapter: adapter,
    })).toEqual({ outcome: "parked", jobId: fixture.jobId });
    expect(invocations).toBe(0);
    expect(await state(fixture.jobId)).toMatchObject({ state: "failed", lastErrorCode: "disabled", attempt: 1 });
    expect(await state(siblingId)).toMatchObject({ state: "cancelled" });

    readiness.dispatchAdapterReady = true;
    readiness.providerAdapterReady = true;
    expect(await runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-dynamic-on",
      environment: PRODUCTION_ENVIRONMENT,
      readinessSource,
      dispatchAdapter: adapter,
    })).toEqual({ outcome: "delivered", jobId: fixture.jobId });
    expect(reads).toBe(2);
    expect(invocations).toBe(1);
    expect(await state(fixture.jobId)).toMatchObject({ state: "delivered", attempt: 2, leaseFence: 2 });
    expect(await state(siblingId)).toMatchObject({ state: "cancelled" });
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(operation).toMatchObject({ state: "completed", phase: "completed" });
    expect(meeting).toMatchObject({ status: "completed", activeRecoveryOperationId: null, recoveryPhase: "completed" });
  });

  test("repair is a table-driven terminal-monotonic state machine", async () => {
    for (const operationState of ["completed", "failed", "cancelled"] as const) {
      const fixture = await seedAcceptedJob();
      const siblingId = await seedSiblingJob(fixture, `terminal_${operationState}`);
      await isolated.sql`
        update recovery_operations
        set state = ${operationState}, phase = ${operationState === "cancelled" ? "failed" : operationState},
            failure_code = case when ${operationState} = 'cancelled' then 'cancelled' else failure_code end,
            completed_at = case when ${operationState} = 'completed' then clock_timestamp() else completed_at end
        where id = ${fixture.operationId}
      `;
      await isolated.sql`
        update outbox_jobs set state = 'failed', last_error_code = 'disabled', available_at = clock_timestamp() + interval '1 hour'
        where id = ${fixture.jobId}
      `;
      expect(await repairOutboxJobs({ db, policy: POLICY, limit: 10 })).toMatchObject({
        requeued: 0,
        delivered: 0,
      });
      expect(await state(fixture.jobId)).toMatchObject({ state: "cancelled" });
      expect(await state(siblingId)).toMatchObject({ state: "cancelled" });
      const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
      expect(operation?.state).toBe(operationState);
    }
  });
  test("concurrent workers claim a due job once and fences increase monotonically after expiry", async () => {
    const fixture = await seedAcceptedJob();
    const [a, b] = await Promise.all([
      claimOutboxJob({ db, owner: "synthetic-worker-a", policy: POLICY }),
      claimOutboxJob({ db, owner: "synthetic-worker-b", policy: POLICY }),
    ]);
    const first = a ?? b;
    expect(first).not.toBeNull();
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(first!.fence).toBe(1);

    await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${fixture.jobId}`;
    expect(await reapExpiredOutboxJobs({ db, policy: POLICY, limit: 10 })).toEqual({ requeued: 1, parked: 0, terminal: 0, delivered: 0 });
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where id = ${fixture.jobId}`;
    const second = await claimOutboxJob({ db, owner: "synthetic-worker-c", policy: POLICY });
    expect(second).toMatchObject({ id: fixture.jobId, fence: 2, attempt: 2 });
  });

  test("operation fencing serializes sibling jobs and remains authoritative across job-local fences", async () => {
    const fixture = await seedAcceptedJob();
    const siblingId = await seedSiblingJob(fixture, "b");
    const first = (await claimOutboxJob({ db, owner: "synthetic-sibling-a", policy: POLICY }))!;
    expect(first.operationId).toBe(fixture.operationId);
    expect(first.fence).toBe(1);
    expect(await claimOutboxJob({ db, owner: "synthetic-sibling-b", policy: POLICY })).toBeNull();

    await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${first.id}`;
    await reapExpiredOutboxJobs({ db, policy: POLICY, limit: 1 });
    await isolated.sql`update outbox_jobs set state = 'delivered' where id = ${first.id}`;
    const sibling = (await claimOutboxJob({ db, owner: "synthetic-sibling-c", policy: POLICY }))!;
    expect(sibling).toMatchObject({ id: siblingId, fence: 2 });
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    expect(operation).toMatchObject({ workerLeaseFence: 2, state: "active" });
  });

  test("a terminal operation makes every sibling job non-claimable", async () => {
    const fixture = await seedAcceptedJob();
    const siblingId = await seedSiblingJob(fixture, "terminal");
    await isolated.sql`update recovery_operations set state = 'failed', phase = 'failed', failure_code = 'persistence_failed' where id = ${fixture.operationId}`;
    expect(await claimOutboxJob({ db, owner: "synthetic-terminal", policy: POLICY })).toBeNull();
    expect(await state(fixture.jobId)).toMatchObject({ state: "cancelled" });
    expect(await state(siblingId)).toMatchObject({ state: "cancelled" });
  });

  test("detached or terminal meetings never reach the production dispatch adapter", async () => {
    let invocations = 0;
    const adapter: RecoveryDispatchAdapter = {
      async dispatch() { invocations += 1; },
    };
    for (const [status, linked] of [
      ["processing", false],
      ["completed", false],
      ["failed", false],
      ["cancelled", false],
    ] as const) {
      const fixture = await seedAcceptedJob();
      await isolated.sql`
        update meetings
        set status = ${status}, active_recovery_operation_id = ${linked ? fixture.operationId : null}
        where id = ${fixture.meetingId}
      `;
      expect(await runProductionRecoveryDeliveryOnce({
        db,
        owner: `synthetic-owner-${status}`,
        environment: PRODUCTION_ENVIRONMENT,
        readinessSource: { read: () => ({ ...READY }) },
        dispatchAdapter: adapter,
      })).toEqual({ outcome: "idle" });
      expect(await state(fixture.jobId)).toMatchObject({ state: "cancelled", attempt: 0 });
    }
    expect(invocations).toBe(0);
  });

  test("crash before handler dispatch leaves a lease that the reaper makes claimable", async () => {
    const fixture = await seedAcceptedJob();
    await expect(runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-crash-before",
      environment: PRODUCTION_ENVIRONMENT,
      fault: (point) => { if (point === "before_handler") throw new Error("synthetic crash"); },
    })).rejects.toThrow("synthetic crash");
    expect(await state(fixture.jobId)).toMatchObject({ state: "leased", attempt: 1 });
    await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${fixture.jobId}`;
    await reapExpiredOutboxJobs({ db, policy: POLICY, limit: 1 });
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where id = ${fixture.jobId}`;
    expect(await state(fixture.jobId)).toMatchObject({ state: "pending", lastErrorCode: "lease_expired" });
  });

  test("the production A4 handler is invoked and atomically parks before provider dispatch", async () => {
    const fixture = await seedAcceptedJob();
    const input = new Proxy({
      db,
      owner: "synthetic-production-park",
      environment: PRODUCTION_ENVIRONMENT,
      fault: undefined,
    }, {
      get(target, property, receiver) {
        if (!(property in target)) throw new Error(`forbidden Redis/provider dependency access: ${String(property)}`);
        return Reflect.get(target, property, receiver);
      },
    });
    expect(await runProductionRecoveryDeliveryOnce(input)).toEqual({ outcome: "parked", jobId: fixture.jobId });
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(await state(fixture.jobId)).toMatchObject({ state: "failed", lastErrorCode: "disabled", attempt: 1 });
    expect(operation).toMatchObject({
      state: "delayed",
      phase: "disabled",
      workerLeaseFence: 1,
      workerLeaseOwnerHash: null,
      workerLeaseExpiresAt: null,
    });
    expect(meeting).toMatchObject({ status: "processing", recoveryPhase: "disabled", activeRecoveryOperationId: fixture.operationId });
    expect(await economicCounts(fixture.projectId)).toEqual({ cycles: 1, ledger: 0 });
  });

  test("the production dark pre-plan park reaches the accepted deadline and fails without provider work", async () => {
    const fixture = await seedAcceptedJob();
    await isolated.sql`
      update recovery_operations
      set deadline_at = clock_timestamp() - interval '1 millisecond'
      where id = ${fixture.operationId}
    `;
    expect(await runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-dark-deadline-park",
      environment: MAINTENANCE_ONLY_ENVIRONMENT,
    })).toEqual({ outcome: "parked", jobId: fixture.jobId });
    expect(await runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-dark-deadline-maintenance",
      environment: MAINTENANCE_ONLY_ENVIRONMENT,
    })).toEqual({ outcome: "terminal", jobId: fixture.jobId });
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(operation).toMatchObject({ state: "failed", failureCode: "operation_deadline_exceeded", reservedCalls: 0, spentCalls: 0 });
    expect(meeting).toMatchObject({ status: "failed", errorCode: "operation_deadline_exceeded", activeRecoveryOperationId: null });
    expect(await economicCounts(fixture.projectId)).toEqual({ cycles: 1, ledger: 0 });

    const legacy = await seedAcceptedJob();
    await isolated.sql`update recovery_operations set deadline_at = null where id = ${legacy.operationId}`;
    expect(await runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-legacy-deadline-park",
      environment: MAINTENANCE_ONLY_ENVIRONMENT,
    })).toEqual({ outcome: "parked", jobId: legacy.jobId });
    expect(await runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-legacy-deadline-maintenance",
      environment: MAINTENANCE_ONLY_ENVIRONMENT,
    })).toEqual({ outcome: "terminal", jobId: legacy.jobId });
    const [legacyOperation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, legacy.operationId));
    expect(legacyOperation).toMatchObject({ state: "failed", failureCode: "operation_deadline_exceeded", reservedCalls: 0, spentCalls: 0 });
    expect(await economicCounts(legacy.projectId)).toEqual({ cycles: 1, ledger: 0 });
  });

  test("the normal worker entrypoint runs configured maintenance with dispatch gates off while retaining legacy drain", async () => {
    const fixture = await seedAcceptedJob();
    let legacyPops = 0;
    let observed!: () => void;
    const invoked = new Promise<void>((resolve) => { observed = resolve; });
    const ctx = {
      db,
      queue: {
        async pop() {
          legacyPops += 1;
          await Bun.sleep(1);
          return null;
        },
      },
      log: { error() {}, info() {}, warn() {}, debug() {} },
    } as unknown as AppContext;
    const worker = startWorker(ctx, {
      popTimeoutSec: 0,
      environment: { ...MAINTENANCE_ONLY_ENVIRONMENT, RECOVERY_DELIVERY_IDLE_MS: "1" },
      recoveryOwner: "synthetic-entrypoint-worker",
      recoveryFault: (point) => { if (point === "before_handler") observed(); },
    });
    try {
      const signal = await Promise.race([invoked.then(() => "started" as const), Bun.sleep(2_000).then(() => "timeout" as const)]);
      expect(signal).toBe("started");
    } finally {
      await worker.stop();
    }
    expect(legacyPops).toBeGreaterThan(0);
    expect(await state(fixture.jobId)).toMatchObject({ state: "failed", lastErrorCode: "disabled" });
    expect(await economicCounts(fixture.projectId)).toEqual({ cycles: 1, ledger: 0 });
  });

  test("production maintenance stays parked when config flags are on but typed adapters are unavailable", async () => {
    const fixture = await seedAcceptedJob();
    expect(await runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-maintenance-park",
      environment: MAINTENANCE_ONLY_ENVIRONMENT,
    })).toEqual({ outcome: "parked", jobId: fixture.jobId });
    expect(await state(fixture.jobId)).toMatchObject({ state: "failed", lastErrorCode: "disabled", attempt: 1 });
    expect(await economicCounts(fixture.projectId)).toEqual({ cycles: 1, ledger: 0 });

    expect(await runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-production-repair",
      environment: PRODUCTION_ENVIRONMENT,
    })).toEqual({ outcome: "idle" });
    expect(await state(fixture.jobId)).toMatchObject({ state: "failed", lastErrorCode: "disabled", attempt: 1 });
    expect(await economicCounts(fixture.projectId)).toEqual({ cycles: 1, ledger: 0 });
  });

  test("production maintenance converges expired leases and exhaustion while dispatch gates are off", async () => {
    const crashed = await seedAcceptedJob();
    await expect(runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-maintenance-crash",
      environment: MAINTENANCE_ONLY_ENVIRONMENT,
      fault: (point) => { if (point === "before_handler") throw new Error("synthetic maintenance crash"); },
    })).rejects.toThrow("synthetic maintenance crash");
    await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${crashed.jobId}`;
    expect(await runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-maintenance-reaper",
      environment: MAINTENANCE_ONLY_ENVIRONMENT,
    })).toEqual({ outcome: "idle" });
    expect(await state(crashed.jobId)).toMatchObject({ state: "pending", lastErrorCode: "lease_expired", attempt: 1 });

    await isolated.sql`update outbox_jobs set state = 'delivered' where id = ${crashed.jobId}`;
    const exhausted = await seedAcceptedJob({ attempt: POLICY.maxAttempts! });
    expect(await runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-maintenance-exhaustion",
      environment: MAINTENANCE_ONLY_ENVIRONMENT,
    })).toEqual({ outcome: "idle" });
    expect(await state(exhausted.jobId)).toMatchObject({ state: "failed", lastErrorCode: "persistence_failed" });
    expect(await economicCounts(exhausted.projectId)).toEqual({ cycles: 1, ledger: 0 });
  });

  test("real runtime crash before or after the park handler is repaired without debit or provider ledger", async () => {
    for (const crashPoint of ["before_handler", "after_handler"] as const) {
      const fixture = await seedAcceptedJob();
      await expect(runProductionRecoveryDeliveryOnce({
        db,
        owner: `synthetic-real-crash-${crashPoint}`,
        environment: PRODUCTION_ENVIRONMENT,
        fault: (point) => { if (point === crashPoint) throw new Error(`synthetic ${crashPoint}`); },
      })).rejects.toThrow(`synthetic ${crashPoint}`);
      expect(await state(fixture.jobId)).toMatchObject({ state: "leased", attempt: 1 });
      await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${fixture.jobId}`;
      await reapExpiredOutboxJobs({ db, policy: POLICY, limit: 1 });
      await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where id = ${fixture.jobId}`;
      expect(await runProductionRecoveryDeliveryOnce({
        db,
        owner: `synthetic-real-repair-${crashPoint}`,
        environment: PRODUCTION_ENVIRONMENT,
      })).toEqual({ outcome: "parked", jobId: fixture.jobId });
      expect(await economicCounts(fixture.projectId)).toEqual({ cycles: 1, ledger: 0 });
    }
  });

  test("the production runtime reaps an expired crash lease without a separate test callback", async () => {
    const fixture = await seedAcceptedJob();
    await expect(runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-runtime-reaper-crash",
      environment: PRODUCTION_ENVIRONMENT,
      fault: (point) => { if (point === "before_handler") throw new Error("synthetic runtime crash"); },
    })).rejects.toThrow("synthetic runtime crash");
    await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${fixture.jobId}`;
    expect(await runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-runtime-reaper",
      environment: PRODUCTION_ENVIRONMENT,
    })).toEqual({ outcome: "idle" });
    expect(await state(fixture.jobId)).toMatchObject({ state: "pending", lastErrorCode: "lease_expired" });
  });

  test("crash or response loss after handler completion converges without another dispatch", async () => {
    const fixture = await seedAcceptedJob();
    await expect(runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-crash-after",
      environment: PRODUCTION_ENVIRONMENT,
      fault: (point) => { if (point === "before_handler") throw new Error("synthetic response loss"); },
    })).rejects.toThrow("synthetic response loss");
    await complete(fixture);
    await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${fixture.jobId}`;
    expect(await reapExpiredOutboxJobs({ db, policy: POLICY, limit: 1 })).toEqual({ requeued: 0, parked: 0, terminal: 0, delivered: 1 });
    expect(await runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-duplicate",
      environment: PRODUCTION_ENVIRONMENT,
    })).toEqual({ outcome: "idle" });
    expect(await state(fixture.jobId)).toMatchObject({ state: "delivered" });
    expect(await economicCounts(fixture.projectId)).toEqual({ cycles: 1, ledger: 0 });
  });

  test("promotion rollback and explicit retry do not strand processing", async () => {
    const promotion = await seedAcceptedJob();
    await expect(runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-promotion-failure",
      environment: PRODUCTION_ENVIRONMENT,
      fault: (point) => { if (point === "after_job_claim") throw new Error("synthetic promotion failure"); },
    })).rejects.toThrow("synthetic promotion failure");
    expect(await state(promotion.jobId)).toMatchObject({ state: "pending", attempt: 0, leaseFence: 0 });
    const [unpromoted] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, promotion.operationId));
    expect(unpromoted).toMatchObject({ state: "accepted", phase: "queued" });

    await isolated.sql`update outbox_jobs set state = 'delivered' where id = ${promotion.jobId}`;
    const fixture = await seedAcceptedJob();
    const owner = "synthetic-handler-failure";
    const claim = (await claimOutboxJob({ db, owner, policy: POLICY }))!;
    const result = await retryOutboxJob({ db, jobId: claim.id, owner, fence: claim.fence, policy: POLICY });
    expect(result).toBe("retry_scheduled");
    expect(await state(fixture.jobId)).toMatchObject({ state: "pending", lastErrorCode: "delivery_failed" });
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    expect(operation).toMatchObject({ state: "active", phase: "preflighting" });
    expect(JSON.stringify(await state(fixture.jobId))).not.toContain("raw dependency detail");
  });

  test("heartbeat, ack, retry, and park require exact owner and fence", async () => {
    const fixture = await seedAcceptedJob();
    const claim = (await claimOutboxJob({ db, owner: "synthetic-owner", policy: POLICY }))!;
    expect(await heartbeatOutboxJob({ db, jobId: fixture.jobId, owner: "wrong-owner", fence: claim.fence, leaseMs: 60_000 })).toBe(false);
    expect(await heartbeatOutboxJob({ db, jobId: fixture.jobId, owner: "synthetic-owner", fence: claim.fence + 1, leaseMs: 60_000 })).toBe(false);
    expect(await acknowledgeOutboxJob({ db, jobId: fixture.jobId, owner: "wrong-owner", fence: claim.fence })).toBe(false);
    expect(await retryOutboxJob({ db, jobId: fixture.jobId, owner: "synthetic-owner", fence: claim.fence + 1, policy: POLICY })).toBe("stale");
    expect(await parkOutboxJob({ db, jobId: fixture.jobId, owner: "wrong-owner", fence: claim.fence })).toBe(false);
    expect(await heartbeatOutboxJob({ db, jobId: fixture.jobId, owner: "synthetic-owner", fence: claim.fence, leaseMs: 60_000 })).toBe(true);
    expect(await acknowledgeOutboxJob({ db, jobId: fixture.jobId, owner: "synthetic-owner", fence: claim.fence })).toBe(true);
  });

  test("successful acknowledgement completes only the fenced winner and cancels every sibling", async () => {
    const fixture = await seedAcceptedJob();
    const siblingId = await seedSiblingJob(fixture, "ack_sibling");
    const owner = "synthetic-ack-winner";
    const claim = (await claimOutboxJob({ db, owner, policy: POLICY }))!;
    expect(await acknowledgeOutboxJob({ db, jobId: claim.id, owner, fence: claim.fence + 1 })).toBe(false);
    expect(await state(claim.id)).toMatchObject({ state: "leased", leaseFence: claim.fence });
    expect(await state(siblingId)).toMatchObject({ state: "pending" });

    expect(await acknowledgeOutboxJob({ db, jobId: claim.id, owner, fence: claim.fence })).toBe(true);
    expect(await state(claim.id)).toMatchObject({ state: "delivered", leaseFence: claim.fence });
    expect(await state(siblingId)).toMatchObject({ state: "cancelled" });
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(operation).toMatchObject({ state: "completed", phase: "completed", workerLeaseOwnerHash: null });
    expect(meeting).toMatchObject({
      status: "completed",
      activeRecoveryOperationId: null,
      recoveryPhase: "completed",
      lastRecoveryOutcome: "completed",
    });
  });

  test("ack, retry, and park roll back the job mutation when the operation lease mismatches", async () => {
    for (const mutation of ["ack", "retry", "park"] as const) {
      const fixture = await seedAcceptedJob();
      const owner = `synthetic-atomic-${mutation}`;
      const claim = (await claimOutboxJob({ db, owner, policy: POLICY }))!;
      await isolated.sql`update recovery_operations set worker_lease_fence = worker_lease_fence + 1 where id = ${fixture.operationId}`;
      const result = mutation === "ack"
        ? await acknowledgeOutboxJob({ db, jobId: fixture.jobId, owner, fence: claim.fence })
        : mutation === "retry"
          ? await retryOutboxJob({ db, jobId: fixture.jobId, owner, fence: claim.fence, policy: POLICY })
          : await parkOutboxJob({ db, jobId: fixture.jobId, owner, fence: claim.fence });
      expect(result === false || result === "stale").toBe(true);
      expect(await state(fixture.jobId)).toMatchObject({
        state: "leased",
        leaseFence: claim.fence,
      });
    }
  });

  test("a stale terminal-failure attempt cannot clear or fail the current operation lease", async () => {
    const fixture = await seedAcceptedJob({ attempt: POLICY.maxAttempts! - 2 });
    const stale = (await claimOutboxJob({ db, owner: "synthetic-stale-failure", policy: POLICY }))!;
    await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${fixture.jobId}`;
    await reapExpiredOutboxJobs({ db, policy: POLICY, limit: 1 });
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where id = ${fixture.jobId}`;
    const current = (await claimOutboxJob({ db, owner: "synthetic-current-failure", policy: POLICY }))!;
    expect(await retryOutboxJob({
      db,
      jobId: fixture.jobId,
      owner: "synthetic-stale-failure",
      fence: stale.fence,
      policy: POLICY,
    })).toBe("stale");
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    expect(operation).toMatchObject({ state: "active", workerLeaseFence: current.fence, failureCode: null });
    expect(await state(fixture.jobId)).toMatchObject({ state: "leased", leaseFence: current.fence });
  });

  test("a completed meeting and operation beat stale failure from an expired fence", async () => {
    const fixture = await seedAcceptedJob();
    const siblingId = await seedSiblingJob(fixture, "completed_sibling");
    const stale = (await claimOutboxJob({ db, owner: "synthetic-stale", policy: POLICY }))!;
    await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${fixture.jobId}`;
    await reapExpiredOutboxJobs({ db, policy: POLICY, limit: 1 });
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where id = ${fixture.jobId}`;
    const current = (await claimOutboxJob({ db, owner: "synthetic-current", policy: POLICY }))!;
    await complete(fixture);
    expect(await retryOutboxJob({ db, jobId: fixture.jobId, owner: "synthetic-stale", fence: stale.fence, policy: POLICY })).toBe("stale");
    expect(await parkOutboxJob({ db, jobId: fixture.jobId, owner: "synthetic-stale", fence: stale.fence })).toBe(false);
    expect(await acknowledgeOutboxJob({ db, jobId: current.id, owner: "synthetic-current", fence: current.fence })).toBe(true);
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    expect(meeting).toMatchObject({ status: "completed", activeRecoveryOperationId: null });
    expect(operation).toMatchObject({ state: "completed", failureCode: null });
    expect(await state(current.id)).toMatchObject({ state: "delivered", leaseFence: current.fence });
    expect(await state(current.id === fixture.jobId ? siblingId : fixture.jobId)).toMatchObject({ state: "cancelled" });
  });

  test("runtime stop interrupts a maximum idle interval without leaking the worker", async () => {
    const originalSleep = Bun.sleep;
    const originalSetTimeout = globalThis.setTimeout;
    let idleEntered!: () => void;
    let releaseIdle!: () => void;
    const entered = new Promise<void>((resolve) => { idleEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseIdle = resolve; });
    Bun.sleep = ((milliseconds: number) => {
      if (milliseconds === 2_147_483_647) {
        idleEntered();
        return release;
      }
      return originalSleep(milliseconds);
    }) as typeof Bun.sleep;
    const interceptedSetTimeout = ((...parameters: Parameters<typeof originalSetTimeout>) => {
      if (parameters[1] === 2_147_483_647) idleEntered();
      return originalSetTimeout(...parameters);
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.setTimeout = interceptedSetTimeout;
    let stop: Promise<void> | undefined;
    try {
      const runtime = startProductionRecoveryRuntime({
        db,
        owner: "synthetic-bounded-stop",
        environment: { ...MAINTENANCE_ONLY_ENVIRONMENT, RECOVERY_DELIVERY_IDLE_MS: "2147483647" },
      });
      expect(runtime).not.toBeNull();
      await entered;
      stop = runtime!.stop();
      const settled = await Promise.race([
        stop.then(() => true),
        new Promise<false>((resolve) => setImmediate(() => resolve(false))),
      ]);
      expect(settled).toBe(true);
    } finally {
      releaseIdle();
      await stop;
      Bun.sleep = originalSleep;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("unset or disabled policy stays inert before claim or handler and performs no Redis access", async () => {
    const fixture = await seedAcceptedJob();
    const deps = new Proxy({
      db,
      owner: "synthetic-default-off",
      environment: {},
      fault: undefined,
    }, {
      get(target, property, receiver) {
        if (!(property in target)) throw new Error(`forbidden dependency access: ${String(property)}`);
        return Reflect.get(target, property, receiver);
      },
    });
    expect(await runProductionRecoveryDeliveryOnce(deps)).toEqual({ outcome: "idle" });
    expect(await state(fixture.jobId)).toMatchObject({ state: "pending", lastErrorCode: null, attempt: 0 });
  });

  test("retry and reaper exhaustion atomically end safe persistence_failed and preserve audit", async () => {
    for (const mode of ["retry", "reaper"] as const) {
      const fixture = await seedAcceptedJob({ attempt: POLICY.maxAttempts! - 1 });
      const claim = (await claimOutboxJob({ db, owner: `synthetic-exhaust-${mode}`, policy: POLICY }))!;
      if (mode === "retry") {
        expect(await retryOutboxJob({ db, jobId: fixture.jobId, owner: `synthetic-exhaust-${mode}`, fence: claim.fence, policy: POLICY })).toBe("terminal");
      } else {
        await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${fixture.jobId}`;
        expect(await reapExpiredOutboxJobs({ db, policy: POLICY, limit: 1 })).toEqual({ requeued: 0, parked: 0, terminal: 1, delivered: 0 });
      }
      const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
      const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
      expect(await state(fixture.jobId)).toMatchObject({ state: "failed", lastErrorCode: "persistence_failed" });
      expect(operation).toMatchObject({ state: "failed", phase: "failed", failureCode: "persistence_failed", correlationId: "synthetic-correlation" });
      expect(meeting).toMatchObject({ status: "failed", errorCode: "persistence_failed", activeRecoveryOperationId: null });
    }
  });

  test("terminal exhaustion disables every sibling in the same transaction", async () => {
    const fixture = await seedAcceptedJob({ attempt: POLICY.maxAttempts! - 1 });
    const siblingId = await seedSiblingJob(fixture, "exhausted");
    const owner = "synthetic-sibling-exhaustion";
    const claim = (await claimOutboxJob({ db, owner, policy: POLICY }))!;
    expect(await retryOutboxJob({ db, jobId: claim.id, owner, fence: claim.fence, policy: POLICY })).toBe("terminal");
    expect(await state(claim.id)).toMatchObject({ state: "failed", lastErrorCode: "persistence_failed" });
    expect(await state(siblingId)).toMatchObject({ state: "cancelled" });
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(meeting).toMatchObject({ status: "failed", activeRecoveryOperationId: null });
  });

  test("incomplete or invalid delivery policy performs no database mutation", async () => {
    for (const policy of [
      { ...POLICY, retryDelayMs: 0 },
      { ...POLICY, idleMs: 0 },
      { ...POLICY, leaseMs: 1.5 },
      { ...POLICY, maxAttempts: 2 ** 31 },
      { ...POLICY, maxAgeMs: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const fixture = await seedAcceptedJob();
      expect(await claimOutboxJob({ db, owner: "synthetic-invalid-policy", policy })).toBeNull();
      expect(await state(fixture.jobId)).toMatchObject({ state: "pending", attempt: 0, leaseFence: 0 });
    }
  });

  test("already exhausted pending work terminates before handler dispatch", async () => {
    for (const overrides of [
      { attempt: POLICY.maxAttempts! },
      { createdOffset: "-2 hours" },
    ]) {
      const fixture = await seedAcceptedJob(overrides);
      await runProductionRecoveryDeliveryOnce({
        db,
        owner: "synthetic-pending-exhaustion",
        environment: PRODUCTION_ENVIRONMENT,
      });
      expect(await state(fixture.jobId)).toMatchObject({ state: "failed", lastErrorCode: "persistence_failed" });
    }
  });

  test("repair unparks bounded disabled work or terminates age-exhausted work", async () => {
    const repairable = await seedAcceptedJob();
    const old = await seedAcceptedJob({ createdOffset: "-2 hours" });
    await isolated.sql`update outbox_jobs set state = 'failed', last_error_code = 'disabled' where id in (${repairable.jobId}, ${old.jobId})`;
    expect(await repairOutboxJobs({ db, policy: POLICY, limit: 10 })).toEqual({ requeued: 1, parked: 0, terminal: 1, delivered: 0 });
    expect(await state(repairable.jobId)).toMatchObject({ state: "pending", lastErrorCode: null });
    expect(await state(old.jobId)).toMatchObject({ state: "failed", lastErrorCode: "persistence_failed" });
  });

  test("database-time availability bounds queue lag and economic debits never repeat", async () => {
    const fixture = await seedAcceptedJob();
    await isolated.sql`
      update outbox_jobs
      set available_at = clock_timestamp() + interval '5 minutes', created_at = clock_timestamp() - interval '10 minutes'
      where id = ${fixture.jobId}
    `;
    expect(await claimOutboxJob({ db, owner: "synthetic-too-early", policy: POLICY })).toBeNull();
    expect(await outboxQueueHealth(db)).toEqual({ due: 0, oldestDueAgeMs: null });
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() - interval '2 seconds' where id = ${fixture.jobId}`;
    const health = await outboxQueueHealth(db);
    expect(health.due).toBe(1);
    expect(health.oldestDueAgeMs).toBeGreaterThanOrEqual(1_000);
    await runProductionRecoveryDeliveryOnce({ db, owner: "synthetic-economic", environment: PRODUCTION_ENVIRONMENT });
    await runProductionRecoveryDeliveryOnce({ db, owner: "synthetic-economic-duplicate", environment: PRODUCTION_ENVIRONMENT });
    expect(await economicCounts(fixture.projectId)).toEqual({ cycles: 1, ledger: 0 });
  });

  test("max-attempt and max-age exhaustion reconcile reserved and dispatching provider attempts exactly once", async () => {
    for (const exhaustion of ["max_attempts", "max_age"] as const) {
      for (const dispatchState of ["reserved", "dispatching"] as const) {
        const fixture = await seedAcceptedJob({
          attempt: exhaustion === "max_attempts" ? POLICY.maxAttempts! - 1 : 0,
        });
        const attached = await attachProviderReservation(fixture, dispatchState);
        const owner = `synthetic-ledger-exhaust-${exhaustion}-${dispatchState}`;
        const claim = (await claimOutboxJob({ db, owner, policy: POLICY }))!;

        if (exhaustion === "max_attempts") {
          expect(await retryOutboxJob({ db, jobId: claim.id, owner, fence: claim.fence, policy: POLICY })).toBe("terminal");
          expect(await retryOutboxJob({ db, jobId: claim.id, owner, fence: claim.fence, policy: POLICY })).toBe("stale");
        } else {
          await isolated.sql`
            update outbox_jobs
            set created_at = clock_timestamp() - interval '2 hours',
                lease_expires_at = clock_timestamp() - interval '1 second'
            where id = ${claim.id}
          `;
          expect(await reapExpiredOutboxJobs({ db, policy: POLICY, limit: 1 })).toEqual({
            requeued: 0, parked: 0, terminal: 1, delivered: 0,
          });
          expect(await reapExpiredOutboxJobs({ db, policy: POLICY, limit: 1 })).toEqual({
            requeued: 0, parked: 0, terminal: 0, delivered: 0,
          });
        }

        const [ledger] = await db.select().from(providerCallLedger).where(eq(providerCallLedger.id, attached.ledgerId));
        const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
        const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
        const [bucket] = await db.select().from(projectRecoveryBuckets)
          .where(eq(projectRecoveryBuckets.projectId, fixture.projectId));
        const [chunk] = await db.select().from(transcriptionChunks).where(eq(transcriptionChunks.id, attached.chunkId));
        expect(await state(fixture.jobId)).toMatchObject({ state: "failed", lastErrorCode: "persistence_failed" });
        expect(meeting).toMatchObject({ status: "failed", errorCode: "persistence_failed", activeRecoveryOperationId: null });
        expect(chunk).toMatchObject({ state: "failed", providerCallLedgerId: attached.ledgerId });
        if (dispatchState === "reserved") {
          expect(ledger).toMatchObject({ dispatchState: "not_dispatched", outcomeCode: "not_dispatched", statusClass: "none", spentCostMicrounits: 0n });
          expect(operation).toMatchObject({ reservedCalls: 0, spentCalls: 0, submittedAudioMs: 0, reservedCostMicrounits: 0n, spentCostMicrounits: 0n });
          expect(bucket).toMatchObject({ reservedCalls: 0, spentCalls: 0, reservedAudioMs: 0, spentAudioMs: 0, reservedCostMicrounits: 0n, spentCostMicrounits: 0n });
        } else {
          expect(ledger).toMatchObject({ dispatchState: "spent", outcomeCode: "unknown", statusClass: "none", spentCostMicrounits: 1000n });
          expect(operation).toMatchObject({ reservedCalls: 0, spentCalls: 1, submittedAudioMs: 1000, reservedCostMicrounits: 0n, spentCostMicrounits: 1000n });
          expect(bucket).toMatchObject({ reservedCalls: 0, spentCalls: 1, reservedAudioMs: 0, spentAudioMs: 1000, reservedCostMicrounits: 0n, spentCostMicrounits: 1000n });
        }
      }
    }
  });

  test("parked planned work crosses its authoritative deadline while production dispatch remains dark", async () => {
    const fixture = await seedAcceptedJob();
    await isolated.sql`
      update recovery_operations
      set state = 'delayed', phase = 'disabled', planned_audio_ms = 1000,
          source_sample_rate_hz = 1000, source_sample_count = 1000,
          deadline_at = clock_timestamp() - interval '1 millisecond'
      where id = ${fixture.operationId}
    `;
    await isolated.sql`
      update meetings set recovery_phase = 'disabled' where id = ${fixture.meetingId}
    `;
    await isolated.sql`
      update outbox_jobs set state = 'failed', last_error_code = 'disabled' where id = ${fixture.jobId}
    `;
    await isolated.sql`
      update recovery_operations
      set worker_lease_owner_hash = ${"d".repeat(64)},
          worker_lease_expires_at = clock_timestamp() + interval '1 minute',
          worker_lease_fence = worker_lease_fence + 1
      where id = ${fixture.operationId}
    `;
    let providerCalls = 0;
    expect(await runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-dark-deadline",
      environment: MAINTENANCE_ONLY_ENVIRONMENT,
      dispatchAdapter: { async dispatch() { providerCalls += 1; } },
    })).toEqual({ outcome: "idle" });
    await isolated.sql`
      update recovery_operations
      set worker_lease_owner_hash = null, worker_lease_expires_at = null
      where id = ${fixture.operationId}
    `;
    const result = await runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-dark-deadline-fenced",
      environment: MAINTENANCE_ONLY_ENVIRONMENT,
      dispatchAdapter: { async dispatch() { providerCalls += 1; } },
    });
    expect(result).toEqual({ outcome: "terminal", jobId: fixture.jobId });
    expect(providerCalls).toBe(0);
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(operation).toMatchObject({ state: "failed", phase: "failed", failureCode: "operation_deadline_exceeded" });
    expect(meeting).toMatchObject({ status: "failed", recoveryPhase: "failed", errorCode: "operation_deadline_exceeded", activeRecoveryOperationId: null });
    expect(await state(fixture.jobId)).toMatchObject({ state: "failed", lastErrorCode: "operation_deadline_exceeded" });
    expect(await runProductionRecoveryDeliveryOnce({
      db,
      owner: "synthetic-dark-deadline-repeat",
      environment: MAINTENANCE_ONLY_ENVIRONMENT,
    })).toEqual({ outcome: "idle" });
  });

  test("a stale delivery fence cannot settle a dispatching provider reservation", async () => {
    const fixture = await seedAcceptedJob({ attempt: POLICY.maxAttempts! - 1 });
    const attached = await attachProviderReservation(fixture, "dispatching");
    const owner = "synthetic-stale-ledger-terminal";
    const claim = (await claimOutboxJob({ db, owner, policy: POLICY }))!;
    await isolated.sql`
      update recovery_operations
      set worker_lease_owner_hash = ${"e".repeat(64)},
          worker_lease_fence = worker_lease_fence + 1,
          worker_lease_expires_at = clock_timestamp() + interval '1 minute'
      where id = ${fixture.operationId}
    `;
    expect(await retryOutboxJob({ db, jobId: claim.id, owner, fence: claim.fence, policy: POLICY })).toBe("stale");
    const [ledger] = await db.select().from(providerCallLedger).where(eq(providerCallLedger.id, attached.ledgerId));
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, fixture.operationId));
    const [bucket] = await db.select().from(projectRecoveryBuckets)
      .where(eq(projectRecoveryBuckets.projectId, fixture.projectId));
    expect(ledger).toMatchObject({ dispatchState: "dispatching", outcomeCode: null, spentCostMicrounits: 0n });
    expect(operation).toMatchObject({ state: "active", reservedCalls: 1, spentCalls: 0, submittedAudioMs: 0 });
    expect(bucket).toMatchObject({ reservedCalls: 1, spentCalls: 0, reservedAudioMs: 1000, spentAudioMs: 0 });
  });
});
