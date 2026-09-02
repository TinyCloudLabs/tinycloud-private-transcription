import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import {
  reserveProjectRecoveryBudget,
  type RecoveryBudgetLimits,
  type RecoveryBudgetReservation,
} from "../../src/db/recovery-budget.ts";
import { createIsolatedDatabase, type IsolatedDatabase } from "./a2-db.ts";

const FULL_LIMITS: RecoveryBudgetLimits = {
  manualCycles: 2,
  automaticCycles: 1,
  sharedCalls: 3,
  sharedAudioMs: 180_000,
  sharedCostMicrounits: 300n,
};

const ONE: RecoveryBudgetReservation = {
  cycles: 1,
  calls: 1,
  audioMs: 60_000,
  costMicrounits: 100n,
};

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

let isolated: IsolatedDatabase;
let db: ReturnType<typeof createDb>;

setDefaultTimeout(30_000);

async function addProject(id: string): Promise<void> {
  await isolated.sql`
    insert into projects (id, name, webhook_secret)
    values (${id}, ${"synthetic-project"}, ${"whsec_synthetic_opaque"})
  `;
}

function trackTransactions(): { trackedDb: typeof db; transactionCalls: () => number } {
  let calls = 0;
  const trackedDb = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "transaction" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls += 1;
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { trackedDb, transactionCalls: () => calls };
}

beforeAll(async () => {
  isolated = await createIsolatedDatabase("ptx_a2_budget");
  const migrationDb = await runMigrations(isolated.url);
  await migrationDb.$client.close();
  db = createDb(isolated.url);
});

afterAll(async () => {
  await db?.$client.close();
  await isolated?.drop();
});

describe("A2 locked rolling-window reservation primitive", () => {
  test("unset operator limits fail closed and rejection rolls back guard and bucket writes", async () => {
    const projectId = "prj_budget_unset";
    await addProject(projectId);
    const result = await reserveProjectRecoveryBudget(db, {
      projectId,
      kind: "manual",
      reservation: ONE,
      limits: { ...FULL_LIMITS, sharedCostMicrounits: null },
    });
    expect(result).toEqual({ accepted: false, reason: "limits_unset" });
    const [counts] = await isolated.sql<{ guards: number; buckets: number }[]>`
      select
        (select count(*)::int from project_recovery_guards where project_id = ${projectId}) as guards,
        (select count(*)::int from project_recovery_buckets where project_id = ${projectId}) as buckets
    `;
    expect(counts).toEqual({ guards: 0, buckets: 0 });
  });

  test("first-use over-limit rejection rolls back the locked guard and bucket", async () => {
    const projectId = "prj_budget_first_use_reject";
    await addProject(projectId);
    expect(await reserveProjectRecoveryBudget(db, {
      projectId,
      kind: "manual",
      reservation: ONE,
      limits: { ...FULL_LIMITS, manualCycles: 0 },
    })).toEqual({ accepted: false, reason: "manual_cycles_exhausted" });
    const [counts] = await isolated.sql<{ guards: number; buckets: number }[]>`
      select
        (select count(*)::int from project_recovery_guards where project_id = ${projectId}) as guards,
        (select count(*)::int from project_recovery_buckets where project_id = ${projectId}) as buckets
    `;
    expect(counts).toEqual({ guards: 0, buckets: 0 });
  });

  test("caller input cannot shorten the authoritative 1,440-minute window", async () => {
    const projectId = "prj_budget_fixed_window";
    await addProject(projectId);
    const [clock] = await isolated.sql<{ minute: Date }[]>`
      select date_trunc('minute', clock_timestamp() at time zone 'UTC') at time zone 'UTC' as minute
    `;
    await isolated.sql`
      insert into project_recovery_buckets
        (project_id, bucket_minute, reserved_calls)
      values (${projectId}, ${new Date(clock!.minute.getTime() - 2 * 60_000)}, ${1})
    `;
    const input = {
      projectId,
      kind: "manual" as const,
      windowMinutes: 1,
      reservation: { ...ONE, audioMs: 0, costMicrounits: 0n },
      limits: { ...FULL_LIMITS, sharedCalls: 1 },
    };
    expect(await reserveProjectRecoveryBudget(db, input)).toEqual({
      accepted: false,
      reason: "shared_calls_exhausted",
    });
  });

  test("invalid and out-of-range shared cost limits fail closed before a transaction", async () => {
    const cases = [
      { projectId: "prj_budget_cost_type", value: 300 },
      { projectId: "prj_budget_cost_negative", value: -1n },
      { projectId: "prj_budget_cost_range", value: POSTGRES_BIGINT_MAX + 1n },
    ] as const;
    for (const fixture of cases) {
      await addProject(fixture.projectId);
      expect(await reserveProjectRecoveryBudget(db, {
        projectId: fixture.projectId,
        kind: "manual",
        reservation: ONE,
        limits: {
          ...FULL_LIMITS,
          sharedCostMicrounits: fixture.value as unknown as bigint,
        },
      })).toEqual({ accepted: false, reason: "limits_unset" });
      const [counts] = await isolated.sql<{ guards: number; buckets: number }[]>`
        select
          (select count(*)::int from project_recovery_guards where project_id = ${fixture.projectId}) as guards,
          (select count(*)::int from project_recovery_buckets where project_id = ${fixture.projectId}) as buckets
      `;
      expect(counts).toEqual({ guards: 0, buckets: 0 });
    }
  });

  test("runtime-invalid integer-backed limits fail closed before a transaction", async () => {
    const fields = ["manualCycles", "automaticCycles", "sharedCalls"] as const;
    const invalidValues = [
      ["max_plus_one", POSTGRES_INTEGER_MAX + 1],
      ["wrong_type", "1"],
      ["fraction", 1.5],
      ["negative", -1],
      ["nan", Number.NaN],
      ["positive_infinity", Number.POSITIVE_INFINITY],
      ["negative_infinity", Number.NEGATIVE_INFINITY],
    ] as const;

    for (const field of fields) {
      for (const [label, value] of invalidValues) {
        const projectId = `prj_budget_limit_${field}_${label}`;
        await addProject(projectId);
        const { trackedDb, transactionCalls } = trackTransactions();
        expect(await reserveProjectRecoveryBudget(trackedDb, {
          projectId,
          kind: "manual",
          reservation: ONE,
          limits: { ...FULL_LIMITS, [field]: value } as RecoveryBudgetLimits,
        })).toEqual({ accepted: false, reason: "limits_unset" });
        expect(transactionCalls()).toBe(0);
      }
    }
  });

  test("exact PostgreSQL integer max is accepted for every integer-backed limit", async () => {
    const fields = ["manualCycles", "automaticCycles", "sharedCalls"] as const;
    for (const field of fields) {
      const projectId = `prj_budget_limit_${field}_exact_max`;
      await addProject(projectId);
      const { trackedDb, transactionCalls } = trackTransactions();
      expect(await reserveProjectRecoveryBudget(trackedDb, {
        projectId,
        kind: "manual",
        reservation: ONE,
        limits: { ...FULL_LIMITS, [field]: POSTGRES_INTEGER_MAX },
      })).toMatchObject({ accepted: true });
      expect(transactionCalls()).toBe(1);
    }
  });

  test("number-backed bigint limits reject runtime-invalid values before a transaction", async () => {
    const invalidValues = [
      ["max_plus_one", Number.MAX_SAFE_INTEGER + 1],
      ["wrong_type", "180000"],
      ["fraction", 1.5],
      ["negative", -1],
      ["nan", Number.NaN],
      ["positive_infinity", Number.POSITIVE_INFINITY],
      ["negative_infinity", Number.NEGATIVE_INFINITY],
    ] as const;

    for (const [label, value] of invalidValues) {
      const projectId = `prj_budget_audio_limit_${label}`;
      await addProject(projectId);
      const { trackedDb, transactionCalls } = trackTransactions();
      expect(await reserveProjectRecoveryBudget(trackedDb, {
        projectId,
        kind: "manual",
        reservation: ONE,
        limits: { ...FULL_LIMITS, sharedAudioMs: value } as RecoveryBudgetLimits,
      })).toEqual({ accepted: false, reason: "limits_unset" });
      expect(transactionCalls()).toBe(0);
    }
  });

  test("exact storage-compatible maxima are accepted for bigint-backed limits", async () => {
    const cases = [
      { projectId: "prj_budget_audio_limit_exact_max", field: "sharedAudioMs", value: Number.MAX_SAFE_INTEGER },
      { projectId: "prj_budget_cost_limit_exact_max", field: "sharedCostMicrounits", value: POSTGRES_BIGINT_MAX },
    ] as const;
    for (const fixture of cases) {
      await addProject(fixture.projectId);
      const { trackedDb, transactionCalls } = trackTransactions();
      expect(await reserveProjectRecoveryBudget(trackedDb, {
        projectId: fixture.projectId,
        kind: "manual",
        reservation: ONE,
        limits: { ...FULL_LIMITS, [fixture.field]: fixture.value } as RecoveryBudgetLimits,
      })).toMatchObject({ accepted: true });
      expect(transactionCalls()).toBe(1);
    }
  });

  test("invalid and out-of-range requested cost deltas are rejected before a transaction", async () => {
    const cases = [
      { projectId: "prj_budget_delta_type", value: 100 },
      { projectId: "prj_budget_delta_negative", value: -1n },
      { projectId: "prj_budget_delta_range", value: POSTGRES_BIGINT_MAX + 1n },
    ] as const;
    for (const fixture of cases) {
      await addProject(fixture.projectId);
      await expect(reserveProjectRecoveryBudget(db, {
        projectId: fixture.projectId,
        kind: "manual",
        reservation: { ...ONE, costMicrounits: fixture.value as unknown as bigint },
        limits: FULL_LIMITS,
      })).rejects.toThrow("reservation costMicrounits must be a PostgreSQL bigint");
      const [counts] = await isolated.sql<{ guards: number; buckets: number }[]>`
        select
          (select count(*)::int from project_recovery_guards where project_id = ${fixture.projectId}) as guards,
          (select count(*)::int from project_recovery_buckets where project_id = ${fixture.projectId}) as buckets
      `;
      expect(counts).toEqual({ guards: 0, buckets: 0 });
    }
  });

  test("invalid number-backed reservation deltas are rejected before a transaction", async () => {
    const cases = [
      { label: "cycles_max_plus_one", field: "cycles", value: POSTGRES_INTEGER_MAX + 1 },
      { label: "cycles_wrong_type", field: "cycles", value: "1" },
      { label: "cycles_fraction", field: "cycles", value: 1.5 },
      { label: "cycles_negative", field: "cycles", value: -1 },
      { label: "cycles_nan", field: "cycles", value: Number.NaN },
      { label: "cycles_infinity", field: "cycles", value: Number.POSITIVE_INFINITY },
      { label: "calls_max_plus_one", field: "calls", value: POSTGRES_INTEGER_MAX + 1 },
      { label: "calls_wrong_type", field: "calls", value: "1" },
      { label: "calls_fraction", field: "calls", value: 1.5 },
      { label: "calls_negative", field: "calls", value: -1 },
      { label: "calls_nan", field: "calls", value: Number.NaN },
      { label: "calls_infinity", field: "calls", value: Number.POSITIVE_INFINITY },
      { label: "audio_max_plus_one", field: "audioMs", value: Number.MAX_SAFE_INTEGER + 1 },
      { label: "audio_wrong_type", field: "audioMs", value: "60000" },
      { label: "audio_fraction", field: "audioMs", value: 1.5 },
      { label: "audio_negative", field: "audioMs", value: -1 },
      { label: "audio_nan", field: "audioMs", value: Number.NaN },
      { label: "audio_infinity", field: "audioMs", value: Number.POSITIVE_INFINITY },
    ] as const;

    for (const fixture of cases) {
      const projectId = `prj_budget_delta_${fixture.label}`;
      await addProject(projectId);
      const { trackedDb, transactionCalls } = trackTransactions();
      await expect(reserveProjectRecoveryBudget(trackedDb, {
        projectId,
        kind: "manual",
        reservation: { ...ONE, [fixture.field]: fixture.value } as RecoveryBudgetReservation,
        limits: FULL_LIMITS,
      })).rejects.toThrow("reservation values must be nonnegative safe integers");
      expect(transactionCalls()).toBe(0);
    }
  });

  test("exact reservation maxima write safely and one more unit rejects without overflowing", async () => {
    const cases = [
      {
        projectId: "prj_budget_cycles_storage_max",
        reservation: { cycles: POSTGRES_INTEGER_MAX, calls: 0, audioMs: 0, costMicrounits: 0n },
        delta: { cycles: 1, calls: 0, audioMs: 0, costMicrounits: 0n },
        limits: { ...FULL_LIMITS, manualCycles: POSTGRES_INTEGER_MAX },
        reason: "manual_cycles_exhausted",
      },
      {
        projectId: "prj_budget_calls_storage_max",
        reservation: { cycles: 0, calls: POSTGRES_INTEGER_MAX, audioMs: 0, costMicrounits: 0n },
        delta: { cycles: 0, calls: 1, audioMs: 0, costMicrounits: 0n },
        limits: { ...FULL_LIMITS, sharedCalls: POSTGRES_INTEGER_MAX },
        reason: "shared_calls_exhausted",
      },
      {
        projectId: "prj_budget_audio_storage_max",
        reservation: { cycles: 0, calls: 0, audioMs: Number.MAX_SAFE_INTEGER, costMicrounits: 0n },
        delta: { cycles: 0, calls: 0, audioMs: 1, costMicrounits: 0n },
        limits: { ...FULL_LIMITS, sharedAudioMs: Number.MAX_SAFE_INTEGER },
        reason: "shared_audio_exhausted",
      },
      {
        projectId: "prj_budget_cost_storage_max",
        reservation: { cycles: 0, calls: 0, audioMs: 0, costMicrounits: POSTGRES_BIGINT_MAX },
        delta: { cycles: 0, calls: 0, audioMs: 0, costMicrounits: 1n },
        limits: { ...FULL_LIMITS, sharedCostMicrounits: POSTGRES_BIGINT_MAX },
        reason: "shared_cost_exhausted",
      },
    ] as const;

    for (const fixture of cases) {
      await addProject(fixture.projectId);
      expect(await reserveProjectRecoveryBudget(db, {
        projectId: fixture.projectId,
        kind: "manual",
        reservation: fixture.reservation,
        limits: fixture.limits,
      })).toMatchObject({ accepted: true });
      expect(await reserveProjectRecoveryBudget(db, {
        projectId: fixture.projectId,
        kind: "manual",
        reservation: fixture.delta,
        limits: fixture.limits,
      })).toEqual({ accepted: false, reason: fixture.reason });
    }
  });

  test("out-of-PostgreSQL-range aggregates are rejected", async () => {
    const projectId = "prj_budget_aggregate_out_of_range";
    await addProject(projectId);
    const [clock] = await isolated.sql<{ minute: Date }[]>`
      select date_trunc('minute', clock_timestamp() at time zone 'UTC') at time zone 'UTC' as minute
    `;
    await isolated.sql`
      insert into project_recovery_buckets
        (project_id, bucket_minute, reserved_cost_microunits)
      values
        (${projectId}, ${clock!.minute}, ${POSTGRES_BIGINT_MAX}),
        (${projectId}, ${new Date(clock!.minute.getTime() - 60_000)}, ${POSTGRES_BIGINT_MAX})
    `;
    await expect(reserveProjectRecoveryBudget(db, {
      projectId,
      kind: "manual",
      reservation: { cycles: 0, calls: 0, audioMs: 0, costMicrounits: 0n },
      limits: { ...FULL_LIMITS, sharedCostMicrounits: POSTGRES_BIGINT_MAX },
    })).rejects.toThrow("invalid database aggregate: reservedCostMicrounits");
  });

  test("concurrent manual reservations serialize on the project guard", async () => {
    const projectId = "prj_budget_concurrent";
    await addProject(projectId);
    const input = {
      projectId,
      kind: "manual" as const,
      reservation: ONE,
      limits: { ...FULL_LIMITS, manualCycles: 1 },
    };
    const results = await Promise.all([
      reserveProjectRecoveryBudget(db, input),
      reserveProjectRecoveryBudget(db, input),
    ]);
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => !result.accepted)).toEqual([
      { accepted: false, reason: "manual_cycles_exhausted" },
    ]);
    const [bucket] = await isolated.sql<{
      manual_cycles: number;
      automatic_cycles: number;
      reserved_calls: number;
      reserved_audio_ms: number;
      reserved_cost_microunits: bigint;
    }[]>`
      select manual_cycles, automatic_cycles, reserved_calls, reserved_audio_ms,
             reserved_cost_microunits
      from project_recovery_buckets where project_id = ${projectId}
    `;
    expect({
      ...bucket,
      reserved_audio_ms: Number(bucket!.reserved_audio_ms),
      reserved_cost_microunits: Number(bucket!.reserved_cost_microunits),
    }).toEqual({
      manual_cycles: 1,
      automatic_cycles: 0,
      reserved_calls: 1,
      reserved_audio_ms: 60_000,
      reserved_cost_microunits: 100,
    });
  });

  test("automatic cycles have an independent fail-closed allocation", async () => {
    const projectId = "prj_budget_automatic_zero";
    await addProject(projectId);
    expect(await reserveProjectRecoveryBudget(db, {
      projectId,
      kind: "automatic",
      reservation: ONE,
      limits: { ...FULL_LIMITS, automaticCycles: 0 },
    })).toEqual({ accepted: false, reason: "automatic_cycles_exhausted" });
    const [count] = await isolated.sql<{ count: number }[]>`
      select count(*)::int as count from project_recovery_buckets where project_id = ${projectId}
    `;
    expect(count!.count).toBe(0);
  });

  test("manual and automatic allocations remain separate while shared calls/audio/cost reject atomically", async () => {
    const projectId = "prj_budget_shared";
    await addProject(projectId);
    expect(await reserveProjectRecoveryBudget(db, {
      projectId,
      kind: "manual",
      reservation: { cycles: 1, calls: 2, audioMs: 120_000, costMicrounits: 200n },
      limits: FULL_LIMITS,
    })).toMatchObject({ accepted: true });

    const rejected = await reserveProjectRecoveryBudget(db, {
      projectId,
      kind: "automatic",
      reservation: { cycles: 1, calls: 2, audioMs: 120_000, costMicrounits: 200n },
      limits: FULL_LIMITS,
    });
    expect(rejected).toEqual({ accepted: false, reason: "shared_calls_exhausted" });

    const [bucket] = await isolated.sql<{
      manual_cycles: number;
      automatic_cycles: number;
      reserved_calls: number;
      reserved_audio_ms: number;
      reserved_cost_microunits: bigint;
    }[]>`
      select manual_cycles, automatic_cycles, reserved_calls, reserved_audio_ms,
             reserved_cost_microunits
      from project_recovery_buckets where project_id = ${projectId}
    `;
    expect({
      ...bucket,
      reserved_audio_ms: Number(bucket!.reserved_audio_ms),
      reserved_cost_microunits: Number(bucket!.reserved_cost_microunits),
    }).toEqual({
      manual_cycles: 1,
      automatic_cycles: 0,
      reserved_calls: 2,
      reserved_audio_ms: 120_000,
      reserved_cost_microunits: 200,
    });
  });

  test("shared audio and cost ceilings are independently enforced", async () => {
    const cases = [
      {
        projectId: "prj_budget_audio",
        reservation: { ...ONE, audioMs: 60_001 },
        limits: { ...FULL_LIMITS, sharedAudioMs: 60_000 },
        reason: "shared_audio_exhausted",
      },
      {
        projectId: "prj_budget_cost",
        reservation: { ...ONE, costMicrounits: 101n },
        limits: { ...FULL_LIMITS, sharedCostMicrounits: 100n },
        reason: "shared_cost_exhausted",
      },
    ] as const;
    for (const fixture of cases) {
      await addProject(fixture.projectId);
      expect(await reserveProjectRecoveryBudget(db, {
        projectId: fixture.projectId,
        kind: "automatic",
        reservation: fixture.reservation,
        limits: fixture.limits,
      })).toEqual({ accepted: false, reason: fixture.reason });
      const [count] = await isolated.sql<{ count: number }[]>`
        select count(*)::int as count from project_recovery_buckets where project_id = ${fixture.projectId}
      `;
      expect(count!.count).toBe(0);
    }
  });

  test("exact shared call, audio, and cost boundaries accept, then one more unit rejects", async () => {
    const cases = [
      {
        projectId: "prj_budget_calls_boundary",
        reservation: { cycles: 1, calls: 3, audioMs: 0, costMicrounits: 0n },
        delta: { cycles: 0, calls: 1, audioMs: 0, costMicrounits: 0n },
        reason: "shared_calls_exhausted",
      },
      {
        projectId: "prj_budget_audio_boundary",
        reservation: { cycles: 1, calls: 0, audioMs: 180_000, costMicrounits: 0n },
        delta: { cycles: 0, calls: 0, audioMs: 1, costMicrounits: 0n },
        reason: "shared_audio_exhausted",
      },
      {
        projectId: "prj_budget_cost_boundary",
        reservation: { cycles: 1, calls: 0, audioMs: 0, costMicrounits: 300n },
        delta: { cycles: 0, calls: 0, audioMs: 0, costMicrounits: 1n },
        reason: "shared_cost_exhausted",
      },
    ] as const;
    for (const fixture of cases) {
      await addProject(fixture.projectId);
      expect(await reserveProjectRecoveryBudget(db, {
        projectId: fixture.projectId,
        kind: "manual",
        reservation: fixture.reservation,
        limits: FULL_LIMITS,
      })).toMatchObject({ accepted: true });
      expect(await reserveProjectRecoveryBudget(db, {
        projectId: fixture.projectId,
        kind: "manual",
        reservation: fixture.delta,
        limits: FULL_LIMITS,
      })).toEqual({ accepted: false, reason: fixture.reason });
    }
  });

  test("the whole oldest UTC minute is conservatively included without extending another minute", async () => {
    const includedProject = "prj_budget_oldest_included";
    const excludedProject = "prj_budget_oldest_excluded";
    await addProject(includedProject);
    await addProject(excludedProject);
    const [clock] = await isolated.sql<{ minute: Date }[]>`
      select date_trunc('minute', clock_timestamp() at time zone 'UTC') at time zone 'UTC' as minute
    `;
    await isolated.sql`
      insert into project_recovery_buckets
        (project_id, bucket_minute, manual_cycles, reserved_calls, reserved_audio_ms, reserved_cost_microunits)
      values
        (${includedProject}, ${clock!.minute}, ${0}, ${0}, ${0}, ${0}),
        (${includedProject}, ${new Date(clock!.minute.getTime() - 1_440 * 60_000)}, ${0}, ${1}, ${0}, ${0}),
        (${excludedProject}, ${new Date(clock!.minute.getTime() - 1_441 * 60_000)}, ${0}, ${1}, ${0}, ${0})
    `;
    const limits = { ...FULL_LIMITS, sharedCalls: 1 };
    expect(await reserveProjectRecoveryBudget(db, {
      projectId: includedProject,
      kind: "manual",
      reservation: { ...ONE, audioMs: 0, costMicrounits: 0n },
      limits,
    })).toEqual({ accepted: false, reason: "shared_calls_exhausted" });
    expect(await reserveProjectRecoveryBudget(db, {
      projectId: excludedProject,
      kind: "manual",
      reservation: { ...ONE, audioMs: 0, costMicrounits: 0n },
      limits,
    })).toMatchObject({ accepted: true });
  });
});
