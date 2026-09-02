import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDb } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import {
  outboxJobs,
  projectRecoveryBuckets,
  providerCallLedger,
  recoveryOperations,
  meetings,
  type RecoveryOperationRow,
} from "../../src/db/schema.ts";
import { ApiError, type ErrorCode } from "../../src/domain/errors.ts";
import {
  repeatRecoveryPreflightBeforeFirstDebit,
  startManualRecovery,
  UNSET_RECOVERY_ACCEPTANCE_POLICY,
  type RecoveryAcceptancePolicy,
} from "../../src/services/recovery.ts";
import type { VexaRecoveryPreflightResult } from "../../src/providers/vexa/recovery-preflight.ts";
import { claimOutboxJob, reapExpiredOutboxJobs, type DurableDeliveryPolicy } from "../../src/worker/outbox.ts";
import { createIsolatedDatabase, type IsolatedDatabase } from "./a2-db.ts";

const POLICY: RecoveryAcceptancePolicy = {
  enabled: true,
  providerV2Enabled: true,
  manualMeetingCycles: 1,
  cooldownBaseMs: 60_000,
  cooldownMaxMs: 600_000,
  retentionPolicyVersion: "synthetic-retention-v1",
  priceVersion: "synthetic-price-v1",
  providerLimits: {
    maxSourceDurationMs: 1_800_000,
    maxRecordingBytes: 25_000_000,
    maxCallsPerOperation: 30,
    maxSubmittedAudioMsPerOperation: 3_600_000,
    maxConcurrency: 1,
    operationDeadlineMs: 2_700_000,
  },
  projectBudget: {
    manualCycles: 5,
    automaticCycles: 0,
    sharedCalls: 150,
    sharedAudioMs: 18_000_000,
    sharedCostMicrounits: 50_000n,
  },
  recording: {
    maxMediaFilesPerRecording: 4,
    maxMetadataStringLength: 128,
    allowedMediaTypes: ["audio/webm"],
    maxDurationMs: 1_800_000,
    maxBytes: 25_000_000,
  },
};

const PRESENT: VexaRecoveryPreflightResult = {
  availability: "present_unverified",
  code: "recording_present_unverified",
  status: 200,
};

const DELIVERY_POLICY: DurableDeliveryPolicy = {
  leaseMs: 60_000,
  maxAttempts: 3,
  maxAgeMs: 3_600_000,
  retryDelayMs: 1_000,
  idleMs: 1_000,
};

let isolated: IsolatedDatabase;
let db: ReturnType<typeof createDb>;
let sequence = 0;

setDefaultTimeout(30_000);

async function seedMeeting(overrides: Record<string, unknown> = {}) {
  sequence += 1;
  const projectId = `prj_a3_${sequence}`;
  const meetingId = `mtg_01J${String(sequence).padStart(23, "0")}`;
  await isolated.sql`
    insert into projects (id, name, webhook_secret)
    values (${projectId}, ${"synthetic-project"}, ${"whsec_synthetic_opaque"})
  `;
  await db.insert(meetings).values({
    id: meetingId,
    projectId,
    meetingUrl: "https://synthetic.invalid/opaque",
    platform: "jitsi",
    status: "failed",
    errorCode: "provider_timeout",
    errorMessage: "safe",
    vexaPlatform: "jitsi",
    vexaNativeMeetingId: `synthetic-native-${sequence}`,
    metadata: {},
    ...overrides,
  });
  return { projectId, meetingId };
}

async function counts(projectId: string) {
  const [row] = await isolated.sql<{
    operations: number;
    buckets: number;
    manual_cycles: number;
    outbox: number;
    ledger: number;
  }[]>`
    select
      (select count(*)::int from recovery_operations where project_id = ${projectId}) operations,
      (select count(*)::int from project_recovery_buckets where project_id = ${projectId}) buckets,
      coalesce((select sum(manual_cycles)::int from project_recovery_buckets where project_id = ${projectId}), 0) manual_cycles,
      (select count(*)::int from outbox_jobs where project_id = ${projectId}) outbox,
      (select count(*)::int from provider_call_ledger where project_id = ${projectId}) ledger
  `;
  return row!;
}

async function expectSafeError(run: Promise<unknown>, code: ErrorCode, status: number) {
  try {
    await run;
    throw new Error("expected safe error");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(code);
    expect((error as ApiError).status).toBe(status);
  }
}

function operationOf(result: Awaited<ReturnType<typeof startManualRecovery>>): RecoveryOperationRow {
  expect(result.operation).not.toBeNull();
  if (!result.operation) throw new Error("expected recovery operation");
  return result.operation;
}

beforeAll(async () => {
  isolated = await createIsolatedDatabase("ptx_a3_service");
  const migrationDb = await runMigrations(isolated.url);
  await migrationDb.$client.close();
  db = createDb(isolated.url);
});

afterAll(async () => {
  await db?.$client.close();
  await isolated?.drop();
});

describe("A3 database-authoritative manual recovery acceptance", () => {
  test("one transaction creates one operation, one meeting/project cycle debit, processing link, and pending outbox", async () => {
    const fixture = await seedMeeting();
    let preflightCalls = 0;
    const result = await startManualRecovery({
      db,
      policy: POLICY,
      preflight: async () => { preflightCalls += 1; return PRESENT; },
    }, { ...fixture, idempotencyKey: "synthetic-key-one" });

    expect(result.disposition).toBe("started");
    expect(result.replayed).toBe(false);
    const operation = operationOf(result);
    expect(operation.id).toMatch(/^rcv_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(preflightCalls).toBe(1);
    expect(await counts(fixture.projectId)).toEqual({ operations: 1, buckets: 1, manual_cycles: 1, outbox: 1, ledger: 0 });
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(meeting).toMatchObject({
      status: "processing",
      manualRecoveryCyclesConsumed: 1,
      activeRecoveryOperationId: operation.id,
      recoveryPhase: "queued",
    });
    const [job] = await db.select().from(outboxJobs).where(eq(outboxJobs.operationId, operation.id));
    expect(job).toMatchObject({ state: "pending", eventType: "operation.accepted" });
    expect(operation.idempotencyKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(operation, (_key, value) => typeof value === "bigint" ? value.toString() : value))
      .not.toContain("synthetic-key-one");
  });

  test("acceptance snapshots the hard deadline from database time and replay preserves it across policy drift", async () => {
    const fixture = await seedMeeting();
    const input = { ...fixture, idempotencyKey: "synthetic-deadline-snapshot" };
    const accepted = await startManualRecovery({ db, policy: POLICY, preflight: async () => PRESENT }, input);
    const operation = operationOf(accepted);
    expect(operation.deadlineAt).not.toBeNull();
    expect(operation.deadlineAt!.getTime() - operation.acceptedAt.getTime())
      .toBe(POLICY.providerLimits.operationDeadlineMs!);

    const driftedPolicy: RecoveryAcceptancePolicy = {
      ...POLICY,
      providerLimits: { ...POLICY.providerLimits, operationDeadlineMs: 9_000_000 },
    };
    const replay = await startManualRecovery({ db, policy: driftedPolicy, preflight: async () => PRESENT }, input);
    expect(replay.replayed).toBe(true);
    const replayed = operationOf(replay);
    expect(replayed.id).toBe(operation.id);
    expect(replayed.deadlineAt).toEqual(operation.deadlineAt);
  });

  test("same-key lost-response replay and concurrent same-key calls return one original row", async () => {
    const fixture = await seedMeeting();
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const preflight = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
      return PRESENT;
    };
    const input = { ...fixture, idempotencyKey: "synthetic-concurrent-same" };
    const [a, b] = await Promise.all([
      startManualRecovery({ db, policy: POLICY, preflight }, input),
      startManualRecovery({ db, policy: POLICY, preflight }, input),
    ]);
    const operationA = operationOf(a);
    const operationB = operationOf(b);
    expect(new Set([operationA.id, operationB.id]).size).toBe(1);
    expect([a.disposition, b.disposition]).toEqual(["started", "started"]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    const replay = await startManualRecovery({ db, policy: POLICY, preflight }, input);
    expect(replay.replayed).toBe(true);
    expect(replay).toMatchObject({ disposition: "started", operation: { id: operationA.id } });
    expect(await counts(fixture.projectId)).toEqual({ operations: 1, buckets: 1, manual_cycles: 1, outbox: 1, ledger: 0 });
  });

  test("simultaneous different keys yield one started and one already_active without sleeps", async () => {
    const fixture = await seedMeeting();
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const preflight = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
      return PRESENT;
    };
    const results = await Promise.all([
      startManualRecovery({ db, policy: POLICY, preflight }, { ...fixture, idempotencyKey: "synthetic-different-a" }),
      startManualRecovery({ db, policy: POLICY, preflight }, { ...fixture, idempotencyKey: "synthetic-different-b" }),
    ]);
    expect(results.map((result) => result.disposition).sort()).toEqual(["already_active", "started"]);
    const active = results.find((result) => result.disposition === "already_active")!;
    expect(active.operation?.id).toBe(results.find((result) => result.disposition === "started")!.operation?.id);
    expect(await counts(fixture.projectId)).toEqual({ operations: 1, buckets: 1, manual_cycles: 1, outbox: 1, ledger: 0 });
  });

  test("completed and processing remain zero-write read dispositions", async () => {
    for (const [status, disposition] of [["completed", "already_completed"], ["processing", "already_active"]] as const) {
      const fixture = await seedMeeting({ status, errorCode: null });
      let preflightCalls = 0;
      const result = await startManualRecovery({
        db,
        policy: POLICY,
        preflight: async () => { preflightCalls += 1; return PRESENT; },
      }, { ...fixture, idempotencyKey: `synthetic-${status}` });
      expect(result.disposition).toBe(disposition);
      expect(preflightCalls).toBe(0);
      expect(await counts(fixture.projectId)).toEqual({ operations: 0, buckets: 0, manual_cycles: 0, outbox: 0, ledger: 0 });
    }
    const legacyProcessing = await seedMeeting({ status: "processing", errorCode: null });
    const result = await startManualRecovery({ db, preflight: async () => PRESENT }, {
      ...legacyProcessing,
      idempotencyKey: "synthetic-processing-default-off",
    });
    expect(result.disposition).toBe("already_active");
    expect(await counts(legacyProcessing.projectId)).toEqual({ operations: 0, buckets: 0, manual_cycles: 0, outbox: 0, ledger: 0 });
  });

  test("all eligibility/config refusals are exact and leave every durable/effect counter at zero", async () => {
    const fixtures = [
      { name: "legacy", meeting: { budgetProvenance: "legacy_unknown" }, policy: POLICY, preflight: PRESENT, code: "recovery_ineligible", status: 409 },
      { name: "wrong-code", meeting: { errorCode: "transcription_failed" }, policy: POLICY, preflight: PRESENT, code: "recovery_ineligible", status: 409 },
      { name: "wrong-status", meeting: { status: "cancelled", errorCode: "cancelled" }, policy: POLICY, preflight: PRESENT, code: "recovery_ineligible", status: 409 },
      { name: "tombstone", meeting: { lastRecoveryOutcome: "cancelled" }, policy: POLICY, preflight: PRESENT, code: "recovery_ineligible", status: 409 },
      { name: "absent", meeting: {}, policy: POLICY, preflight: { availability: "absent", code: "recording_absent", status: 410 }, code: "recording_absent", status: 410 },
      { name: "transient", meeting: {}, policy: POLICY, preflight: { availability: "transient", code: "recording_fetch_transient", status: 503 }, code: "recording_fetch_transient", status: 503 },
      { name: "permanent", meeting: {}, policy: POLICY, preflight: { availability: "permanent", code: "recording_metadata_unsupported", status: 409 }, code: "recovery_ineligible", status: 409 },
      { name: "meeting-budget", meeting: { manualRecoveryCyclesConsumed: 1 }, policy: POLICY, preflight: PRESENT, code: "budget_exhausted", status: 429 },
      { name: "disabled", meeting: {}, policy: { ...POLICY, enabled: false }, preflight: PRESENT, code: "recovery_disabled", status: 503 },
      { name: "unset", meeting: {}, policy: UNSET_RECOVERY_ACCEPTANCE_POLICY, preflight: PRESENT, code: "recovery_disabled", status: 503 },
    ] as const;

    for (const testCase of fixtures) {
      const fixture = await seedMeeting(testCase.meeting);
      let preflightCalls = 0;
      await expectSafeError(startManualRecovery({
        db,
        policy: testCase.policy,
        preflight: async () => { preflightCalls += 1; return testCase.preflight as VexaRecoveryPreflightResult; },
      }, { ...fixture, idempotencyKey: `synthetic-refusal-${testCase.name}` }), testCase.code, testCase.status);
      expect(await counts(fixture.projectId)).toEqual({ operations: 0, buckets: 0, manual_cycles: 0, outbox: 0, ledger: 0 });
      if (["absent", "transient", "permanent"].includes(testCase.name)) expect(preflightCalls).toBe(1);
      else expect(preflightCalls).toBe(0);
    }
  });

  test("recording_fetch_transient requires a database-time cooldown and malformed keys fail before effects", async () => {
    const cooling = await seedMeeting({
      errorCode: "recording_fetch_transient",
      nextRecoveryEligibleAt: sql`clock_timestamp() + interval '10 minutes'`,
    });
    let preflightCalls = 0;
    await expectSafeError(startManualRecovery({
      db,
      policy: POLICY,
      preflight: async () => { preflightCalls += 1; return PRESENT; },
    }, { ...cooling, idempotencyKey: "synthetic-cooling" }), "recovery_cooldown", 429);
    expect(preflightCalls).toBe(0);
    expect(await counts(cooling.projectId)).toEqual({ operations: 0, buckets: 0, manual_cycles: 0, outbox: 0, ledger: 0 });

    const malformed = await seedMeeting();
    await expectSafeError(startManualRecovery({ db, policy: POLICY, preflight: async () => PRESENT }, {
      ...malformed,
      idempotencyKey: "contains whitespace",
    }), "invalid_request", 400);
    expect(await counts(malformed.projectId)).toEqual({ operations: 0, buckets: 0, manual_cycles: 0, outbox: 0, ledger: 0 });
  });

  test("only the exact recoverable codes start, including recording_fetch_transient after database cooldown", async () => {
    for (const errorCode of [
      "provider_timeout",
      "provider_unavailable",
      "finalizer_interrupted",
      "recording_fetch_transient",
    ]) {
      const fixture = await seedMeeting({
        errorCode,
        nextRecoveryEligibleAt: sql`clock_timestamp() - interval '1 second'`,
      });
      const result = await startManualRecovery({ db, policy: POLICY, preflight: async () => PRESENT }, {
        ...fixture,
        idempotencyKey: `synthetic-eligible-${errorCode}`,
      });
      expect(result.disposition).toBe("started");
      expect(await counts(fixture.projectId)).toEqual({ operations: 1, buckets: 1, manual_cycles: 1, outbox: 1, ledger: 0 });
    }
  });

  test("an exhausted project window rejects before preflight and does not add a debit", async () => {
    const fixture = await seedMeeting();
    await isolated.sql`
      insert into project_recovery_buckets (project_id, bucket_minute, manual_cycles)
      values (
        ${fixture.projectId},
        date_trunc('minute', clock_timestamp() at time zone 'UTC') at time zone 'UTC',
        ${POLICY.projectBudget.manualCycles}
      )
    `;
    let preflightCalls = 0;
    await expectSafeError(startManualRecovery({
      db,
      policy: POLICY,
      preflight: async () => { preflightCalls += 1; return PRESENT; },
    }, { ...fixture, idempotencyKey: "synthetic-project-exhausted" }), "budget_exhausted", 429);
    expect(preflightCalls).toBe(0);
    expect(await counts(fixture.projectId)).toEqual({
      operations: 0,
      buckets: 1,
      manual_cycles: POLICY.projectBudget.manualCycles!,
      outbox: 0,
      ledger: 0,
    });
  });

  test("transaction fault injection rolls back operation, meeting debit/link, bucket, and outbox", async () => {
    for (const point of ["after_operation_insert", "after_meeting_update", "before_outbox_insert", "after_outbox_insert"] as const) {
      const fixture = await seedMeeting();
      await expect(startManualRecovery({
        db,
        policy: POLICY,
        preflight: async () => PRESENT,
        fault: (at) => { if (at === point) throw new Error("synthetic persistence failure"); },
      }, { ...fixture, idempotencyKey: `synthetic-fault-${point}` })).rejects.toThrow("synthetic persistence failure");
      expect(await counts(fixture.projectId)).toEqual({ operations: 0, buckets: 0, manual_cycles: 0, outbox: 0, ledger: 0 });
      const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
      expect(meeting).toMatchObject({ status: "failed", manualRecoveryCyclesConsumed: 0, activeRecoveryOperationId: null });
    }
  });

  test("Redis outage cannot block DB-outbox acceptance and creates no Redis job", async () => {
    const fixture = await seedMeeting();
    const deps = new Proxy({
      db,
      policy: POLICY,
      preflight: async () => PRESENT,
    }, {
      get(target, property, receiver) {
        if (property === "fault") return undefined;
        if (!(property in target)) throw new Error(`forbidden queue/Redis dependency access: ${String(property)}`);
        return Reflect.get(target, property, receiver);
      },
    });
    const result = await startManualRecovery(deps, { ...fixture, idempotencyKey: "synthetic-redis-outage" });
    expect(result.disposition).toBe("started");
    expect(await counts(fixture.projectId)).toEqual({ operations: 1, buckets: 1, manual_cycles: 1, outbox: 1, ledger: 0 });
  });

  test("same-key replay and different-key active convergence remain inspectable after switch-off", async () => {
    const fixture = await seedMeeting();
    const input = { ...fixture, idempotencyKey: "synthetic-switch-original" };
    const started = await startManualRecovery({ db, policy: POLICY, preflight: async () => PRESENT }, input);
    const off = { ...POLICY, enabled: false };
    const replay = await startManualRecovery({ db, policy: off, preflight: async () => PRESENT }, input);
    const startedOperation = operationOf(started);
    expect(replay).toMatchObject({ disposition: "started", operation: { id: startedOperation.id } });
    const active = await startManualRecovery({ db, policy: off, preflight: async () => PRESENT }, {
      ...fixture,
      idempotencyKey: "synthetic-switch-new",
    });
    expect(active).toMatchObject({ disposition: "already_active", operation: { id: startedOperation.id } });
    expect(await counts(fixture.projectId)).toEqual({ operations: 1, buckets: 1, manual_cycles: 1, outbox: 1, ledger: 0 });
  });

  test("TOCTOU disappearance before first call/audio debit atomically terminates operation and meeting", async () => {
    const fixture = await seedMeeting();
    const started = await startManualRecovery({ db, policy: POLICY, preflight: async () => PRESENT }, {
      ...fixture,
      idempotencyKey: "synthetic-toctou",
    });
    let preflightCalls = 0;
    const leaseOwner = "synthetic-toctou-worker";
    await isolated.sql`update outbox_jobs set state = 'delivered' where operation_id <> ${operationOf(started).id} and state = 'pending'`;
    const claim = await claimOutboxJob({ db, owner: leaseOwner, policy: DELIVERY_POLICY });
    expect(claim).not.toBeNull();
    const deps = new Proxy({
      db,
      operationId: operationOf(started).id,
      leaseOwner,
      operationFence: claim!.fence,
      preflight: async () => {
        preflightCalls += 1;
        return { availability: "absent", code: "recording_absent", status: 410 } as const;
      },
    }, {
      get(target, property, receiver) {
        if (!(property in target)) throw new Error(`forbidden provider/download dependency access: ${String(property)}`);
        return Reflect.get(target, property, receiver);
      },
    });
    const result = await repeatRecoveryPreflightBeforeFirstDebit(deps);
    expect(result).toEqual({ outcome: "recording_absent" });
    expect(preflightCalls).toBe(1);
    const startedOperation = operationOf(started);
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, startedOperation.id));
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(operation).toMatchObject({ state: "failed", phase: "failed", failureCode: "recording_absent" });
    expect(meeting).toMatchObject({
      status: "failed",
      errorCode: "recording_absent",
      activeRecoveryOperationId: null,
      recoveryPhase: "failed",
    });
    expect(await db.select().from(outboxJobs).where(eq(outboxJobs.operationId, startedOperation.id)))
      .toEqual([expect.objectContaining({ state: "cancelled", eventType: "operation.accepted" })]);
    expect(await db.select().from(providerCallLedger).where(eq(providerCallLedger.operationId, startedOperation.id))).toHaveLength(0);
  });

  test("an expired repeat-preflight lease cannot fail or clear the newly leased operation", async () => {
    const fixture = await seedMeeting();
    const started = await startManualRecovery({ db, policy: POLICY, preflight: async () => PRESENT }, {
      ...fixture,
      idempotencyKey: "synthetic-stale-toctou",
    });
    const operationId = operationOf(started).id;
    await isolated.sql`update outbox_jobs set state = 'delivered' where operation_id <> ${operationId} and state = 'pending'`;
    const stale = (await claimOutboxJob({ db, owner: "synthetic-stale-preflight", policy: DELIVERY_POLICY }))!;
    await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${stale.id}`;
    await reapExpiredOutboxJobs({ db, policy: DELIVERY_POLICY, limit: 1 });
    await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where id = ${stale.id}`;
    const current = (await claimOutboxJob({ db, owner: "synthetic-current-preflight", policy: DELIVERY_POLICY }))!;
    expect(current).toMatchObject({ operationId, fence: stale.fence + 1 });

    const result = await repeatRecoveryPreflightBeforeFirstDebit({
      db,
      operationId,
      leaseOwner: "synthetic-stale-preflight",
      operationFence: stale.fence,
      preflight: async () => ({ availability: "absent", code: "recording_absent", status: 410 }),
    });
    expect(result).toEqual({ outcome: "stale" });
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, operationId));
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, fixture.meetingId));
    expect(operation).toMatchObject({
      state: "active",
      workerLeaseFence: current.fence,
      failureCode: null,
    });
    expect(meeting).toMatchObject({
      status: "processing",
      activeRecoveryOperationId: operationId,
    });
    expect(await db.select().from(providerCallLedger).where(eq(providerCallLedger.operationId, operationId))).toHaveLength(0);
  });

  test("a lease lost during a present repeat-preflight returns stale before first debit", async () => {
    const fixture = await seedMeeting();
    const started = await startManualRecovery({ db, policy: POLICY, preflight: async () => PRESENT }, {
      ...fixture,
      idempotencyKey: "synthetic-midflight-stale",
    });
    const operationId = operationOf(started).id;
    await isolated.sql`update outbox_jobs set state = 'delivered' where operation_id <> ${operationId} and state = 'pending'`;
    const staleOwner = "synthetic-midflight-stale-owner";
    const stale = (await claimOutboxJob({ db, owner: staleOwner, policy: DELIVERY_POLICY }))!;
    let currentFence = 0;
    const result = await repeatRecoveryPreflightBeforeFirstDebit({
      db,
      operationId,
      leaseOwner: staleOwner,
      operationFence: stale.fence,
      preflight: async () => {
        await isolated.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = ${stale.id}`;
        await reapExpiredOutboxJobs({ db, policy: DELIVERY_POLICY, limit: 1 });
        await isolated.sql`update outbox_jobs set available_at = clock_timestamp() where id = ${stale.id}`;
        currentFence = (await claimOutboxJob({ db, owner: "synthetic-midflight-current", policy: DELIVERY_POLICY }))!.fence;
        return PRESENT;
      },
    });
    expect(result).toEqual({ outcome: "stale" });
    const [operation] = await db.select().from(recoveryOperations).where(eq(recoveryOperations.id, operationId));
    expect(operation).toMatchObject({ state: "active", workerLeaseFence: currentFence, failureCode: null });
    expect(await db.select().from(providerCallLedger).where(eq(providerCallLedger.operationId, operationId))).toHaveLength(0);
  });

  test("a terminal meeting transition during repeat-preflight stops before any first-debit effects", async () => {
    const fixture = await seedMeeting();
    const started = await startManualRecovery({ db, policy: POLICY, preflight: async () => PRESENT }, {
      ...fixture,
      idempotencyKey: "synthetic-midflight-terminal-meeting",
    });
    const operationId = operationOf(started).id;
    await isolated.sql`update outbox_jobs set state = 'delivered' where operation_id <> ${operationId} and state = 'pending'`;
    const owner = "synthetic-midflight-terminal-owner";
    const claim = (await claimOutboxJob({ db, owner, policy: DELIVERY_POLICY }))!;

    const result = await repeatRecoveryPreflightBeforeFirstDebit({
      db,
      operationId,
      leaseOwner: owner,
      operationFence: claim.fence,
      preflight: async () => {
        await isolated.sql`
          update meetings
          set status = 'cancelled', active_recovery_operation_id = null, recovery_phase = 'failed'
          where id = ${fixture.meetingId}
        `;
        return PRESENT;
      },
    });

    expect(result).toEqual({ outcome: "terminal" });
    expect(await counts(fixture.projectId)).toEqual({
      operations: 1,
      buckets: 1,
      manual_cycles: 1,
      outbox: 1,
      ledger: 0,
    });
    expect(await db.select().from(providerCallLedger).where(eq(providerCallLedger.operationId, operationId))).toHaveLength(0);
  });
});
