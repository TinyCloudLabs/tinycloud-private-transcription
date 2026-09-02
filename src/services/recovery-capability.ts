import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "../db/client.ts";
import { serviceCapabilityLeases } from "../db/schema.ts";
import {
  createRecoveryConfiguration,
  type RecoveryConfiguration,
} from "../recovery-config.ts";
import {
  recoveryOperationalReadinessIsReady,
  type RecoveryOperationalReadiness,
  type RecoveryOperationalReadinessSource,
} from "./recovery-readiness.ts";

const BOUNDED_OWNER = /^[\x21-\x7e]{1,128}$/;
const BOUNDED_REVISION = /^[A-Za-z0-9._:-]{1,128}$/;
const BOUNDED_VERSION = /^[A-Za-z0-9._:-]{1,64}$/;

const ownerHash = (owner: string): string => createHash("sha256").update(owner).digest("hex");
const positiveDuration = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

interface CapabilityLeaseOwner {
  component: "api" | "worker";
  owner: string;
}

interface CapabilityLeaseIdentity extends CapabilityLeaseOwner {
  leaseMs: number;
}

export interface AcquireCapabilityLeaseInput extends CapabilityLeaseIdentity {
  db: Db;
  buildRevision: string;
  contractVersion: string;
  finalizerVersion: string;
  schemaVersion: string;
  configVersion: string;
}

export interface CapabilityLeaseClaim {
  fence: number;
  expiresAt: Date;
}

function assertLeaseIdentity(input: CapabilityLeaseIdentity): void {
  if (!BOUNDED_OWNER.test(input.owner) || !positiveDuration(input.leaseMs)) {
    throw new TypeError("invalid capability lease identity");
  }
}

function assertLeaseOwner(input: CapabilityLeaseOwner): void {
  if (!BOUNDED_OWNER.test(input.owner)) throw new TypeError("invalid capability lease owner");
}

function assertLeaseVersions(input: AcquireCapabilityLeaseInput): void {
  if (!BOUNDED_REVISION.test(input.buildRevision)
    || !BOUNDED_VERSION.test(input.contractVersion)
    || !BOUNDED_VERSION.test(input.finalizerVersion)
    || !BOUNDED_VERSION.test(input.schemaVersion)
    || !BOUNDED_REVISION.test(input.configVersion)) {
    throw new TypeError("invalid capability lease revision");
  }
}

/** Acquire or take over an expired component lease using database time. */
export async function acquireServiceCapabilityLease(
  input: AcquireCapabilityLeaseInput,
): Promise<CapabilityLeaseClaim | null> {
  assertLeaseIdentity(input);
  assertLeaseVersions(input);
  const hash = ownerHash(input.owner);
  const rows = await input.db.$client<{ lease_fence: number; lease_expires_at: Date }[]>`
    insert into service_capability_leases (
      component, lease_owner_hash, build_revision, contract_version, finalizer_version,
      schema_version, config_version, lease_expires_at, heartbeat_at, lease_fence,
      created_at, updated_at
    ) values (
      ${input.component}, ${hash}, ${input.buildRevision}, ${input.contractVersion},
      ${input.finalizerVersion}, ${input.schemaVersion}, ${input.configVersion},
      clock_timestamp() + (${input.leaseMs}::text || ' milliseconds')::interval,
      clock_timestamp(), 1, clock_timestamp(), clock_timestamp()
    )
    on conflict (component) do update set
      lease_owner_hash = excluded.lease_owner_hash,
      build_revision = excluded.build_revision,
      contract_version = excluded.contract_version,
      finalizer_version = excluded.finalizer_version,
      schema_version = excluded.schema_version,
      config_version = excluded.config_version,
      lease_expires_at = excluded.lease_expires_at,
      heartbeat_at = clock_timestamp(),
      lease_fence = service_capability_leases.lease_fence + 1,
      updated_at = clock_timestamp()
    where service_capability_leases.lease_expires_at <= clock_timestamp()
       or service_capability_leases.lease_owner_hash = excluded.lease_owner_hash
    returning lease_fence::int, lease_expires_at
  `;
  const row = rows[0];
  return row ? { fence: row.lease_fence, expiresAt: row.lease_expires_at } : null;
}

export interface HeartbeatCapabilityLeaseInput extends CapabilityLeaseIdentity {
  db: Db;
  fence: number;
}

/** Extend only the still-fresh lease held by this exact owner and fence. */
export async function heartbeatServiceCapabilityLease(
  input: HeartbeatCapabilityLeaseInput,
): Promise<boolean> {
  assertLeaseIdentity(input);
  if (!Number.isSafeInteger(input.fence) || input.fence <= 0) return false;
  const [row] = await input.db.update(serviceCapabilityLeases).set({
    heartbeatAt: sql`clock_timestamp()`,
    leaseExpiresAt: sql`clock_timestamp() + (${input.leaseMs}::text || ' milliseconds')::interval`,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(
    eq(serviceCapabilityLeases.component, input.component),
    eq(serviceCapabilityLeases.leaseOwnerHash, ownerHash(input.owner)),
    eq(serviceCapabilityLeases.leaseFence, input.fence),
    sql`${serviceCapabilityLeases.leaseExpiresAt} > clock_timestamp()`,
  )).returning({ component: serviceCapabilityLeases.component });
  return row !== undefined;
}

export interface WithdrawCapabilityLeaseInput extends CapabilityLeaseOwner {
  db: Db;
  fence: number;
}

/** Expire an exact component lease atomically using database time. */
export async function withdrawServiceCapabilityLease(
  input: WithdrawCapabilityLeaseInput,
): Promise<boolean> {
  assertLeaseOwner(input);
  if (!Number.isSafeInteger(input.fence) || input.fence <= 0) return false;
  const [row] = await input.db.update(serviceCapabilityLeases).set({
    heartbeatAt: sql`clock_timestamp()`,
    leaseExpiresAt: sql`clock_timestamp()`,
    updatedAt: sql`clock_timestamp()`,
  }).where(and(
    eq(serviceCapabilityLeases.component, input.component),
    eq(serviceCapabilityLeases.leaseOwnerHash, ownerHash(input.owner)),
    eq(serviceCapabilityLeases.leaseFence, input.fence),
  )).returning({ component: serviceCapabilityLeases.component });
  return row !== undefined;
}

/** Readiness only; no public route is activated by A4. Missing or mismatched data is false. */
export async function recoveryCapabilityReady(
  db: Db,
  requirements: RecoveryOperationalReadiness,
): Promise<boolean> {
  if (!recoveryOperationalReadinessIsReady(requirements)) return false;
  const rows = await db.select({
    lease: serviceCapabilityLeases,
    databaseNow: sql<Date>`clock_timestamp()`,
  }).from(serviceCapabilityLeases)
    .where(sql`${serviceCapabilityLeases.component} in ('api', 'worker')`);
  if (rows.length !== 2) return false;
  const api = rows.find((row) => row.lease.component === "api");
  const worker = rows.find((row) => row.lease.component === "worker");
  const compatible = (
    row: typeof rows[number] | undefined,
    buildRevision: string,
    contractVersion: string,
  ): boolean => !!row
    && row.lease.leaseExpiresAt.getTime() > row.databaseNow.getTime()
    && row.lease.buildRevision === buildRevision
    && row.lease.contractVersion === contractVersion
    && row.lease.finalizerVersion === requirements.finalizerVersion
    && row.lease.schemaVersion === requirements.schemaVersion
    && row.lease.configVersion === requirements.configVersion;
  return compatible(api, requirements.apiBuildRevision!, requirements.apiContractVersion!)
    && compatible(worker, requirements.workerBuildRevision!, requirements.workerContractVersion!);
}

type CapabilityRuntimeEnvironment = Record<string, string | undefined>;

export interface ProductionCapabilityHeartbeatHandle {
  ready: Promise<boolean>;
  stop(): Promise<void>;
}

/** Production heartbeat seam. It writes no lease unless every operational gate and revision is ready. */
export function startProductionCapabilityHeartbeat(input: {
  db: Db;
  component: "api" | "worker";
  owner: string;
  environment: CapabilityRuntimeEnvironment;
  recoveryConfiguration?: RecoveryConfiguration;
  readinessSource: RecoveryOperationalReadinessSource;
}): ProductionCapabilityHeartbeatHandle | null {
  const recoveryConfiguration = "recoveryConfiguration" in input ? input.recoveryConfiguration : undefined;
  const configuration = recoveryConfiguration ?? createRecoveryConfiguration(input.environment);
  const { leaseMs, heartbeatMs } = configuration.capabilityTimings;
  if (leaseMs === null || heartbeatMs === null || heartbeatMs >= leaseMs) return null;
  assertLeaseIdentity({ component: input.component, owner: input.owner, leaseMs });

  let running = true;
  let releaseStop!: () => void;
  const stopped = new Promise<void>((resolve) => { releaseStop = resolve; });
  let resolveReady!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
  const loop = (async () => {
    let lease: CapabilityLeaseClaim | null = null;
    let advertisedVersions: string | null = null;
    let first = true;
    while (running) {
      try {
        const snapshot = input.readinessSource.read();
        const operational = recoveryOperationalReadinessIsReady(snapshot);
        const versions = operational ? JSON.stringify([
          input.component === "api" ? snapshot.apiBuildRevision : snapshot.workerBuildRevision,
          input.component === "api" ? snapshot.apiContractVersion : snapshot.workerContractVersion,
          snapshot.finalizerVersion,
          snapshot.schemaVersion,
          snapshot.configVersion,
        ]) : null;
        if (!operational || (lease && advertisedVersions !== versions)) {
          if (lease) await withdrawServiceCapabilityLease({
            db: input.db,
            component: input.component,
            owner: input.owner,
            fence: lease.fence,
          });
          lease = null;
          advertisedVersions = null;
        }
        if (operational && !lease) {
          lease = await acquireServiceCapabilityLease({
            db: input.db,
            component: input.component,
            owner: input.owner,
            leaseMs,
            buildRevision: (input.component === "api" ? snapshot.apiBuildRevision : snapshot.workerBuildRevision)!,
            contractVersion: (input.component === "api" ? snapshot.apiContractVersion : snapshot.workerContractVersion)!,
            finalizerVersion: snapshot.finalizerVersion!,
            schemaVersion: snapshot.schemaVersion!,
            configVersion: snapshot.configVersion!,
          });
          advertisedVersions = lease ? versions : null;
        } else if (operational && lease) {
          const fresh = await heartbeatServiceCapabilityLease({
            db: input.db,
            component: input.component,
            owner: input.owner,
            fence: lease.fence,
            leaseMs,
          });
          if (!fresh) {
            lease = null;
            advertisedVersions = null;
          }
        }
      } catch {
        if (lease) {
          try {
            await withdrawServiceCapabilityLease({
              db: input.db,
              component: input.component,
              owner: input.owner,
              fence: lease.fence,
            });
          } catch {}
        }
        lease = null;
        advertisedVersions = null;
      }
      if (first) {
        resolveReady(lease !== null);
        first = false;
      }
      await Promise.race([Bun.sleep(heartbeatMs), stopped]);
    }
    if (lease) {
      try {
        await withdrawServiceCapabilityLease({
          db: input.db,
          component: input.component,
          owner: input.owner,
          fence: lease.fence,
        });
      } catch {}
    }
  })();
  return {
    ready,
    async stop() {
      running = false;
      releaseStop();
      await loop;
    },
  };
}
