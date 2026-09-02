import { and, eq, gte, lte, sql, sum } from "drizzle-orm";
import type { Db } from "./client.ts";
import { projectRecoveryBuckets, projectRecoveryGuards } from "./schema.ts";

export type RecoveryBudgetKind = "manual" | "automatic";

/** Every value is operator-owned. `null` means unset and must fail closed. */
export interface RecoveryBudgetLimits {
  manualCycles: number | null;
  automaticCycles: number | null;
  sharedCalls: number | null;
  sharedAudioMs: number | null;
  sharedCostMicrounits: bigint | null;
}

interface ResolvedRecoveryBudgetLimits {
  manualCycles: number;
  automaticCycles: number;
  sharedCalls: number;
  sharedAudioMs: number;
  sharedCostMicrounits: bigint;
}

export interface RecoveryBudgetReservation {
  cycles: number;
  calls: number;
  audioMs: number;
  costMicrounits: bigint;
}

export type RecoveryBudgetRejectionReason =
  | "limits_unset"
  | "manual_cycles_exhausted"
  | "automatic_cycles_exhausted"
  | "shared_calls_exhausted"
  | "shared_audio_exhausted"
  | "shared_cost_exhausted";

export type RecoveryBudgetReservationResult =
  | {
      accepted: true;
      bucketMinute: Date;
      totals: {
        manualCycles: number;
        automaticCycles: number;
        reservedCalls: number;
        reservedAudioMs: number;
        reservedCostMicrounits: bigint;
      };
    }
  | { accepted: false; reason: RecoveryBudgetRejectionReason };

export interface ReserveProjectRecoveryBudgetInput {
  projectId: string;
  kind: RecoveryBudgetKind;
  reservation: RecoveryBudgetReservation;
  limits: RecoveryBudgetLimits;
}

const ROLLING_WINDOW_MINUTES = 1_440;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export class RecoveryBudgetRejected extends Error {
  constructor(readonly reason: RecoveryBudgetRejectionReason) {
    super(reason);
  }
}

export type RecoveryBudgetTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPostgresInteger(value: unknown): value is number {
  return isNonnegativeSafeInteger(value) && value <= POSTGRES_INTEGER_MAX;
}

function isPostgresBigint(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n && value <= POSTGRES_BIGINT_MAX;
}

function limitsAreSet(limits: RecoveryBudgetLimits): limits is ResolvedRecoveryBudgetLimits {
  return limits.manualCycles !== null
    && limits.automaticCycles !== null
    && limits.sharedCalls !== null
    && limits.sharedAudioMs !== null
    && limits.sharedCostMicrounits !== null
    && isPostgresInteger(limits.manualCycles)
    && isPostgresInteger(limits.automaticCycles)
    && isPostgresInteger(limits.sharedCalls)
    && isNonnegativeSafeInteger(limits.sharedAudioMs)
    && isPostgresBigint(limits.sharedCostMicrounits);
}

function validateReservation(input: ReserveProjectRecoveryBudgetInput): void {
  if (typeof input.projectId !== "string" || !input.projectId || input.projectId.length > 128) {
    throw new Error("projectId must be bounded");
  }
  if (input.kind !== "manual" && input.kind !== "automatic") {
    throw new Error("kind must be manual or automatic");
  }
  if (
    !isPostgresInteger(input.reservation.cycles)
    || !isPostgresInteger(input.reservation.calls)
    || !isNonnegativeSafeInteger(input.reservation.audioMs)
  ) {
    throw new Error("reservation values must be nonnegative safe integers");
  }
  if (!isPostgresBigint(input.reservation.costMicrounits)) {
    throw new Error("reservation costMicrounits must be a PostgreSQL bigint");
  }
}

function aggregateBigint(value: unknown, field: string): bigint {
  if (value === null || value === undefined) return 0n;
  try {
    let parsed: bigint;
    if (typeof value === "bigint") {
      parsed = value;
    } else if (typeof value === "number" && Number.isSafeInteger(value)) {
      parsed = BigInt(value);
    } else if (typeof value === "string" && /^-?\d+$/.test(value)) {
      parsed = BigInt(value);
    } else {
      throw new Error("invalid aggregate type");
    }
    if (parsed < 0n || parsed > POSTGRES_BIGINT_MAX) throw new Error("aggregate out of range");
    return parsed;
  } catch {
    throw new Error(`invalid database aggregate: ${field}`);
  }
}

/**
 * Atomically reserves one recovery budget slice under a per-project row lock.
 *
 * The database supplies the current UTC minute. The inclusive lower bound intentionally counts
 * the current bucket plus the preceding 1,440 buckets, conservatively retaining the
 * whole oldest minute. Any rejection thrown after taking the guard lock rolls the transaction
 * back, including first-use guard creation.
 */
export async function reserveProjectRecoveryBudget(
  db: Db,
  input: ReserveProjectRecoveryBudgetInput,
): Promise<RecoveryBudgetReservationResult> {
  // Preserve the A2 wrapper contract: malformed/unset input never opens a transaction.
  validateReservation(input);
  if (!limitsAreSet(input.limits)) return { accepted: false, reason: "limits_unset" };
  try {
    return await db.transaction((tx) => reserveProjectRecoveryBudgetInTransaction(tx, input));
  } catch (error) {
    if (error instanceof RecoveryBudgetRejected) return { accepted: false, reason: error.reason };
    throw error;
  }
}

/**
 * Read-only admission preview used to avoid a metadata-provider call when the current durable
 * window is already exhausted. The caller must still reserve under the project lock later.
 */
export async function inspectProjectRecoveryBudget(
  db: Db,
  input: ReserveProjectRecoveryBudgetInput,
): Promise<RecoveryBudgetReservationResult> {
  validateReservation(input);
  if (!limitsAreSet(input.limits)) return { accepted: false, reason: "limits_unset" };
  const limits = input.limits;
  const [usage] = await db
    .select({
      bucketMinute: sql<Date>`date_trunc('minute', clock_timestamp() at time zone 'UTC') at time zone 'UTC'`,
      manualCycles: sum(projectRecoveryBuckets.manualCycles),
      automaticCycles: sum(projectRecoveryBuckets.automaticCycles),
      reservedCalls: sum(projectRecoveryBuckets.reservedCalls),
      spentCalls: sum(projectRecoveryBuckets.spentCalls),
      reservedAudioMs: sum(projectRecoveryBuckets.reservedAudioMs),
      spentAudioMs: sum(projectRecoveryBuckets.spentAudioMs),
      reservedCostMicrounits: sum(projectRecoveryBuckets.reservedCostMicrounits),
      spentCostMicrounits: sum(projectRecoveryBuckets.spentCostMicrounits),
    })
    .from(projectRecoveryBuckets)
    .where(and(
      eq(projectRecoveryBuckets.projectId, input.projectId),
      gte(
        projectRecoveryBuckets.bucketMinute,
        sql<Date>`date_trunc('minute', clock_timestamp() at time zone 'UTC') at time zone 'UTC' - interval '1440 minutes'`,
      ),
      lte(
        projectRecoveryBuckets.bucketMinute,
        sql<Date>`date_trunc('minute', clock_timestamp() at time zone 'UTC') at time zone 'UTC'`,
      ),
    ));

  const manualCycles = aggregateBigint(usage?.manualCycles, "manualCycles");
  const automaticCycles = aggregateBigint(usage?.automaticCycles, "automaticCycles");
  const reservedCalls = aggregateBigint(usage?.reservedCalls, "reservedCalls");
  const spentCalls = aggregateBigint(usage?.spentCalls, "spentCalls");
  const reservedAudioMs = aggregateBigint(usage?.reservedAudioMs, "reservedAudioMs");
  const spentAudioMs = aggregateBigint(usage?.spentAudioMs, "spentAudioMs");
  const reservedCostMicrounits = aggregateBigint(usage?.reservedCostMicrounits, "reservedCostMicrounits");
  const spentCostMicrounits = aggregateBigint(usage?.spentCostMicrounits, "spentCostMicrounits");
  const cycleDelta = BigInt(input.reservation.cycles);
  const nextManualCycles = manualCycles + (input.kind === "manual" ? cycleDelta : 0n);
  const nextAutomaticCycles = automaticCycles + (input.kind === "automatic" ? cycleDelta : 0n);
  const nextCalls = reservedCalls + spentCalls + BigInt(input.reservation.calls);
  const nextAudioMs = reservedAudioMs + spentAudioMs + BigInt(input.reservation.audioMs);
  const nextCostMicrounits = reservedCostMicrounits + spentCostMicrounits + input.reservation.costMicrounits;

  if (nextManualCycles > BigInt(limits.manualCycles)) return { accepted: false, reason: "manual_cycles_exhausted" };
  if (nextAutomaticCycles > BigInt(limits.automaticCycles)) return { accepted: false, reason: "automatic_cycles_exhausted" };
  if (nextCalls > BigInt(limits.sharedCalls)) return { accepted: false, reason: "shared_calls_exhausted" };
  if (nextAudioMs > BigInt(limits.sharedAudioMs)) return { accepted: false, reason: "shared_audio_exhausted" };
  if (nextCostMicrounits > limits.sharedCostMicrounits) return { accepted: false, reason: "shared_cost_exhausted" };
  return {
    accepted: true,
    bucketMinute: usage?.bucketMinute ?? new Date(0),
    totals: {
      manualCycles: Number(nextManualCycles),
      automaticCycles: Number(nextAutomaticCycles),
      reservedCalls: Number(reservedCalls + BigInt(input.reservation.calls)),
      reservedAudioMs: Number(reservedAudioMs + BigInt(input.reservation.audioMs)),
      reservedCostMicrounits: reservedCostMicrounits + input.reservation.costMicrounits,
    },
  };
}

/**
 * The A2 reservation primitive inside a caller-owned transaction. Rejections throw so the caller
 * cannot accidentally commit the first-use guard row while reporting a rejected reservation.
 */
export async function reserveProjectRecoveryBudgetInTransaction(
  tx: RecoveryBudgetTransaction,
  input: ReserveProjectRecoveryBudgetInput,
): Promise<Extract<RecoveryBudgetReservationResult, { accepted: true }>> {
  validateReservation(input);
  if (!limitsAreSet(input.limits)) throw new RecoveryBudgetRejected("limits_unset");
  const limits = input.limits;

  await tx.insert(projectRecoveryGuards).values({ projectId: input.projectId }).onConflictDoNothing();
  const [clock] = await tx
    .select({
      bucketMinute: sql<Date>`date_trunc('minute', clock_timestamp() at time zone 'UTC') at time zone 'UTC'`,
    })
    .from(projectRecoveryGuards)
    .where(eq(projectRecoveryGuards.projectId, input.projectId))
    .for("update");
  if (!clock) throw new Error("project recovery guard was not created");

  const windowStart = new Date(clock.bucketMinute.getTime() - ROLLING_WINDOW_MINUTES * 60_000);
  const [usage] = await tx
    .select({
      manualCycles: sum(projectRecoveryBuckets.manualCycles),
      automaticCycles: sum(projectRecoveryBuckets.automaticCycles),
      reservedCalls: sum(projectRecoveryBuckets.reservedCalls),
      spentCalls: sum(projectRecoveryBuckets.spentCalls),
      reservedAudioMs: sum(projectRecoveryBuckets.reservedAudioMs),
      spentAudioMs: sum(projectRecoveryBuckets.spentAudioMs),
      reservedCostMicrounits: sum(projectRecoveryBuckets.reservedCostMicrounits),
      spentCostMicrounits: sum(projectRecoveryBuckets.spentCostMicrounits),
    })
    .from(projectRecoveryBuckets)
    .where(and(
      eq(projectRecoveryBuckets.projectId, input.projectId),
      gte(projectRecoveryBuckets.bucketMinute, windowStart),
      lte(projectRecoveryBuckets.bucketMinute, clock.bucketMinute),
    ));

  const manualCycles = aggregateBigint(usage?.manualCycles, "manualCycles");
  const automaticCycles = aggregateBigint(usage?.automaticCycles, "automaticCycles");
  const reservedCalls = aggregateBigint(usage?.reservedCalls, "reservedCalls");
  const spentCalls = aggregateBigint(usage?.spentCalls, "spentCalls");
  const reservedAudioMs = aggregateBigint(usage?.reservedAudioMs, "reservedAudioMs");
  const spentAudioMs = aggregateBigint(usage?.spentAudioMs, "spentAudioMs");
  const reservedCostMicrounits = aggregateBigint(usage?.reservedCostMicrounits, "reservedCostMicrounits");
  const spentCostMicrounits = aggregateBigint(usage?.spentCostMicrounits, "spentCostMicrounits");
  const cycleDelta = BigInt(input.reservation.cycles);
  const nextManualCycles = manualCycles + (input.kind === "manual" ? cycleDelta : 0n);
  const nextAutomaticCycles = automaticCycles + (input.kind === "automatic" ? cycleDelta : 0n);
  const nextCalls = reservedCalls + spentCalls + BigInt(input.reservation.calls);
  const nextAudioMs = reservedAudioMs + spentAudioMs + BigInt(input.reservation.audioMs);
  const nextCostMicrounits = reservedCostMicrounits + spentCostMicrounits + input.reservation.costMicrounits;

  if (nextManualCycles > BigInt(limits.manualCycles)) throw new RecoveryBudgetRejected("manual_cycles_exhausted");
  if (nextAutomaticCycles > BigInt(limits.automaticCycles)) throw new RecoveryBudgetRejected("automatic_cycles_exhausted");
  if (nextCalls > BigInt(limits.sharedCalls)) throw new RecoveryBudgetRejected("shared_calls_exhausted");
  if (nextAudioMs > BigInt(limits.sharedAudioMs)) throw new RecoveryBudgetRejected("shared_audio_exhausted");
  if (nextCostMicrounits > limits.sharedCostMicrounits) throw new RecoveryBudgetRejected("shared_cost_exhausted");

  const manualIncrement = input.kind === "manual" ? input.reservation.cycles : 0;
  const automaticIncrement = input.kind === "automatic" ? input.reservation.cycles : 0;
  await tx
    .insert(projectRecoveryBuckets)
    .values({
      projectId: input.projectId,
      bucketMinute: clock.bucketMinute,
      manualCycles: manualIncrement,
      automaticCycles: automaticIncrement,
      reservedCalls: input.reservation.calls,
      reservedAudioMs: input.reservation.audioMs,
      reservedCostMicrounits: input.reservation.costMicrounits,
    })
    .onConflictDoUpdate({
      target: [projectRecoveryBuckets.projectId, projectRecoveryBuckets.bucketMinute],
      set: {
        manualCycles: sql`${projectRecoveryBuckets.manualCycles} + ${manualIncrement}`,
        automaticCycles: sql`${projectRecoveryBuckets.automaticCycles} + ${automaticIncrement}`,
        reservedCalls: sql`${projectRecoveryBuckets.reservedCalls} + ${input.reservation.calls}`,
        reservedAudioMs: sql`${projectRecoveryBuckets.reservedAudioMs} + ${input.reservation.audioMs}`,
        reservedCostMicrounits: sql`${projectRecoveryBuckets.reservedCostMicrounits} + ${input.reservation.costMicrounits}`,
        updatedAt: sql`clock_timestamp()`,
      },
    });

  return {
    accepted: true,
    bucketMinute: clock.bucketMinute,
    totals: {
      manualCycles: Number(nextManualCycles),
      automaticCycles: Number(nextAutomaticCycles),
      reservedCalls: Number(reservedCalls + BigInt(input.reservation.calls)),
      reservedAudioMs: Number(reservedAudioMs + BigInt(input.reservation.audioMs)),
      reservedCostMicrounits: reservedCostMicrounits + input.reservation.costMicrounits,
    },
  };
}
