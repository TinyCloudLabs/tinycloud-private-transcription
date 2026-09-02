import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { acquireServiceCapabilityLease } from "../../src/services/recovery-capability.ts";
import { createRecoveryConfiguration } from "../../src/recovery-config.ts";
import type { RecoveryApiRuntime } from "../../src/api/recovery-runtime.ts";
import { readRecoveryCapability } from "../../src/api/routes/capabilities.ts";
import { meetings, outboxJobs, projectRecoveryBuckets, providerCallLedger, recoveryOperations, transcripts, webhookDeliveries } from "../../src/db/schema.ts";
import { newMeetingId } from "../../src/domain/ids.ts";
import { startHarness, type Harness } from "./harness.ts";
import { createIsolatedDatabase, type IsolatedDatabase } from "./a2-db.ts";
import { createApp } from "../../src/api/app.ts";
import { createApiKey } from "../../src/api/auth.ts";
import type { AppContext } from "../../src/context.ts";
import { deleteMeetingById, storeTranscript } from "../../src/services/meetings.ts";
import { deliverWebhook, enqueueMeetingWebhook, repairStrandedWebhookDeliveries } from "../../src/webhooks/dispatcher.ts";
import {
  responseFor,
  responseSchemaFor,
  validateSchema,
  type OpenApiDocument,
} from "../openapi-schema.ts";

setDefaultTimeout(30_000);

const FULL_ENV: Record<string, string> = {
  PTX_IMAGE: `registry.invalid/placeholder@sha256:${"0".repeat(64)}`,
  RECOVERY_V2_ENABLED: "true", RECOVERY_PROVIDER_ENABLED: "true", RECOVERY_FINALIZER_ENABLED: "true",
  RECOVERY_VEXA_FALLBACK_ENABLED: "false", RECOVERY_SEGMENTATION_MODE: "speaker_aware",
  RECOVERY_MANUAL_CYCLES_PER_MEETING: "1", RECOVERY_COOLDOWN_BASE_MS: "60000", RECOVERY_COOLDOWN_MAX_MS: "300000",
  RECOVERY_MAX_SOURCE_DURATION_MS: "600000", RECOVERY_MAX_SOURCE_PCM_BYTES: "20000000", RECOVERY_MAX_RECORDING_BYTES: "10000000",
  RECOVERY_PROVIDER_MAX_CHUNK_DURATION_MS: "300001", RECOVERY_PROVIDER_MAX_WAV_BYTES: "5000001",
  RECOVERY_MAX_CHUNK_DURATION_MS: "300000", RECOVERY_MAX_WAV_BYTES: "5000000", RECOVERY_MAX_CALLS_PER_OPERATION: "20",
  RECOVERY_MAX_SUBMITTED_AUDIO_MS_PER_OPERATION: "1200000", RECOVERY_MAX_COST_MICROUNITS_PER_OPERATION: "100000",
  RECOVERY_MAX_CONCURRENT_PROVIDER_CALLS: "1", RECOVERY_OPERATION_DEADLINE_MS: "2700000", RECOVERY_DELAYED_THRESHOLD_MS: "900000",
  RECOVERY_SPLIT_FLOOR_MS: "60000", RECOVERY_RETRY_BASE_MS: "1000", RECOVERY_MAX_RETRY_AFTER_MS: "30000",
  RECOVERY_PROJECT_MANUAL_CYCLES: "50", RECOVERY_PROJECT_AUTOMATIC_CYCLES: "0", RECOVERY_PROJECT_MAX_CALLS: "100",
  RECOVERY_PROJECT_MAX_SUBMITTED_AUDIO_MS: "6000000", RECOVERY_PROJECT_MAX_COST_MICROUNITS: "500000",
  RECOVERY_PLAN_MAX_CHUNKS: "20", RECOVERY_PLAN_MAX_CANDIDATES: "10000", RECOVERY_PLAN_QUIET_SEARCH_MS: "200",
  RECOVERY_PLAN_QUIET_WINDOW_MS: "20", RECOVERY_PLAN_SILENCE_THRESHOLD_DBFS: "-60",
  RECOVERY_RECORDING_MAX_MEDIA_FILES: "4", RECOVERY_RECORDING_MAX_METADATA_STRING_LENGTH: "64",
  RECOVERY_RECORDING_ALLOWED_MEDIA_TYPES: "audio/webm,audio/wav", RECOVERY_RECORDING_MAX_DURATION_MS: "600000",
  RECOVERY_RECORDING_MAX_BYTES: "9000000", RECOVERY_DELIVERY_LEASE_MS: "60000", RECOVERY_DELIVERY_MAX_ATTEMPTS: "3",
  RECOVERY_DELIVERY_MAX_AGE_MS: "2400000", RECOVERY_DELIVERY_RETRY_DELAY_MS: "1000", RECOVERY_DELIVERY_IDLE_MS: "500",
  RECOVERY_CAPABILITY_LEASE_MS: "60000", RECOVERY_CAPABILITY_HEARTBEAT_MS: "10000",
  RECOVERY_RETENTION_POLICY_VERSION: "placeholder-retention-v1", RECOVERY_PRICE_VERSION: "placeholder-price-v1",
  RECOVERY_API_BUILD_REVISION: "api-placeholder-a5", RECOVERY_WORKER_BUILD_REVISION: "worker-placeholder-a5",
  RECOVERY_API_CONTRACT_VERSION: "recovery-v2", RECOVERY_WORKER_CONTRACT_VERSION: "recovery-v2",
  RECOVERY_FINALIZER_VERSION: "finalizer-v2", RECOVERY_SCHEMA_VERSION: "0003",
};

const configuration = createRecoveryConfiguration(FULL_ENV, {
  dispatchAdapterReady: true,
  providerAdapterReady: true,
  recordingAdapterReady: true,
  checkpointProtectionReady: true,
});
const readiness = { ...configuration.operationalReadiness };
let preflightCalls = 0;
const recoveryApiRuntime: RecoveryApiRuntime = {
  readinessSource: { read: () => ({ ...readiness }) },
  acceptancePolicy: configuration.acceptancePolicy,
  preflight: async () => {
    preflightCalls += 1;
    return { availability: "present_unverified", code: "recording_present_unverified", status: 200 };
  },
};

let h: Harness;
let isolated: IsolatedDatabase;

const openapi = Bun.YAML.parse(await Bun.file(new URL("../../openapi.yaml", import.meta.url)).text()) as OpenApiDocument;

const expectOpenApi = (name: string, body: unknown) =>
  expect(validateSchema(openapi, openapi.components.schemas[name], body), name).toEqual([]);

async function expectObserved(path: string, method: string, response: Response): Promise<unknown> {
  const declared = responseFor(openapi, path, method, response.status);
  const schema = responseSchemaFor(openapi, path, method, response.status);
  if (!schema) {
    expect(await response.text()).toBe("");
    return null;
  }
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = await response.json();
  expect(validateSchema(openapi, schema, body), `${method} ${path} ${response.status}`).toEqual([]);
  if (response.status === 429 && response.headers.has("retry-after")) {
    const retrySchema = declared.headers?.["Retry-After"]?.schema;
    expect(validateSchema(openapi, retrySchema, Number(response.headers.get("retry-after")))).toEqual([]);
  } else {
    expect(response.headers.has("retry-after")).toBe(false);
  }
  return body;
}

async function seed(status: string, overrides: Record<string, unknown> = {}) {
  const id = newMeetingId();
  await h.ctx.db.insert(meetings).values({
    id,
    projectId: "demo",
    meetingUrl: "https://synthetic.invalid/placeholder",
    platform: "jitsi",
    status,
    errorCode: status === "failed" ? "provider_timeout" : null,
    errorMessage: status === "failed" ? "safe" : null,
    vexaPlatform: "jitsi",
    vexaNativeMeetingId: "placeholder-native",
    metadata: {},
    ...overrides,
  });
  return id;
}

async function effectCounts(meetingId: string) {
  const [row] = await h.ctx.db.select({
    operations: sql<number>`(select count(*)::int from ${recoveryOperations} where ${recoveryOperations.meetingId} = ${meetingId})`,
    outbox: sql<number>`(select count(*)::int from ${outboxJobs} where ${outboxJobs.operationId} in (select id from recovery_operations where meeting_id = ${meetingId}))`,
    buckets: sql<number>`(select count(*)::int from ${projectRecoveryBuckets} where ${projectRecoveryBuckets.projectId} = 'demo')`,
    ledger: sql<number>`(select count(*)::int from ${providerCallLedger} where ${providerCallLedger.operationId} in (select id from recovery_operations where meeting_id = ${meetingId}))`,
  }).from(meetings).where(eq(meetings.id, meetingId));
  return row!;
}

const recover = (id: string, key: string) => h.api(`/v1/meetings/${id}/recover`, {
  method: "POST",
  headers: { "Idempotency-Key": key },
  json: { kind: "manual" },
});

const RACE_WAIT_MS = 1_000;

async function within<T>(promise: Promise<T>, label: string, maxMs = RACE_WAIT_MS): Promise<T> {
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

function pauseAfterSelectingTableOnce<T extends object>(
  database: T,
  table: object,
  requireForUpdate = false,
): { database: T; entered: Promise<void>; release(): void } {
  let enter!: () => void;
  let release!: () => void;
  let selected = false;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const wrapBuilder = (builder: object, matches: boolean, locksForUpdate = false): object => new Proxy(builder, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "then" && matches && (!requireForUpdate || locksForUpdate) && !selected && typeof value === "function") {
        return (fulfilled: (value: unknown) => unknown, rejected: (reason: unknown) => unknown) => value.call(
          target,
          async (result: unknown) => {
            selected = true;
            enter();
            await released;
            return fulfilled(result);
          },
          rejected,
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
      if (property === "select" && typeof value === "function") {
        return (...args: unknown[]) => wrapBuilder(value.apply(target, args), false);
      }
      if (property !== "transaction" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (callback: (transaction: unknown) => unknown, ...args: unknown[]) => value.call(
        target,
        (transaction: object) => callback(wrapTransaction(transaction)),
        ...args,
      );
    },
  });
  return { database: wrapped, entered, release };
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

async function waitForMeetingLockWait(maxMs = 250): Promise<boolean> {
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

describe("A5 authenticated capability and public recovery routes", () => {
  beforeAll(async () => {
    isolated = await createIsolatedDatabase("ptx_a5_api");
    h = await startHarness({
      recoveryConfiguration: configuration,
      recoveryApiRuntime,
      databaseUrl: isolated.url,
    });
  });
  afterAll(async () => {
    await h.stop();
    await h.ctx.db.$client.close();
    await isolated.drop();
  });

  test("create route enforces its exact nullable, bounded, HTTP-only, closed contract", async () => {
    const supported = await h.api("/v1/meetings", {
      method: "POST",
      headers: { "Idempotency-Key": "placeholder-create-nullables" },
      json: {
        meeting_url: "https://meet.jit.si/PlaceholderNullableCreate",
        bot_name: null,
        language: null,
        webhook_url: null,
        platform: null,
      },
    });
    expect(supported.status).toBe(201);

    let tooDeepMetadata: unknown = "bounded";
    for (let depth = 0; depth < 9; depth++) tooDeepMetadata = { nested: tooDeepMetadata };
    const invalidCases: Array<{ name: string; body: Record<string, unknown>; key?: string }> = [
      { name: "extra property", body: { meeting_url: "https://meet.jit.si/PlaceholderExtra", extra: "rejected" } },
      { name: "empty key", key: "", body: { meeting_url: "https://meet.jit.si/PlaceholderEmptyKey" } },
      { name: "oversized key", key: "x".repeat(129), body: { meeting_url: "https://meet.jit.si/PlaceholderLongKey" } },
      { name: "non-ascii key", key: "café", body: { meeting_url: "https://meet.jit.si/PlaceholderUnicodeKey" } },
      { name: "oversized meeting URL", body: { meeting_url: `https://meet.jit.si/${"x".repeat(2030)}` } },
      { name: "oversized bot name", body: { meeting_url: "https://meet.jit.si/PlaceholderBot", bot_name: "x".repeat(257) } },
      { name: "oversized language", body: { meeting_url: "https://meet.jit.si/PlaceholderLanguage", language: "x".repeat(65) } },
      { name: "oversized webhook URL", body: { meeting_url: "https://meet.jit.si/PlaceholderWebhook", webhook_url: `https://example.invalid/${"x".repeat(2030)}` } },
      { name: "oversized metadata text", body: { meeting_url: "https://meet.jit.si/PlaceholderMetadata", metadata: { note: "x".repeat(2049) } } },
      { name: "over-deep metadata", body: { meeting_url: "https://meet.jit.si/PlaceholderMetadataDepth", metadata: tooDeepMetadata } },
      { name: "unsupported meeting scheme", body: { meeting_url: "ftp://meet.jit.si/PlaceholderFtp" } },
      { name: "unsupported webhook scheme", body: { meeting_url: "https://meet.jit.si/PlaceholderWebhookFtp", webhook_url: "ftp://example.invalid/hook" } },
    ];
    for (const fixture of invalidCases) {
      const headers: Record<string, string> = fixture.key === undefined ? {} : { "Idempotency-Key": fixture.key };
      const response = await h.api("/v1/meetings", { method: "POST", headers, json: fixture.body });
      expect(response.status, fixture.name).toBe(400);
      expect((await response.json()).error.code, fixture.name).toMatch(/^(invalid_request|invalid_meeting_url)$/);
    }
  });

  test("capability is authenticated, default-dark until exact live leases, and does no meeting lookup", async () => {
    expect((await readRecoveryCapability(h.ctx, recoveryApiRuntime)).manualAvailable).toBe(false);
    expect((await h.api("/v1/capabilities", { key: null })).status).toBe(401);
    let response = await h.api("/v1/capabilities");
    expect(response.status).toBe(200);
    const darkBody = await response.json();
    expect(darkBody).toEqual({ recovery: {
      contract_version: "recovery-v2",
      manual_available: false,
      automatic_available: false,
      supported_error_codes: ["provider_timeout", "provider_unavailable", "finalizer_interrupted", "recording_fetch_transient"],
    } });
    expectOpenApi("CapabilitiesResponse", darkBody);
    for (const component of ["api", "worker"] as const) {
      await acquireServiceCapabilityLease({
        db: h.ctx.db,
        component,
        owner: `placeholder-${component}`,
        leaseMs: 60_000,
        buildRevision: component === "api" ? readiness.apiBuildRevision! : readiness.workerBuildRevision!,
        contractVersion: component === "api" ? readiness.apiContractVersion! : readiness.workerContractVersion!,
        finalizerVersion: readiness.finalizerVersion!,
        schemaVersion: readiness.schemaVersion!,
        configVersion: readiness.configVersion!,
      });
    }
    response = await h.api("/v1/capabilities");
    expect((await response.json()).recovery.manual_available).toBe(true);
    readiness.providerAdapterReady = false;
    response = await h.api("/v1/capabilities");
    expect((await response.json()).recovery.manual_available).toBe(false);
    readiness.providerAdapterReady = true;
  });

  test("actual path, method, status, error body, and headers select their declared OpenAPI response", async () => {
    await expectObserved("/health", "get", await h.api("/health", { key: null }));
    await expectObserved("/v1/capabilities", "get", await h.api("/v1/capabilities", { key: null }));
    await expectObserved("/v1/capabilities", "get", await h.api("/v1/capabilities"));

    const createBody = { meeting_url: "https://meet.jit.si/PlaceholderObservedCreate" };
    await expectObserved("/v1/meetings", "post", await h.api("/v1/meetings", {
      method: "POST", key: null, json: createBody,
    }));
    await expectObserved("/v1/meetings", "post", await h.api("/v1/meetings", {
      method: "POST", json: { ...createBody, extra: true },
    }));
    const created = await h.api("/v1/meetings", {
      method: "POST", headers: { "Idempotency-Key": "placeholder-observed-create" }, json: createBody,
    });
    const createdBody = await expectObserved("/v1/meetings", "post", created) as { id: string };
    await expectObserved("/v1/meetings", "post", await h.api("/v1/meetings", {
      method: "POST", headers: { "Idempotency-Key": "placeholder-observed-create" }, json: createBody,
    }));

    const readOnly = await createApiKey(h.ctx, "observed-read-only", ["meetings:read"]);
    const recoverOnly = await createApiKey(h.ctx, "observed-recover-only", ["meetings:recover"]);
    await expectObserved(`/v1/meetings/${createdBody.id}`, "get", await h.api(`/v1/meetings/${createdBody.id}`));
    await expectObserved("/v1/meetings/bad", "get", await h.api("/v1/meetings/bad"));
    await expectObserved("/v1/meetings/mtg_0000000000000000000000000Z", "get",
      await h.api("/v1/meetings/mtg_0000000000000000000000000Z"));
    await expectObserved(`/v1/meetings/${createdBody.id}`, "get",
      await h.api(`/v1/meetings/${createdBody.id}`, { key: recoverOnly.key }));

    const queued = await seed("queued");
    await expectObserved(`/v1/meetings/${queued}/transcript`, "get", await h.api(`/v1/meetings/${queued}/transcript`));
    await expectObserved(`/v1/meetings/${queued}/stop`, "post", await h.api(`/v1/meetings/${queued}/stop`, { method: "POST" }));
    await expectObserved("/v1/meetings/bad/stop", "post", await h.api("/v1/meetings/bad/stop", { method: "POST" }));
    await expectObserved(`/v1/meetings/${queued}/stop`, "post",
      await h.api(`/v1/meetings/${queued}/stop`, { method: "POST", key: readOnly.key }));

    const ineligible = await seed("queued");
    await expectObserved(`/v1/meetings/${ineligible}/recover`, "post",
      await recover(ineligible, "placeholder-observed-ineligible"));
    const absent = await seed("failed");
    const absentRuntime: RecoveryApiRuntime = { ...recoveryApiRuntime, preflight: async () => ({
      availability: "absent", code: "recording_absent", status: 410,
    }) };
    const absentApp = createApp(h.ctx, { recoveryApiRuntime: absentRuntime });
    const absentResponse = await absentApp.request(`/v1/meetings/${absent}/recover`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${h.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "placeholder-observed-absent",
      },
      body: JSON.stringify({ kind: "manual" }),
    });
    await expectObserved(`/v1/meetings/${absent}/recover`, "post", absentResponse);

    const deletable = await seed("completed", { vexaPlatform: null, vexaNativeMeetingId: null });
    await expectObserved(`/v1/meetings/${deletable}`, "delete",
      await h.api(`/v1/meetings/${deletable}`, { method: "DELETE" }));
    await expectObserved(`/v1/meetings/${deletable}`, "delete",
      await h.api(`/v1/meetings/${deletable}`, { method: "DELETE" }));
  });

  test("every public operation's sanitized generic 500 selects its declared response", async () => {
    const failure = new Error("synthetic unhandled persistence failure");
    const failingDb = new Proxy(h.ctx.db as object, {
      get(target, property, receiver) {
        if (property === "execute" || property === "select") return () => { throw failure; };
        return Reflect.get(target, property, receiver);
      },
    });
    const app = createApp({ ...h.ctx, db: failingDb } as unknown as AppContext, { recoveryApiRuntime });
    const routes = [
      ["/health", "get"],
      ["/v1/capabilities", "get"],
      ["/v1/meetings", "post"],
      ["/v1/meetings/mtg_0000000000000000000000000A", "get"],
      ["/v1/meetings/mtg_0000000000000000000000000A", "delete"],
      ["/v1/meetings/mtg_0000000000000000000000000A/stop", "post"],
      ["/v1/meetings/mtg_0000000000000000000000000A/recover", "post"],
      ["/v1/meetings/mtg_0000000000000000000000000A/transcript", "get"],
    ] as const;
    for (const [path, method] of routes) {
      const response = await app.request(path, {
        method: method.toUpperCase(),
        headers: {
          Authorization: `Bearer ${h.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "placeholder-generic-failure",
        },
        body: method === "post" ? JSON.stringify(path.endsWith("/recover") ? { kind: "manual" } : {
          meeting_url: "https://meet.jit.si/PlaceholderGenericFailure",
        }) : undefined,
      });
      expect(response.status, `${method} ${path}`).toBe(500);
      await expectObserved(path, method, response);
    }
  });

  test("disabled admission preserves completed/legacy-active convergence and refuses failed rows with zero effects", async () => {
    readiness.providerAdapterReady = false;
    for (const [status, disposition] of [["completed", "already_completed"], ["processing", "already_active"]] as const) {
      const id = await seed(status);
      const response = await recover(id, `placeholder-dark-${status}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.recovery).toMatchObject({
        operation_id: null, disposition, kind: "manual", phase: null, attempt: null, max_attempts: null,
      });
      expectOpenApi("RecoverMeetingResponse", body);
      expect(await effectCounts(id)).toEqual({ operations: 0, outbox: 0, buckets: 0, ledger: 0 });
    }
    const failed = await seed("failed");
    const before = preflightCalls;
    const response = await recover(failed, "placeholder-dark-failed");
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatchObject({ code: "recovery_disabled", retryable: false });
    expect(preflightCalls).toBe(before);
    expect(await effectCounts(failed)).toEqual({ operations: 0, outbox: 0, buckets: 0, ledger: 0 });
    readiness.providerAdapterReady = true;
  });

  test("new 202, response-loss replay 200, and different-key active 200 share one durable operation", async () => {
    const id = await seed("failed");
    const first = await recover(id, "placeholder-replay-key");
    expect(first.status).toBe(202);
    const started = await expectObserved(`/v1/meetings/${id}/recover`, "post", first) as any;
    expect(started).toMatchObject({ id, status: "processing", recovery: {
      operation_id: expect.stringMatching(/^rcv_/), disposition: "started", kind: "manual", phase: "queued",
      attempt: 1, max_attempts: 1, next_eligible_at: null,
    } });
    const replay = await recover(id, "placeholder-replay-key");
    expect(replay.status).toBe(200);
    expect(await expectObserved(`/v1/meetings/${id}/recover`, "post", replay)).toEqual(started);
    const active = await recover(id, "placeholder-different-key");
    expect(active.status).toBe(200);
    expect((await active.json()).recovery).toMatchObject({
      operation_id: started.recovery.operation_id, disposition: "already_active", phase: "queued", attempt: 1, max_attempts: 1,
    });
    expect(await effectCounts(id)).toEqual({ operations: 1, outbox: 1, buckets: 1, ledger: 0 });
  });

  test("same-key terminal replays remain truthful and effect-free after capability switch-off", async () => {
    for (const terminal of [
      { status: "completed", state: "completed", phase: "completed" },
      { status: "failed", state: "failed", phase: "failed" },
      { status: "cancelled", state: "cancelled", phase: "failed" },
    ] as const) {
      const id = await seed("failed");
      const key = `placeholder-terminal-${terminal.status}`;
      const accepted = await recover(id, key);
      expect(accepted.status).toBe(202);
      const operationId = (await accepted.json()).recovery.operation_id as string;
      await h.ctx.db.update(recoveryOperations).set({
        state: terminal.state,
        phase: terminal.phase,
        completedAt: new Date(),
        workerLeaseOwnerHash: null,
        workerLeaseExpiresAt: null,
      }).where(eq(recoveryOperations.id, operationId));
      await h.ctx.db.update(meetings).set({
        status: terminal.status,
        recoveryPhase: terminal.phase,
        activeRecoveryOperationId: null,
        nextRecoveryEligibleAt: sql`clock_timestamp() - interval '1 minute'`,
      }).where(eq(meetings.id, id));

      const durableBefore = {
        counts: await effectCounts(id),
        operations: await h.ctx.db.select().from(recoveryOperations).where(eq(recoveryOperations.meetingId, id)),
        outbox: await h.ctx.db.select().from(outboxJobs).where(eq(outboxJobs.operationId, operationId)),
        bucket: await h.ctx.db.select().from(projectRecoveryBuckets).where(eq(projectRecoveryBuckets.projectId, "demo")),
      };
      const preflightBefore = preflightCalls;
      readiness.providerAdapterReady = false;
      const replay = await recover(id, key);
      readiness.providerAdapterReady = true;

      expect(replay.status).toBe(200);
      const body = await expectObserved(`/v1/meetings/${id}/recover`, "post", replay) as any;
      expect(body).toMatchObject({
        id,
        status: terminal.status,
        recovery: {
          operation_id: operationId,
          disposition: "started",
          phase: terminal.phase,
          next_eligible_at: null,
        },
      });
      expect(preflightCalls).toBe(preflightBefore);
      expect({
        counts: await effectCounts(id),
        operations: await h.ctx.db.select().from(recoveryOperations).where(eq(recoveryOperations.meetingId, id)),
        outbox: await h.ctx.db.select().from(outboxJobs).where(eq(outboxJobs.operationId, operationId)),
        bucket: await h.ctx.db.select().from(projectRecoveryBuckets).where(eq(projectRecoveryBuckets.projectId, "demo")),
      }).toEqual(durableBefore);
    }
  });

  test("delete tombstones recovered meetings, preserves audit, fences work, and retries provider deletion", async () => {
    const id = await seed("failed", { webhookUrl: "https://example.invalid/deleted-webhook" });
    const [staleMeeting] = await h.ctx.db.select().from(meetings).where(eq(meetings.id, id));
    const pendingDeliveryId = await enqueueMeetingWebhook(h.ctx, staleMeeting!, "meeting.failed");
    const key = "placeholder-delete-active";
    const accepted = await recover(id, key);
    expect(accepted.status).toBe(202);
    const operationId = (await accepted.json()).recovery.operation_id as string;
    await h.ctx.db.update(recoveryOperations).set({
      state: "active",
      phase: "transcribing",
      workerLeaseOwnerHash: "a".repeat(64),
      workerLeaseExpiresAt: sql`clock_timestamp() + interval '1 minute'`,
      workerLeaseFence: 4,
    }).where(eq(recoveryOperations.id, operationId));
    await h.ctx.db.update(outboxJobs).set({
      state: "leased",
      leaseOwnerHash: "b".repeat(64),
      leaseExpiresAt: sql`clock_timestamp() + interval '1 minute'`,
      leaseFence: 4,
    }).where(eq(outboxJobs.operationId, operationId));
    const auditBefore = await effectCounts(id);

    const deleted = await h.api(`/v1/meetings/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    for (const [path, init] of [
      [`/v1/meetings/${id}`, {}],
      [`/v1/meetings/${id}/transcript`, {}],
      [`/v1/meetings/${id}/recover`, { method: "POST", headers: { "Idempotency-Key": key }, json: { kind: "manual" } }],
    ] as const) {
      expect((await h.api(path, init)).status, path).toBe(404);
    }
    const other = await createApiKey(h.ctx, "other-project");
    expect((await h.api(`/v1/meetings/${id}`, { key: other.key })).status).toBe(404);
    expect((await h.api(`/v1/meetings/${id}`, { method: "DELETE" })).status).toBe(204);

    const [operation] = await h.ctx.db.select().from(recoveryOperations).where(eq(recoveryOperations.id, operationId));
    const [job] = await h.ctx.db.select().from(outboxJobs).where(eq(outboxJobs.operationId, operationId));
    expect(operation).toMatchObject({
      state: "cancelled", phase: "failed", failureCode: "deleted",
      workerLeaseOwnerHash: null, workerLeaseExpiresAt: null, workerLeaseFence: 5,
    });
    expect(job).toMatchObject({
      state: "cancelled", leaseOwnerHash: null, leaseExpiresAt: null, leaseFence: 5,
    });
    expect(await effectCounts(id)).toEqual(auditBefore);
    const tombstone = await h.ctx.db.select({
      deletedAt: meetings.deletedAt,
      deletionFence: meetings.deletionFence,
      deletionSagaState: meetings.deletionSagaState,
      meetingUrl: meetings.meetingUrl,
      metadata: meetings.metadata,
      vexaPlatform: meetings.vexaPlatform,
      vexaNativeMeetingId: meetings.vexaNativeMeetingId,
    }).from(meetings).where(eq(meetings.id, id));
    expect(tombstone).toHaveLength(1);
    expect(tombstone[0]).toMatchObject({
      deletionSagaState: "completed", meetingUrl: "", metadata: {},
      vexaPlatform: null, vexaNativeMeetingId: null,
    });
    expect(tombstone[0]!.deletedAt).toBeInstanceOf(Date);
    expect(tombstone[0]!.deletionFence).toBeGreaterThan(0);
    await storeTranscript(h.ctx, id, {
      language: "en", duration_seconds: 1, speakers: [], segments: [], text: "must not resurrect",
    }, "vexa");
    expect(await h.ctx.db.select().from(transcripts).where(eq(transcripts.meetingId, id))).toHaveLength(0);
    expect(await enqueueMeetingWebhook(h.ctx, staleMeeting!, "meeting.failed")).toBeNull();
    expect(await h.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.meetingId, id))).toHaveLength(1);
    const originalFetch = globalThis.fetch;
    let webhookCalls = 0;
    globalThis.fetch = (async () => {
      webhookCalls += 1;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    try {
      await deliverWebhook(h.ctx, pendingDeliveryId!);
      expect(webhookCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const retryId = await seed("failed");
    const originalDelete = h.ctx.vexa.deleteMeeting.bind(h.ctx.vexa);
    let providerCalls = 0;
    h.ctx.vexa.deleteMeeting = (async () => {
      providerCalls += 1;
      if (providerCalls === 1) throw new Error("synthetic provider failure");
      return {} as never;
    }) as typeof h.ctx.vexa.deleteMeeting;
    try {
      const providerFailure = await h.api(`/v1/meetings/${retryId}`, { method: "DELETE" });
      expect(providerFailure.status).toBe(503);
      await expectObserved(`/v1/meetings/${retryId}`, "delete", providerFailure);
      expect((await h.api(`/v1/meetings/${retryId}`)).status).toBe(404);
      expect((await recover(retryId, "placeholder-after-delete")).status).toBe(404);
      expect((await h.api(`/v1/meetings/${retryId}`, { method: "DELETE" })).status).toBe(204);
      expect(providerCalls).toBe(2);
    } finally {
      h.ctx.vexa.deleteMeeting = originalDelete;
    }
  });

  test("ordinary stop route deletion-first suppresses stopBot and keeps saga authority separate", async () => {
    const id = await seed("in_progress");
    const staleRead = pauseAfterSelectingTableOnce(h.ctx.db, meetings);
    let ordinaryStopCalls = 0;
    let sagaStopCalls = 0;
    let sagaDeleteCalls = 0;
    let queueCalls = 0;
    const stopContext = {
      ...h.ctx,
      db: staleRead.database,
      queue: { push: async () => { queueCalls += 1; } },
      vexa: {
        stopBot: async () => { ordinaryStopCalls += 1; return { status: "stopping" }; },
      },
    } as unknown as AppContext;
    const deletionContext = {
      ...h.ctx,
      vexa: {
        stopBot: async () => { sagaStopCalls += 1; return { status: "stopping" }; },
        deleteMeeting: async () => { sagaDeleteCalls += 1; return { status: "deleted" }; },
      },
    } as unknown as AppContext;
    const app = createApp(stopContext, { recoveryApiRuntime });
    let stopping: Promise<Response> | null = null;
    try {
      stopping = Promise.resolve(app.request(`/v1/meetings/${id}/stop`, {
        method: "POST",
        headers: { Authorization: `Bearer ${h.apiKey}` },
      }));
      await within(staleRead.entered, "ordinary stop stale owner-scoped read");
      await within(deleteMeetingById(deletionContext, "demo", id), "ordinary stop deletion-first commit");
      staleRead.release();
      const response = await within(stopping, "ordinary stop deletion-first response");

      expect(ordinaryStopCalls).toBe(0);
      expect(sagaStopCalls).toBe(1);
      expect(sagaDeleteCalls).toBe(1);
      expect(queueCalls).toBe(0);
      expect(response.status).toBe(404);
      const [tombstone] = await h.ctx.db.select().from(meetings).where(eq(meetings.id, id));
      expect(tombstone).toMatchObject({ status: "cancelled", deletedAt: expect.any(Date) });
    } finally {
      staleRead.release();
      if (stopping) await within(Promise.allSettled([stopping]), "ordinary stop deletion-first cleanup");
    }
  });

  test("ordinary stop route invocation-first holds deletion only through handoff and never revives", async () => {
    const id = await seed("in_progress");
    const providerResponse = deferred();
    const providerStarted = deferred();
    let providerSettled = false;
    let ordinaryStopCalls = 0;
    let sagaStopCalls = 0;
    let sagaDeleteCalls = 0;
    let queueCalls = 0;
    const handoff = pauseTransactionAfterInvocation(h.ctx.db, () => ordinaryStopCalls === 1);
    const stopContext = {
      ...h.ctx,
      db: handoff.database,
      queue: { push: async () => { queueCalls += 1; } },
      vexa: {
        stopBot: async () => {
          ordinaryStopCalls += 1;
          providerStarted.resolve();
          await providerResponse.promise;
          providerSettled = true;
          return { status: "stopping" };
        },
      },
    } as unknown as AppContext;
    const deletionContext = {
      ...h.ctx,
      vexa: {
        stopBot: async () => { sagaStopCalls += 1; return { status: "stopping" }; },
        deleteMeeting: async () => { sagaDeleteCalls += 1; return { status: "deleted" }; },
      },
    } as unknown as AppContext;
    const app = createApp(stopContext, { recoveryApiRuntime });
    let stopping: Promise<Response> | null = null;
    let deleting: Promise<void> | null = null;
    try {
      stopping = Promise.resolve(app.request(`/v1/meetings/${id}/stop`, {
        method: "POST",
        headers: { Authorization: `Bearer ${h.apiKey}` },
      }));
      await within(providerStarted.promise, "ordinary stop provider invocation");
      deleting = deleteMeetingById(deletionContext, "demo", id);
      expect(await waitForMeetingLockWait()).toBe(true);
      handoff.release();
      await within(deleting, "ordinary stop post-handoff deletion");
      expect(providerSettled).toBe(false);
      expect(ordinaryStopCalls).toBe(1);
      expect(sagaStopCalls).toBe(1);
      expect(sagaDeleteCalls).toBe(1);
      providerResponse.resolve();
      await within(stopping, "ordinary stop invocation-first response");
      expect(queueCalls).toBe(0);
      const [tombstone] = await h.ctx.db.select().from(meetings).where(eq(meetings.id, id));
      expect(tombstone).toMatchObject({ status: "cancelled", deletedAt: expect.any(Date) });
    } finally {
      handoff.release();
      providerResponse.resolve();
      const cleanup: Promise<unknown>[] = [];
      if (stopping) cleanup.push(stopping);
      if (deleting) cleanup.push(deleting);
      await within(Promise.allSettled(cleanup), "ordinary stop invocation-first cleanup");
    }
  });

  test("a deletion commit before the webhook meeting fence suppresses HTTP deterministically", async () => {
    const id = await seed("failed", {
      webhookUrl: "https://example.invalid/concurrent-delete-hook",
      vexaPlatform: null,
      vexaNativeMeetingId: null,
    });
    const deliveryId = `whd_01CONCURRENCY${id.slice(-13)}`;
    await h.ctx.db.insert(webhookDeliveries).values({
      id: deliveryId,
      meetingId: id,
      eventId: `evt_01CONCURRENCY${id.slice(-13)}`,
      eventType: "meeting.failed",
      endpoint: "https://example.invalid/concurrent-delete-hook",
      payload: JSON.stringify({ type: "meeting.failed", data: { meeting_id: id } }),
      status: "pending",
      nextAttemptAt: new Date(),
    });
    const barrier = pauseAfterSelectingTableOnce(h.ctx.db, webhookDeliveries);
    const queued: unknown[] = [];
    const deliveryContext = {
      ...h.ctx,
      db: barrier.database,
      queue: { push: async (...args: unknown[]) => { queued.push(args); } },
    } as unknown as AppContext;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    let delivering: Promise<void> | null = null;
    try {
      delivering = deliverWebhook(deliveryContext, deliveryId);
      await Promise.race([
        barrier.entered,
        Bun.sleep(250).then(() => { throw new Error("delivery did not reach its pre-fence reference read"); }),
      ]);
      await deleteMeetingById(h.ctx, "demo", id);
      barrier.release();
      await delivering;
      expect(calls).toBe(0);
      expect(await h.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)))
        .toMatchObject([{ status: "cancelled", nextAttemptAt: null }]);
      expect(queued).toEqual([]);
    } finally {
      barrier.release();
      await Promise.allSettled(delivering ? [delivering] : []);
      globalThis.fetch = originalFetch;
    }
  });

  test("a webhook owning the meeting fence starts HTTP before deletion commits and cannot retry afterward", async () => {
    const id = await seed("failed", {
      webhookUrl: "https://example.invalid/concurrent-delete-hook",
      vexaPlatform: null,
      vexaNativeMeetingId: null,
    });
    const deliveryId = `whd_01FENCEOWNER${id.slice(-13)}`;
    await h.ctx.db.insert(webhookDeliveries).values({
      id: deliveryId,
      meetingId: id,
      eventId: `evt_01FENCEOWNER${id.slice(-13)}`,
      eventType: "meeting.failed",
      endpoint: "https://example.invalid/concurrent-delete-hook",
      payload: JSON.stringify({ type: "meeting.failed", data: { meeting_id: id } }),
      status: "pending",
      nextAttemptAt: new Date(),
    });
    const barrier = pauseAfterSelectingTableOnce(h.ctx.db, meetings, true);
    const queued: unknown[] = [];
    const deliveryContext = {
      ...h.ctx,
      db: barrier.database,
      queue: { push: async (...args: unknown[]) => { queued.push(args); } },
    } as unknown as AppContext;
    const originalFetch = globalThis.fetch;
    let fetchStarted!: () => void;
    let releaseResponse!: () => void;
    const fetchInvoked = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const responseReleased = new Promise<void>((resolve) => { releaseResponse = resolve; });
    let fetchStartedAt = 0;
    let deletionCommittedAt = 0;
    globalThis.fetch = (() => {
      fetchStartedAt = performance.now();
      fetchStarted();
      return responseReleased.then(() => new Response(null, { status: 500 }));
    }) as unknown as typeof fetch;
    let delivering: Promise<void> | null = null;
    let deleting: Promise<void> | null = null;
    try {
      delivering = deliverWebhook(deliveryContext, deliveryId);
      await Promise.race([
        barrier.entered,
        Bun.sleep(250).then(() => { throw new Error("delivery did not resolve its meeting FOR UPDATE lock"); }),
      ]);
      deleting = deleteMeetingById(h.ctx, "demo", id).then(() => { deletionCommittedAt = performance.now(); });
      expect(await waitForMeetingLockWait()).toBe(true);
      barrier.release();
      await Promise.race([
        fetchInvoked,
        Bun.sleep(250).then(() => { throw new Error("fetch was not invoked after releasing the meeting fence barrier"); }),
      ]);
      await deleting;
      expect(fetchStartedAt).toBeLessThanOrEqual(deletionCommittedAt);
      releaseResponse();
      await delivering;
      expect(await h.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)))
        .toMatchObject([{ status: "cancelled", nextAttemptAt: null }]);
      expect(queued).toEqual([]);
    } finally {
      barrier.release();
      releaseResponse();
      const cleanup: Promise<unknown>[] = [];
      if (delivering) cleanup.push(delivering);
      if (deleting) cleanup.push(deleting);
      await Promise.allSettled(cleanup);
      globalThis.fetch = originalFetch;
    }
  });

  test("a crashed dispatching webhook converges terminally without another HTTP or Redis side effect", async () => {
    const id = await seed("failed", {
      webhookUrl: "https://example.invalid/stranded-hook",
      vexaPlatform: null,
      vexaNativeMeetingId: null,
    });
    const deliveryId = `whd_01STRANDEDXX${id.slice(-13)}`;
    await h.ctx.db.insert(webhookDeliveries).values({
      id: deliveryId,
      meetingId: id,
      eventId: `evt_01STRANDEDXX${id.slice(-13)}`,
      eventType: "meeting.failed",
      endpoint: "https://example.invalid/stranded-hook",
      payload: JSON.stringify({ type: "meeting.failed", data: { meeting_id: id } }),
      attempt: 1,
      status: "dispatching",
      nextAttemptAt: null,
      updatedAt: sql`clock_timestamp() - interval '31 seconds'`,
    });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    try {
      expect(await repairStrandedWebhookDeliveries(h.ctx)).toBe(1);
      expect(await repairStrandedWebhookDeliveries(h.ctx)).toBe(0);
      expect(calls).toBe(0);
      expect(await h.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)))
        .toMatchObject([{ status: "failed", attempt: 1, responseCode: null, nextAttemptAt: null }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each(["synchronous throw", "promise rejection"] as const)(
    "webhook %s preserves attempt numbering and bounded exhaustion",
    async (mode) => {
      const id = await seed("failed", {
        webhookUrl: "https://example.invalid/transport-failure-hook",
        vexaPlatform: null,
        vexaNativeMeetingId: null,
      });
      const deliveryId = `whd_01TRANSPORTX${id.slice(-13)}`;
      await h.ctx.db.insert(webhookDeliveries).values({
        id: deliveryId,
        meetingId: id,
        eventId: `evt_01TRANSPORTX${id.slice(-13)}`,
        eventType: "meeting.failed",
        endpoint: "https://example.invalid/transport-failure-hook",
        payload: JSON.stringify({ type: "meeting.failed", data: { meeting_id: id } }),
        status: "pending",
        nextAttemptAt: new Date(),
      });
      const queued: unknown[] = [];
      const deliveryContext = {
        ...h.ctx,
        webhookRetryDelaysMs: [0, 1],
        queue: { push: async (...args: unknown[]) => { queued.push(args); } },
      } as unknown as AppContext;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (mode === "synchronous throw"
        ? (() => { throw new Error("synthetic sync transport failure"); })
        : (() => Promise.reject(new Error("synthetic rejected transport failure")))) as unknown as typeof fetch;
      try {
        await deliverWebhook(deliveryContext, deliveryId);
        expect(await h.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)))
          .toMatchObject([{ status: "pending", attempt: 1, responseCode: null }]);
        expect(queued).toHaveLength(1);
        await deliverWebhook(deliveryContext, deliveryId);
        expect(await h.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)))
          .toMatchObject([{ status: "failed", attempt: 2, responseCode: null, nextAttemptAt: null }]);
        expect(queued).toHaveLength(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  test("delete commits its fence before the external provider saga and wins concurrent recovery", async () => {
    const id = await seed("failed");
    const accepted = await recover(id, "placeholder-delete-race-original");
    expect(accepted.status).toBe(202);
    const originalDelete = h.ctx.vexa.deleteMeeting.bind(h.ctx.vexa);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    h.ctx.vexa.deleteMeeting = (async () => {
      enter();
      await released;
      return {} as never;
    }) as typeof h.ctx.vexa.deleteMeeting;
    try {
      const deleting = h.api(`/v1/meetings/${id}`, { method: "DELETE" });
      await entered;
      const preflightBefore = preflightCalls;
      expect((await recover(id, "placeholder-delete-race-new")).status).toBe(404);
      expect((await h.api(`/v1/meetings/${id}`)).status).toBe(404);
      expect(preflightCalls).toBe(preflightBefore);
      release();
      expect((await deleting).status).toBe(204);
    } finally {
      release();
      h.ctx.vexa.deleteMeeting = originalDelete;
    }
  });

  test("delete preserves terminal recovery audit records", async () => {
    const id = await seed("failed");
    const accepted = await recover(id, "placeholder-delete-terminal");
    expect(accepted.status).toBe(202);
    const operationId = (await accepted.json()).recovery.operation_id as string;
    await h.ctx.db.update(recoveryOperations).set({
      state: "completed", phase: "completed", completedAt: new Date(),
      workerLeaseOwnerHash: null, workerLeaseExpiresAt: null,
    }).where(eq(recoveryOperations.id, operationId));
    await h.ctx.db.update(meetings).set({
      status: "completed", recoveryPhase: "completed", lastRecoveryOutcome: "completed",
      activeRecoveryOperationId: null, completedAt: new Date(),
    }).where(eq(meetings.id, id));
    const auditBefore = await effectCounts(id);
    expect((await h.api(`/v1/meetings/${id}`, { method: "DELETE" })).status).toBe(204);
    expect(await effectCounts(id)).toEqual(auditBefore);
    const [operation] = await h.ctx.db.select().from(recoveryOperations).where(eq(recoveryOperations.id, operationId));
    expect(operation).toMatchObject({ state: "completed", phase: "completed", failureCode: null });
  });

  test("database cooldown alone emits a bounded Retry-After on 429", async () => {
    const id = await seed("failed", { errorCode: "recording_fetch_transient", nextRecoveryEligibleAt: sql`clock_timestamp() + interval '5 seconds'` });
    const response = await recover(id, "placeholder-cooldown");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toMatch(/^[1-5]$/);
    expect((await expectObserved(`/v1/meetings/${id}/recover`, "post", response) as any).error.code).toBe("recovery_cooldown");
  });

  test("real meeting and transcript responses validate against their declared schemas and stored revision", async () => {
    const id = await seed("completed", { transcriptRevision: 3, completedAt: new Date(), endedAt: new Date() });
    await h.ctx.db.insert(transcripts).values({
      meetingId: id,
      language: "en",
      durationSeconds: 0,
      segmentsJson: { speakers: [], segments: [], text: "" },
      provider: "vexa",
    });
    const meetingResponse = await h.api(`/v1/meetings/${id}`);
    const meetingBody = await meetingResponse.json();
    expect(meetingBody.transcript_revision).toBe(3);
    expectOpenApi("Meeting", meetingBody);
    const transcriptResponse = await h.api(`/v1/meetings/${id}/transcript`);
    const transcriptBody = await transcriptResponse.json();
    expect(transcriptBody.transcript_revision).toBe(3);
    expectOpenApi("Transcript", transcriptBody);
  });

  test("the production runtime remains dark and zero-network even with synthetic leases present", async () => {
    const production = createApp(h.ctx);
    const request = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${h.apiKey}`);
      return production.request(path, { ...init, headers });
    };
    const capability = await request("/v1/capabilities");
    const capabilityBody = await capability.json() as { recovery: { manual_available: boolean } };
    expect(capabilityBody.recovery.manual_available).toBe(false);
    const id = await seed("failed");
    const before = preflightCalls;
    const durableBefore = await effectCounts(id);
    const response = await request(`/v1/meetings/${id}/recover`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "placeholder-production-dark" },
      body: JSON.stringify({ kind: "manual" }),
    });
    expect(response.status).toBe(503);
    expect(preflightCalls).toBe(before);
    expect(await effectCounts(id)).toEqual(durableBefore);
  });
});
