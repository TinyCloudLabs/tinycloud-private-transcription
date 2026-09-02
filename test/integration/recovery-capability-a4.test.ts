import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import {
  acquireServiceCapabilityLease,
  heartbeatServiceCapabilityLease,
  recoveryCapabilityReady,
  startProductionCapabilityHeartbeat,
  withdrawServiceCapabilityLease,
} from "../../src/services/recovery-capability.ts";
import {
  createProductionRecoveryReadinessSource,
  UNSET_RECOVERY_OPERATIONAL_READINESS,
  type RecoveryOperationalReadiness,
  type RecoveryOperationalReadinessSource,
} from "../../src/services/recovery-readiness.ts";
import { createIsolatedDatabase, type IsolatedDatabase } from "./a2-db.ts";

const REQUIREMENTS: RecoveryOperationalReadiness = {
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

setDefaultTimeout(30_000);

beforeEach(async () => {
  isolated = await createIsolatedDatabase("ptx_a4_capability");
  const migrationDb = await runMigrations(isolated.url);
  await migrationDb.$client.close();
  db = createDb(isolated.url);
});

afterEach(async () => {
  await db?.$client.close();
  await isolated?.drop();
});

describe("A4 database-time capability lease", () => {
  test("a live heartbeat withdraws for every dynamic readiness gate and both components must refresh after recovery", async () => {
    const current: RecoveryOperationalReadiness = {
      recoveryAcceptanceEnabled: true,
      maintenanceConfigured: true,
      providerEnabled: true,
      finalizerEnabled: true,
      dispatchAdapterReady: true,
      providerAdapterReady: true,
      a3BudgetConfigReady: true,
      bProviderConfigReady: true,
      bFinalizerConfigReady: true,
      apiBuildRevision: REQUIREMENTS.apiBuildRevision,
      workerBuildRevision: REQUIREMENTS.workerBuildRevision,
      apiContractVersion: REQUIREMENTS.apiContractVersion,
      workerContractVersion: REQUIREMENTS.workerContractVersion,
      finalizerVersion: REQUIREMENTS.finalizerVersion,
      schemaVersion: REQUIREMENTS.schemaVersion,
      configVersion: REQUIREMENTS.configVersion,
    };
    const source: RecoveryOperationalReadinessSource = { read: () => ({ ...current }) };
    const environment = {
      RECOVERY_CAPABILITY_LEASE_MS: "1000",
      RECOVERY_CAPABILITY_HEARTBEAT_MS: "10",
    };
    const api = startProductionCapabilityHeartbeat({
      db,
      component: "api",
      owner: "synthetic-dynamic-api",
      environment,
      readinessSource: source,
    });
    const worker = startProductionCapabilityHeartbeat({
      db,
      component: "worker",
      owner: "synthetic-dynamic-worker",
      environment,
      readinessSource: source,
    });
    expect(api).not.toBeNull();
    expect(worker).not.toBeNull();
    expect(await api!.ready).toBe(true);
    expect(await worker!.ready).toBe(true);
    expect(await recoveryCapabilityReady(db, source.read())).toBe(true);

    const falseCases: { name: string; apply(): void; restore(): void }[] = [
      ...([
        "recoveryAcceptanceEnabled",
        "maintenanceConfigured",
        "providerEnabled",
        "finalizerEnabled",
        "dispatchAdapterReady",
        "providerAdapterReady",
        "a3BudgetConfigReady",
        "bProviderConfigReady",
        "bFinalizerConfigReady",
      ] as const).map((field) => ({
        name: field,
        apply: () => { current[field] = false; },
        restore: () => { current[field] = true; },
      })),
      ...([
        ["apiBuildRevision", REQUIREMENTS.apiBuildRevision],
        ["workerBuildRevision", REQUIREMENTS.workerBuildRevision],
        ["apiContractVersion", REQUIREMENTS.apiContractVersion],
        ["workerContractVersion", REQUIREMENTS.workerContractVersion],
        ["finalizerVersion", REQUIREMENTS.finalizerVersion],
        ["schemaVersion", REQUIREMENTS.schemaVersion],
        ["configVersion", REQUIREMENTS.configVersion],
      ] as const).map(([field, restored]) => ({
        name: field,
        apply: () => { current[field] = null; },
        restore: () => { current[field] = restored; },
      })),
      {
        name: "contract mismatch",
        apply: () => { current.workerContractVersion = "mismatch"; },
        restore: () => { current.workerContractVersion = REQUIREMENTS.workerContractVersion; },
      },
    ];
    const waitFor = async (expected: boolean) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await recoveryCapabilityReady(db, source.read()) === expected) return;
        await Bun.sleep(5);
      }
      throw new Error(`readiness did not become ${expected}`);
    };
    for (const item of falseCases) {
      item.apply();
      let leases: { fresh: boolean }[] = [];
      for (let attempt = 0; attempt < 100; attempt += 1) {
        leases = await isolated.sql<{ fresh: boolean }[]>`
          select lease_expires_at > clock_timestamp() fresh
          from service_capability_leases order by component
        `;
        if (leases.length === 2 && leases.every((row) => !row.fresh)) break;
        await Bun.sleep(5);
      }
      expect(leases.map((row) => row.fresh), item.name).toEqual([false, false]);
      expect(await recoveryCapabilityReady(db, source.read())).toBe(false);
      item.restore();
      await waitFor(true);
    }
    await Promise.all([api!.stop(), worker!.stop()]);
  });

  test("bounded withdraw is atomic and requires the exact owner and fence", async () => {
    const lease = await acquireServiceCapabilityLease({
      db,
      component: "worker",
      owner: "synthetic-withdraw-owner",
      leaseMs: 60_000,
      buildRevision: REQUIREMENTS.workerBuildRevision!,
      contractVersion: REQUIREMENTS.workerContractVersion!,
      finalizerVersion: REQUIREMENTS.finalizerVersion!,
      schemaVersion: REQUIREMENTS.schemaVersion!,
      configVersion: REQUIREMENTS.configVersion!,
    });
    expect(await withdrawServiceCapabilityLease({
      db,
      component: "worker",
      owner: "wrong-owner",
      fence: lease!.fence,
    })).toBe(false);
    expect(await withdrawServiceCapabilityLease({
      db,
      component: "worker",
      owner: "synthetic-withdraw-owner",
      fence: lease!.fence,
    })).toBe(true);
    const [row] = await isolated.sql<{ expired: boolean }[]>`
      select lease_expires_at <= clock_timestamp() expired
      from service_capability_leases where component = 'worker'
    `;
    expect(row?.expired).toBe(true);
  });
  test("default, missing, and every unset provider/config gate fail closed", async () => {
    expect(await recoveryCapabilityReady(db, UNSET_RECOVERY_OPERATIONAL_READINESS)).toBe(false);
    expect(await recoveryCapabilityReady(db, REQUIREMENTS)).toBe(false);
    for (const field of Object.keys(REQUIREMENTS) as (keyof RecoveryOperationalReadiness)[]) {
      const value = typeof REQUIREMENTS[field] === "boolean" ? false : null;
      expect(await recoveryCapabilityReady(db, { ...REQUIREMENTS, [field]: value })).toBe(false);
    }
  });

  test("readiness requires fresh exact API and worker leases", async () => {
    const workerLease = await acquireServiceCapabilityLease({
      db,
      component: "worker",
      owner: "synthetic-capability-owner",
      leaseMs: 60_000,
      buildRevision: REQUIREMENTS.workerBuildRevision!,
      contractVersion: REQUIREMENTS.workerContractVersion!,
      finalizerVersion: REQUIREMENTS.finalizerVersion!,
      schemaVersion: REQUIREMENTS.schemaVersion!,
      configVersion: REQUIREMENTS.configVersion!,
    });
    expect(workerLease).not.toBeNull();
    expect(await recoveryCapabilityReady(db, REQUIREMENTS)).toBe(false);
    const apiLease = await acquireServiceCapabilityLease({
      db,
      component: "api",
      owner: "synthetic-api-capability-owner",
      leaseMs: 60_000,
      buildRevision: REQUIREMENTS.apiBuildRevision!,
      contractVersion: REQUIREMENTS.apiContractVersion!,
      finalizerVersion: REQUIREMENTS.finalizerVersion!,
      schemaVersion: REQUIREMENTS.schemaVersion!,
      configVersion: REQUIREMENTS.configVersion!,
    });
    expect(apiLease).not.toBeNull();
    expect(await recoveryCapabilityReady(db, REQUIREMENTS)).toBe(true);
    for (const gate of [
      "recoveryAcceptanceEnabled",
      "maintenanceConfigured",
      "providerEnabled",
      "finalizerEnabled",
      "dispatchAdapterReady",
      "providerAdapterReady",
      "a3BudgetConfigReady",
      "bProviderConfigReady",
      "bFinalizerConfigReady",
    ] as const) {
      expect(await recoveryCapabilityReady(db, { ...REQUIREMENTS, [gate]: false })).toBe(false);
    }
    expect(await recoveryCapabilityReady(db, { ...REQUIREMENTS, finalizerVersion: "mismatch" })).toBe(false);
    expect(await recoveryCapabilityReady(db, { ...REQUIREMENTS, workerBuildRevision: "mismatch" })).toBe(false);
    expect(await recoveryCapabilityReady(db, { ...REQUIREMENTS, apiBuildRevision: "mismatch" })).toBe(false);
    for (const [column, value] of [
      ["contract_version", "mismatch-contract"],
      ["finalizer_version", "mismatch-finalizer"],
      ["schema_version", "mismatch-schema"],
      ["config_version", "mismatch-config"],
    ] as const) {
      await isolated.sql.unsafe(`update service_capability_leases set ${column} = $1 where component = 'api'`, [value]);
      expect(await recoveryCapabilityReady(db, REQUIREMENTS)).toBe(false);
      await isolated.sql`
        update service_capability_leases set
          contract_version = ${REQUIREMENTS.apiContractVersion!},
          finalizer_version = ${REQUIREMENTS.finalizerVersion!},
          schema_version = ${REQUIREMENTS.schemaVersion!},
          config_version = ${REQUIREMENTS.configVersion!}
        where component = 'api'
      `;
    }
    await isolated.sql`update service_capability_leases set lease_expires_at = clock_timestamp() - interval '1 second' where component = 'api'`;
    expect(await recoveryCapabilityReady(db, REQUIREMENTS)).toBe(false);
    await isolated.sql`update service_capability_leases set lease_expires_at = clock_timestamp() + interval '1 minute' where component = 'api'`;
    await isolated.sql`update service_capability_leases set lease_expires_at = clock_timestamp() - interval '1 second' where component = 'worker'`;
    expect(await recoveryCapabilityReady(db, REQUIREMENTS)).toBe(false);
  });

  test("heartbeat requires exact owner and fence and uses database time", async () => {
    const lease = await acquireServiceCapabilityLease({
      db,
      component: "worker",
      owner: "synthetic-heartbeat-owner",
      leaseMs: 30_000,
      buildRevision: REQUIREMENTS.workerBuildRevision!,
      contractVersion: REQUIREMENTS.workerContractVersion!,
      finalizerVersion: REQUIREMENTS.finalizerVersion!,
      schemaVersion: REQUIREMENTS.schemaVersion!,
      configVersion: REQUIREMENTS.configVersion!,
    });
    expect(lease).not.toBeNull();
    expect(await heartbeatServiceCapabilityLease({ db, component: "worker", owner: "wrong", fence: lease!.fence, leaseMs: 60_000 })).toBe(false);
    expect(await heartbeatServiceCapabilityLease({ db, component: "worker", owner: "synthetic-heartbeat-owner", fence: lease!.fence + 1, leaseMs: 60_000 })).toBe(false);
    expect(await heartbeatServiceCapabilityLease({ db, component: "worker", owner: "synthetic-heartbeat-owner", fence: lease!.fence, leaseMs: 60_000 })).toBe(true);
    const [row] = await isolated.sql<{ fresh: boolean; owner_is_hash: boolean }[]>`
      select lease_expires_at > clock_timestamp() fresh,
             lease_owner_hash ~ '^[0-9a-f]{64}$' owner_is_hash
      from service_capability_leases where component = 'worker'
    `;
    expect(row).toEqual({ fresh: true, owner_is_hash: true });
  });

  test("a fresh competing owner cannot steal a service lease but can acquire it after expiry", async () => {
    const first = await acquireServiceCapabilityLease({
      db,
      component: "worker",
      owner: "synthetic-first-owner",
      leaseMs: 60_000,
      buildRevision: REQUIREMENTS.workerBuildRevision!,
      contractVersion: REQUIREMENTS.workerContractVersion!,
      finalizerVersion: REQUIREMENTS.finalizerVersion!,
      schemaVersion: REQUIREMENTS.schemaVersion!,
      configVersion: REQUIREMENTS.configVersion!,
    });
    const blocked = await acquireServiceCapabilityLease({
      db,
      component: "worker",
      owner: "synthetic-second-owner",
      leaseMs: 60_000,
      buildRevision: REQUIREMENTS.workerBuildRevision!,
      contractVersion: REQUIREMENTS.workerContractVersion!,
      finalizerVersion: REQUIREMENTS.finalizerVersion!,
      schemaVersion: REQUIREMENTS.schemaVersion!,
      configVersion: REQUIREMENTS.configVersion!,
    });
    expect(first).not.toBeNull();
    expect(blocked).toBeNull();
    await isolated.sql`update service_capability_leases set lease_expires_at = clock_timestamp() - interval '1 second' where component = 'worker'`;
    const takeover = await acquireServiceCapabilityLease({
      db,
      component: "worker",
      owner: "synthetic-second-owner",
      leaseMs: 60_000,
      buildRevision: REQUIREMENTS.workerBuildRevision!,
      contractVersion: REQUIREMENTS.workerContractVersion!,
      finalizerVersion: REQUIREMENTS.finalizerVersion!,
      schemaVersion: REQUIREMENTS.schemaVersion!,
      configVersion: REQUIREMENTS.configVersion!,
    });
    expect(takeover!.fence).toBe(first!.fence + 1);
  });

  test("production API and worker heartbeat seams require every live operational gate", async () => {
    const unavailableSource = createProductionRecoveryReadinessSource({}, {
      dispatchAdapterReady: () => false,
      providerAdapterReady: () => false,
    });
    expect(startProductionCapabilityHeartbeat({
      db,
      component: "api",
      owner: "synthetic-api-unset",
      environment: {},
      readinessSource: unavailableSource,
    })).toBeNull();
    expect(await recoveryCapabilityReady(db, REQUIREMENTS)).toBe(false);
    const environment = {
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
      RECOVERY_CAPABILITY_LEASE_MS: "1000",
      RECOVERY_CAPABILITY_HEARTBEAT_MS: "10",
      RECOVERY_API_BUILD_REVISION: REQUIREMENTS.apiBuildRevision!,
      RECOVERY_WORKER_BUILD_REVISION: REQUIREMENTS.workerBuildRevision!,
      RECOVERY_API_CONTRACT_VERSION: REQUIREMENTS.apiContractVersion!,
      RECOVERY_WORKER_CONTRACT_VERSION: REQUIREMENTS.workerContractVersion!,
      RECOVERY_FINALIZER_VERSION: REQUIREMENTS.finalizerVersion!,
      RECOVERY_SCHEMA_VERSION: REQUIREMENTS.schemaVersion!,
      RECOVERY_CONFIG_VERSION: REQUIREMENTS.configVersion!,
    };
    const [beforeReady] = await isolated.sql<{ count: number }[]>`select count(*)::int count from service_capability_leases`;
    expect(beforeReady?.count).toBe(0);
    const productionSource = createProductionRecoveryReadinessSource(environment, {
      dispatchAdapterReady: () => false,
      providerAdapterReady: () => false,
    });
    const api = startProductionCapabilityHeartbeat({ db, component: "api", owner: "synthetic-api-runtime", environment, readinessSource: productionSource });
    const worker = startProductionCapabilityHeartbeat({ db, component: "worker", owner: "synthetic-worker-runtime", environment, readinessSource: productionSource });
    expect(api).not.toBeNull();
    expect(worker).not.toBeNull();
    expect(await api!.ready).toBe(false);
    expect(await worker!.ready).toBe(false);
    expect(await recoveryCapabilityReady(db, productionSource.read())).toBe(false);
    await Promise.all([api!.stop(), worker!.stop()]);
  });
});
