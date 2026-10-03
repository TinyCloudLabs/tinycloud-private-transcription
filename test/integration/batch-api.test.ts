import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createApp } from "../../src/api/app.ts";
import { createContext } from "../../src/context.ts";
import { createDb } from "../../src/db/client.ts";
import { transcriptionCapabilities, transcriptions, transcriptionWorkers } from "../../src/db/schema.ts";
import { silentLogger } from "../../src/log.ts";
import { createBatchApp } from "../../src/roles/batch.ts";
import { parseCorsOrigins } from "../../src/uploads/cors.ts";
import { runSweep } from "../../src/uploads/ledger.ts";
import { audioName, jobDir } from "../../src/uploads/storage.ts";
import { audio, exists, laceBombWebm, sha256, startBatchHarness, TENANT_A, TENANT_B, tenant, trickle, type BatchHarness } from "./batch-harness.ts";

let h: BatchHarness;
beforeAll(async () => {
  h = await startBatchHarness();
});
afterAll(async () => h.stop());
afterEach(async () => {
  h.faults.clear();
  // Each test starts from an empty job table, open admission and the default limits.
  await h.ctx.db.execute(sql`truncate table transcriptions, transcription_tenant_usage cascade`);
  await h.ctx.db.execute(sql`update transcription_admission set mode = 'open' where id = 1`);
  Object.assign(h.ctx.config.limits, { maxActiveJobs: 10, maxReservedBytes: 1_209_600_000, maxConcurrentUploads: 3, diskHighWaterPercent: 99, tenantDailyBytes: 362_880_000, maxDurationSeconds: 7_200, durationScanSeconds: 45 });
  Object.assign(h.ctx.config.upload, { maxPutSeconds: 1_800, minBytesPerSecond: 32_768, progressGraceSeconds: 60, idleTimeoutSeconds: 60, leaseStaleSeconds: 120 });
  h.tinfoil.calls = [];
});

const errorOf = async (res: { json(): Promise<any> }) => (await res.json()).error;

describe("role isolation", () => {
  test("the batch app mounts no meeting route and its context has no Redis, Vexa or Signal", async () => {
    for (const key of ["redis", "vexa", "signal", "queue", "transcription"]) expect(h.ctx).not.toHaveProperty(key);
    const meetings = await h.api("/v1/meetings", { method: "POST", key: h.keys.meetings, json: { meeting_url: "https://meet.jit.si/x" } });
    expect(meetings.status).toBe(404);
    expect((await errorOf(meetings)).code).toBe("not_found");
    const health = await h.api("/health");
    expect((await health.json()).checks).not.toHaveProperty("vexa");
  });

  test("the meeting app (default role) mounts no batch route", async () => {
    const app = createApp(createContext({ db: h.ctx.db, log: silentLogger } as never));
    for (const [method, path] of [["POST", "/v1/transcriptions"], ["GET", "/v1/transcriptions/capabilities"], ["PUT", "/v1/admin/admission"]] as const) {
      const res = await app.request(path, { method, headers: { Authorization: `Bearer ${h.keys.transcriptions}` } });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    const upload = await app.request("/uploads/trn_01M3PQ71Q9YF7GSEFP6S19ZJPW", { method: "PUT", body: "x" });
    expect(upload.status).toBe(404);
  });
});

describe("scopes on every batch route", () => {
  const routes = [
    ["GET", "/v1/transcriptions/capabilities"], ["POST", "/v1/transcriptions"], ["GET", "/v1/transcriptions"],
    ["GET", "/v1/transcriptions/by-idempotency-key"], ["GET", "/v1/transcriptions/trn_01M3PQ71Q9YF7GSEFP6S19ZJPW"],
    ["GET", "/v1/transcriptions/trn_01M3PQ71Q9YF7GSEFP6S19ZJPW/result"], ["POST", "/v1/transcriptions/trn_01M3PQ71Q9YF7GSEFP6S19ZJPW/cancel"],
    ["DELETE", "/v1/transcriptions/trn_01M3PQ71Q9YF7GSEFP6S19ZJPW"],
  ] as const;
  test("meetings-only and admin-only keys get 403; missing, malformed and capability bearers get 401", async () => {
    for (const [method, path] of routes) {
      for (const key of [h.keys.meetings, h.keys.admin]) {
        const res = await h.api(path, { method, key });
        expect({ path, status: res.status, code: (await errorOf(res)).code }).toEqual({ path, status: 403, code: "insufficient_scope" });
      }
      for (const key of [null, "not_a_key", "tcu_notakeyatall"]) {
        const res = await h.api(path, { method, key });
        expect({ path, status: res.status }).toEqual({ path, status: 401 });
      }
    }
  });
  test("admin routes need admin:*; a transcriptions:* key gets 403", async () => {
    for (const method of ["GET", "PUT"]) {
      const res = await h.api("/v1/admin/admission", { method, json: method === "PUT" ? { mode: "closed" } : undefined });
      expect(res.status).toBe(403);
    }
    expect((await h.api("/v1/admin/admission", { key: h.keys.admin })).status).toBe(200);
  });
});

describe("create and admission", () => {
  test("validates the body and caps byte_size at 120,960,000 before any state is written", async () => {
    const bytes = await audio("stereo");
    const bad = [
      [{ content_type: "audio/aac" }, 400, "invalid_request"],
      [{ byte_size: 0 }, 400, "invalid_request"],
      [{ byte_size: 120_960_001 }, 413, "recording_too_large"],
      [{ sha256: "XYZ" }, 400, "invalid_request"],
      [{ language: "en; drop" }, 400, "invalid_request"],
      [{ channel_labels: ["a", "b", "c"] }, 400, "invalid_request"],
      [{ extra: true }, 400, "invalid_request"],
      [{ diarize: "yes" }, 400, "invalid_request"],
      [{ diarize: true, channel_mode: "separate" }, 400, "invalid_request"],
      [{ diarize: true }, 400, "diarization_unavailable"],
    ] as const;
    for (const [body, status, code] of bad) {
      const res = await h.create(bytes, { body });
      expect({ body, status: res.status, code: (await errorOf(res)).code }).toEqual({ body, status, code });
    }
    const noTenant = await h.api("/v1/transcriptions", { method: "POST", tenant: null, headers: { "Idempotency-Key": "k" }, json: {} });
    expect((await errorOf(noTenant)).code).toBe("invalid_request");
    expect((await h.ctx.db.select().from(transcriptions)).length).toBe(0);
  });

  test("Idempotency-Key replays return the same job with an additional capability; a different body conflicts", async () => {
    const bytes = await audio("stereo");
    const body = { content_type: "audio/mpeg", byte_size: bytes.byteLength, sha256: sha256(bytes), language: "en" };
    const send = (json: unknown, t = TENANT_A) => h.api("/v1/transcriptions", { method: "POST", tenant: t, headers: { "Idempotency-Key": "tc:replay" }, json });
    const first = await send(body);
    const second = await send(body);
    expect([first.status, second.status]).toEqual([201, 200]);
    const [a, b] = [await first.json(), await second.json()];
    expect(b.id).toBe(a.id);
    expect(b.upload.capability).not.toBe(a.upload.capability);
    expect((await send({ ...body, language: "fr" })).status).toBe(409);
    // Another tenant replaying the key never reads this job.
    expect((await errorOf(await send(body, TENANT_B))).code).toBe("idempotency_conflict");
    const lookup = await h.api("/v1/transcriptions/by-idempotency-key", { headers: { "Idempotency-Key": "tc:replay" } });
    expect((await lookup.json())).not.toHaveProperty("upload");
    expect((await h.api("/v1/transcriptions/by-idempotency-key", { tenant: TENANT_B, headers: { "Idempotency-Key": "tc:replay" } })).status).toBe(404);
  });

  test("one active job per tenant under 10 concurrent creates: exactly one 201", async () => {
    const bytes = await audio("stereo");
    const results = await Promise.all(Array.from({ length: 10 }, () => h.create(bytes)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, ...Array(9).fill(409)]);
    const winner = await results.find((r) => r.status === 201)!.json();
    for (const loser of results.filter((r) => r.status === 409)) {
      expect(await errorOf(loser)).toMatchObject({ code: "active_transcription_exists", id: winner.id });
    }
  });

  test("the database itself refuses a second active job for a tenant (partial unique index)", async () => {
    const bytes = await audio("stereo");
    const job = await (await h.create(bytes)).json();
    const [row] = await h.ctx.db.select().from(transcriptions).where(eq(transcriptions.id, job.id));
    const cause = await h.ctx.db.insert(transcriptions).values({ ...row!, id: "trn_01M3PQ71Q9YF7GSEFP6S19ZJPX", idempotencyKey: "other", status: "queued" })
      .then(() => null, (error: { cause?: { errno?: string; constraint?: string } }) => error.cause);
    expect({ errno: cause?.errno, constraint: cause?.constraint }).toEqual({ errno: "23505", constraint: "transcriptions_one_active_per_tenant_idx" });
    await h.api(`/v1/transcriptions/${job.id}/cancel`, { method: "POST" });
    await h.ctx.db.insert(transcriptions).values({ ...row!, id: "trn_01M3PQ71Q9YF7GSEFP6S19ZJPY", idempotencyKey: "other2", status: "queued" });
  });

  test("service-wide active-job reservation is atomic across concurrent multi-tenant creates", async () => {
    h.ctx.config.limits.maxActiveJobs = 5;
    const bytes = await audio("stereo");
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => h.create(bytes, { tenant: tenant(i + 1) })));
    expect(results.filter((r) => r.status === 201).length).toBe(5);
    for (const busy of results.filter((r) => r.status !== 201)) {
      expect(busy.status).toBe(429);
      expect(await errorOf(busy)).toMatchObject({ code: "service_busy", retry_after_seconds: expect.any(Number) });
      expect(busy.headers.get("retry-after")).toBeTruthy();
    }
  });

  test("concurrent creates on a cold connection pool get only 201 or service_busy (Bun.SQL reply attribution)", async () => {
    // Bun 1.3.14's Postgres client could write an already-prepared query's Bind+Execute ahead of an earlier
    // queued query that still needed a Parse, while replies stay FIFO (oven-sh/bun#33665; 1.4.x passes). A pooled
    // query then ran inside a create transaction and the admission-row SELECT ... FOR UPDATE received its rows:
    // a 500 ("admission row is missing"), a 503 service_paused, or a wedged connection. It needs statements a
    // connection has not prepared yet, so every round uses a fresh pool.
    h.ctx.config.limits.maxActiveJobs = 5;
    const bytes = await audio("stereo");
    for (let round = 0; round < 25; round++) {
      await h.ctx.db.execute(sql`truncate table transcriptions, transcription_tenant_usage cascade`);
      const db = createDb(h.ctx.config.databaseUrl);
      const app = createBatchApp({ ...h.ctx, db });
      try {
        const creates = Promise.all(Array.from({ length: 12 }, (_, i) => app.request("/v1/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${h.keys.transcriptions}`, "X-Tenant-Ref": tenant(i + 1), "Idempotency-Key": `tc:${crypto.randomUUID()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ content_type: "audio/mpeg", byte_size: bytes.byteLength, sha256: sha256(bytes), language: "en" }),
        })));
        const results = await Promise.race([creates, Bun.sleep(2_000).then(() => null)]);
        expect({ round, settled: results !== null }).toEqual({ round, settled: true });
        const outcomes = await Promise.all(results!.map(async (r) => r.status === 201 ? "201" : `${r.status} ${(await errorOf(r)).code}`));
        expect({ round, outcomes: outcomes.sort() }).toEqual({ round, outcomes: [...Array(5).fill("201"), ...Array(7).fill("429 service_busy")] });
      } finally {
        // A connection wedged by the bug never closes; bound the wait so the assertion above is what reports.
        await Promise.race([db.$client.close({ timeout: 0 }), Bun.sleep(1_000)]);
      }
    }
  }, 30_000);

  test("declared-byte reservation covers awaiting_upload + queued + processing and is released only by a terminal transition", async () => {
    const bytes = await audio("stereo");
    h.ctx.config.limits.maxReservedBytes = bytes.byteLength * 3;
    const results = await Promise.all(Array.from({ length: 6 }, async (_, i) => ({ tenant: tenant(i + 1), res: await h.create(bytes, { tenant: tenant(i + 1) }) })));
    const created = await Promise.all(results.filter((r) => r.res.status === 201).map(async (r) => ({ tenant: r.tenant, ...(await r.res.json()) })));
    expect(created.length).toBe(3);
    // Queued (uploaded) and processing jobs stay reserved.
    expect((await h.put(created[0].id, created[0].upload.capability, bytes)).status).toBe(201);
    expect((await h.put(created[1].id, created[1].upload.capability, bytes)).status).toBe(201);
    const claim = await (await import("../../src/uploads/worker.ts")).claimNext(h.ctx);
    expect(claim).not.toBeNull();
    expect((await h.create(bytes, { tenant: tenant(50) })).status).toBe(429);
    // A terminal transition (cancel) releases exactly one reservation.
    await h.api(`/v1/transcriptions/${created[2].id}/cancel`, { method: "POST", tenant: created[2].tenant });
    expect((await h.create(bytes, { tenant: tenant(51) })).status).toBe(201);
    expect((await h.create(bytes, { tenant: tenant(52) })).status).toBe(429);
  });

  test("per-tenant daily byte budget is charged atomically at create", async () => {
    const bytes = await audio("stereo");
    h.ctx.config.limits.tenantDailyBytes = Math.floor(bytes.byteLength * 2.5);
    for (let i = 0; i < 2; i++) {
      const res = await h.create(bytes);
      expect(res.status).toBe(201);
      await h.api(`/v1/transcriptions/${(await res.json()).id}/cancel`, { method: "POST" });
    }
    const over = await h.create(bytes);
    expect(over.status).toBe(429);
    expect(await errorOf(over)).toMatchObject({ code: "quota_exceeded", retry_after_seconds: expect.any(Number) });
    expect((await h.create(bytes, { tenant: TENANT_B })).status).toBe(201);
  });

  test("disk high-water stops creates and uploads and degrades health", async () => {
    const bytes = await audio("stereo");
    const created = await (await h.create(bytes)).json();
    h.ctx.config.limits.diskHighWaterPercent = 1;
    const refused = await h.create(bytes, { tenant: TENANT_B });
    expect({ status: refused.status, code: (await errorOf(refused)).code }).toEqual({ status: 429, code: "service_busy" });
    const put = await h.put(created.id, created.upload.capability, bytes);
    expect({ status: put.status, code: (await errorOf(put)).code }).toEqual({ status: 429, code: "service_busy" });
    expect((await h.row(created.id)).status).toBe("awaiting_upload");
    const health = await h.api("/health");
    expect(health.status).toBe(503);
    expect((await health.json()).status).toBe("degraded");
  });

  test("admission drain refuses creates but still accepts uploads; closed refuses both", async () => {
    const bytes = await audio("stereo");
    const created = await (await h.create(bytes)).json();
    const drain = await h.api("/v1/admin/admission", { method: "PUT", key: h.keys.admin, json: { mode: "drain" } });
    expect(await drain.json()).toMatchObject({ mode: "drain", active: { awaiting_upload: 1, queued: 0, processing: 0 }, retention_lag_seconds: 0 });
    expect((await errorOf(await h.create(bytes, { tenant: TENANT_B }))).code).toBe("service_paused");
    await h.api("/v1/admin/admission", { method: "PUT", key: h.keys.admin, json: { mode: "closed" } });
    const closedPut = await h.put(created.id, created.upload.capability, bytes);
    expect({ status: closedPut.status, code: (await errorOf(closedPut)).code }).toEqual({ status: 503, code: "service_paused" });
    await h.api("/v1/admin/admission", { method: "PUT", key: h.keys.admin, json: { mode: "drain" } });
    expect((await h.put(created.id, created.upload.capability, bytes)).status).toBe(201);
    expect((await (await h.api("/v1/transcriptions/capabilities")).json()).admission).toBe("drain");
  });

  test("closing admission stops a PUT already streaming; the job stays awaiting_upload and uploads after reopening", async () => {
    const bytes = await audio("stereo");
    const job = await (await h.create(bytes)).json();
    h.ctx.config.upload.leaseHeartbeatSeconds = 0.02;
    const streaming = h.put(job.id, job.upload.capability, trickle(bytes, 20, 20), { contentLength: bytes.byteLength });
    await Bun.sleep(100);
    await h.api("/v1/admin/admission", { method: "PUT", key: h.keys.admin, json: { mode: "closed" } });
    const cut = await streaming;
    h.ctx.config.upload.leaseHeartbeatSeconds = 10;
    expect({ status: cut.status, code: (await errorOf(cut)).code }).toEqual({ status: 503, code: "service_paused" });
    expect(await h.row(job.id)).toMatchObject({ status: "awaiting_upload", uploadLeaseToken: null });
    expect(await readdir(jobDir(h.uploadDir, job.id))).toEqual([]);
    await h.api("/v1/admin/admission", { method: "PUT", key: h.keys.admin, json: { mode: "open" } });
    expect((await h.put(job.id, job.upload.capability, bytes)).status).toBe(201);
  });

  test("an upload is not committed once admission has closed, even after its bytes were verified", async () => {
    const bytes = await audio("stereo");
    const job = await (await h.create(bytes)).json();
    h.faults.once("upload.after_rename", async () => {
      await h.api("/v1/admin/admission", { method: "PUT", key: h.keys.admin, json: { mode: "closed" } });
    });
    const res = await h.put(job.id, job.upload.capability, bytes);
    expect({ status: res.status, code: (await errorOf(res)).code }).toEqual({ status: 503, code: "service_paused" });
    expect(await h.row(job.id)).toMatchObject({ status: "awaiting_upload", uploadLeaseToken: null });
    expect(await readdir(jobDir(h.uploadDir, job.id))).toEqual([]);
  });

  test("capabilities needs no X-Tenant-Ref (service-wide), every other transcription route does", async () => {
    expect((await h.api("/v1/transcriptions/capabilities", { tenant: null })).status).toBe(200);
    for (const [method, path] of [["GET", "/v1/transcriptions"], ["GET", "/v1/transcriptions/trn_01M3PQ71Q9YF7GSEFP6S19ZJPW"]] as const) {
      const res = await h.api(path, { method, tenant: null });
      expect({ path, status: res.status, code: (await errorOf(res)).code }).toEqual({ path, status: 400, code: "invalid_request" });
    }
  });

  test("capabilities list every accepted container and report diarization unavailable", async () => {
    expect(await (await h.api("/v1/transcriptions/capabilities")).json()).toMatchObject({
      content_types: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/webm", "audio/flac"],
      diarization: false,
    });
  });

  test("with the diarization stage installed, capabilities offer it and diarize: true creates a mixed-mode job", async () => {
    h.ctx.diarizer = { diarize: async () => [] };
    try {
      expect(await (await h.api("/v1/transcriptions/capabilities")).json()).toMatchObject({ diarization: true });
      const res = await h.create(await audio("stereo"), { body: { diarize: true } });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ diarize: true, channel_mode: "mixed" });
    } finally {
      h.ctx.diarizer = null;
    }
  });

  test("a replay whose job row is purged between the two reads becomes an ordinary create", async () => {
    const bytes = await audio("stereo");
    const key = { "Idempotency-Key": "tc:purged" };
    const body = { content_type: "audio/mpeg", byte_size: bytes.byteLength, sha256: sha256(bytes) };
    const first = await (await h.api("/v1/transcriptions", { method: "POST", headers: key, json: body })).json();
    await h.api(`/v1/transcriptions/${first.id}/cancel`, { method: "POST" });
    const { createTranscription, parseCreateBody } = await import("../../src/uploads/service.ts");
    // The purge lands exactly between the fast-path read and the replay transaction.
    const db = new Proxy(h.ctx.db, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver);
        return async (fn: never) => {
          await target.delete(transcriptions).where(eq(transcriptions.id, first.id));
          return target.transaction(fn);
        };
      },
    });
    const result = await createTranscription({ ...h.ctx, db }, "tinychat", TENANT_A, "tc:purged", parseCreateBody(body, h.ctx.config.limits.maxBytes));
    expect(result.created).toBe(true);
    expect(result.job.id).not.toBe(first.id);
    expect(result.upload).not.toBeNull();
  });

  test("fails fast with service_unavailable when no worker is live or the provider is not configured", async () => {
    const bytes = await audio("stereo");
    await h.ctx.db.update(transcriptionWorkers).set({ observedAt: new Date(0) });
    const res = await h.create(bytes);
    expect({ status: res.status, code: (await errorOf(res)).code }).toEqual({ status: 503, code: "service_unavailable" });
    const health = await (await h.api("/health")).json();
    expect(health.checks.upload_transcription).toMatchObject({ ready: false, worker_live: false });
    await h.ctx.db.update(transcriptionWorkers).set({ observedAt: new Date() });
    const unconfigured = { ...h.ctx, provider: null };
    const { createBatchApp } = await import("../../src/roles/batch.ts");
    const app = createBatchApp(unconfigured);
    const r = await app.request("/v1/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${h.keys.transcriptions}`, "X-Tenant-Ref": TENANT_A, "Idempotency-Key": "k1", "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: "audio/mpeg", byte_size: 10, sha256: "0".repeat(64) }),
    });
    expect(r.status).toBe(503);
  });

  test("every response carries a correlation id; errors include it in the body", async () => {
    const res = await h.api("/v1/transcriptions/trn_01M3PQ71Q9YF7GSEFP6S19ZJPW", { headers: { "X-Correlation-Id": "req-123" } });
    expect(res.headers.get("x-correlation-id")).toBe("req-123");
    expect(await errorOf(res)).toEqual({ type: "not_found_error", code: "transcription_not_found", message: expect.any(String), correlation_id: "req-123" });
    const generated = await h.api("/v1/transcriptions/capabilities", { headers: { "X-Correlation-Id": "bad id with spaces" } });
    expect(generated.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
    const unauth = await h.api("/v1/transcriptions", { key: null });
    expect((await errorOf(unauth)).correlation_id).toBe(unauth.headers.get("x-correlation-id"));
  });
});

describe("tenant isolation", () => {
  test("another tenant cannot see, read, cancel or delete a job; lists are tenant-scoped", async () => {
    const id = await h.submit(await audio("stereo"));
    for (const [method, path] of [["GET", `/v1/transcriptions/${id}`], ["GET", `/v1/transcriptions/${id}/result`], ["POST", `/v1/transcriptions/${id}/cancel`], ["DELETE", `/v1/transcriptions/${id}`]] as const) {
      const res = await h.api(path, { method, tenant: TENANT_B });
      expect({ path, method, status: res.status, code: (await errorOf(res)).code }).toEqual({ path, method, status: 404, code: "transcription_not_found" });
    }
    expect((await (await h.api("/v1/transcriptions", { tenant: TENANT_B })).json()).data).toEqual([]);
    expect((await (await h.api("/v1/transcriptions")).json()).data.map((j: any) => j.id)).toEqual([id]);
    expect((await h.row(id)).status).toBe("queued");
  });
});

describe("upload capability", () => {
  test("concurrent replays of one create never exceed maxLiveCapabilities", async () => {
    const bytes = await audio("stereo");
    const key = { "Idempotency-Key": "tc:replay-race" };
    const body = { content_type: "audio/mpeg", byte_size: bytes.byteLength, sha256: sha256(bytes) };
    const created = await h.api("/v1/transcriptions", { method: "POST", headers: key, json: body });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const replays = await Promise.all(Array.from({ length: 12 }, () => h.api("/v1/transcriptions", { method: "POST", headers: key, json: body })));
    const outcomes = await Promise.all(replays.map(async (r) => r.status === 200 ? "200" : `${r.status} ${(await errorOf(r)).code}`));
    const max = h.ctx.config.upload.maxLiveCapabilities;
    expect(outcomes.sort()).toEqual([...Array(max - 1).fill("200"), ...Array(12 - (max - 1)).fill("429 upload_capability_limit")]);
    const live = await h.ctx.db.select().from(transcriptionCapabilities).where(eq(transcriptionCapabilities.transcriptionId, id));
    expect(live.length).toBe(max);
  });

  test("is bound to one job, never reads status, expires, and at most 5 are live (no revocation)", async () => {
    const bytes = await audio("stereo");
    const a = await (await h.create(bytes)).json();
    const b = await (await h.create(bytes, { tenant: TENANT_B })).json();
    // Bound to its job.
    const cross = await h.put(b.id, a.upload.capability, bytes);
    expect({ status: cross.status, code: (await errorOf(cross)).code }).toEqual({ status: 401, code: "upload_capability_invalid" });
    // Grants no read access.
    expect((await h.api(`/v1/transcriptions/${a.id}`, { key: a.upload.capability })).status).toBe(401);
    // Replays add capabilities up to 5 live without revoking earlier ones.
    const key = { "Idempotency-Key": "tc:caps" };
    const body = { content_type: "audio/mpeg", byte_size: bytes.byteLength, sha256: sha256(bytes) };
    const caps: string[] = [];
    for (let i = 0; i < 5; i++) caps.push((await (await h.api("/v1/transcriptions", { method: "POST", tenant: tenant(9), headers: key, json: body })).json()).upload.capability);
    const sixth = await h.api("/v1/transcriptions", { method: "POST", tenant: tenant(9), headers: key, json: body });
    expect(await errorOf(sixth)).toMatchObject({ code: "upload_capability_limit", retry_after_seconds: expect.any(Number) });
    const jobId = (await (await h.api("/v1/transcriptions/by-idempotency-key", { tenant: tenant(9), headers: key })).json()).id;
    // Expired → 410.
    await h.ctx.db.update(transcriptionCapabilities).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(transcriptionCapabilities.tokenHash, (await import("../../src/uploads/capability.ts")).hashCapability(caps[0]!)));
    const expired = await h.put(jobId, caps[0]!, bytes);
    expect({ status: expired.status, code: (await errorOf(expired)).code }).toEqual({ status: 410, code: "upload_capability_expired" });
    // The first-issued live capability (never revoked by later replays) still uploads.
    expect((await h.put(jobId, caps[1]!, bytes)).status).toBe(201);
  });

  test("a PUT that aborts without committing leaves every capability usable: another one then uploads", async () => {
    const bytes = await audio("stereo");
    const key = { "Idempotency-Key": "tc:abort" };
    const body = { content_type: "audio/mpeg", byte_size: bytes.byteLength, sha256: sha256(bytes) };
    const first = await (await h.api("/v1/transcriptions", { method: "POST", headers: key, json: body })).json();
    const second = await (await h.api("/v1/transcriptions", { method: "POST", headers: key, json: body })).json();
    const aborted = await h.put(first.id, first.upload.capability, trickle(bytes, 4, 1, { errorAfter: 2 }), { contentLength: bytes.byteLength });
    expect({ status: aborted.status, code: (await errorOf(aborted)).code }).toEqual({ status: 408, code: "upload_interrupted" });
    expect(await h.row(first.id)).toMatchObject({ status: "awaiting_upload", uploadLeaseToken: null });
    expect((await h.put(second.id, second.upload.capability, bytes)).status).toBe(201);
  });

  test("two concurrent PUTs with different capabilities: the lease serializes them, exactly one is accepted", async () => {
    const bytes = await audio("stereo");
    const key = { "Idempotency-Key": "tc:race" };
    const body = { content_type: "audio/mpeg", byte_size: bytes.byteLength, sha256: sha256(bytes) };
    const first = await (await h.api("/v1/transcriptions", { method: "POST", headers: key, json: body })).json();
    const second = await (await h.api("/v1/transcriptions", { method: "POST", headers: key, json: body })).json();
    const [x, y] = await Promise.all([
      h.put(first.id, first.upload.capability, trickle(bytes, 4, 30), { contentLength: bytes.byteLength }),
      Bun.sleep(20).then(() => h.put(second.id, second.upload.capability, bytes)),
    ]);
    expect([x.status, y.status]).toEqual([201, 409]);
    expect((await errorOf(y)).code).toBe("upload_in_progress");
    // After acceptance the other capability is dead too (post-acceptance contract).
    const late = await h.put(second.id, second.upload.capability, bytes);
    expect({ status: late.status, code: (await errorOf(late)).code }).toEqual({ status: 401, code: "upload_capability_invalid" });
  });
});

describe("upload CORS", () => {
  const ALLOWED = "http://localhost:5173";
  const corsApp = () => createBatchApp(h.withContext({ config: { ...h.ctx.config, corsOrigins: parseCorsOrigins(`${ALLOWED},https://*.tinychat-4jq.pages.dev`) } }));
  const preflight = (origin: string, { app = corsApp(), path = "/uploads/trn_01M3PQ71Q9YF7GSEFP6S19ZJPW" } = {}) => app.request(path, {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,content-type" },
  });

  test("an allowed origin gets the preflight headers, without credentials", async () => {
    for (const origin of [ALLOWED, "https://feat-x.tinychat-4jq.pages.dev"]) {
      const res = await preflight(origin);
      expect(res.status).toBe(204);
      expect(Object.fromEntries(res.headers)).toMatchObject({
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "PUT, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type",
        "access-control-max-age": "600",
        vary: "Origin",
      });
      expect(res.headers.has("access-control-allow-credentials")).toBe(false);
    }
  });

  test("a disallowed origin, an unconfigured service and non-upload routes get no CORS headers", async () => {
    const denied = await preflight("https://evil.example");
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(denied.headers.get("vary")).toBe("Origin");
    expect((await preflight(ALLOWED, { app: createBatchApp(h.ctx) })).headers.get("access-control-allow-origin")).toBeNull();
    expect((await preflight(ALLOWED, { path: "/v1/transcriptions" })).headers.get("access-control-allow-origin")).toBeNull();
  });

  test("the PUT and its error answers carry the allow-origin header for an allowed origin", async () => {
    const app = corsApp();
    const bytes = await audio("stereo");
    const job = await (await h.create(bytes)).json();
    const put = (contentType: string) => app.request(`/uploads/${job.id}`, {
      method: "PUT",
      headers: { Origin: ALLOWED, Authorization: `Bearer ${job.upload.capability}`, "Content-Type": contentType, "Content-Length": String(bytes.byteLength) },
      body: bytes,
    });
    const wrongType = await put("audio/wav");
    expect({ status: wrongType.status, origin: wrongType.headers.get("access-control-allow-origin") }).toEqual({ status: 415, origin: ALLOWED });
    const accepted = await put("audio/mpeg");
    expect({ status: accepted.status, origin: accepted.headers.get("access-control-allow-origin"), vary: accepted.headers.get("vary") })
      .toEqual({ status: 201, origin: ALLOWED, vary: "Origin" });
  });
});

describe("upload contract", () => {
  test("a PUT after acceptance gets 401 upload_capability_invalid and changes nothing; status is the recovery path", async () => {
    const bytes = await audio("stereo");
    const job = await (await h.create(bytes)).json();
    expect((await h.put(job.id, job.upload.capability, bytes)).status).toBe(201);
    const before = await h.row(job.id);
    const replay = await h.put(job.id, job.upload.capability, bytes);
    expect({ status: replay.status, code: (await errorOf(replay)).code }).toEqual({ status: 401, code: "upload_capability_invalid" });
    const after = await h.row(job.id);
    expect(after).toEqual(before);
    expect(await readdir(jobDir(h.uploadDir, job.id))).toEqual([before.audioFile!]);
    expect((await (await h.api(`/v1/transcriptions/${job.id}`)).json()).status).toBe("queued");
    expect(await h.ctx.db.select().from(transcriptionCapabilities).where(eq(transcriptionCapabilities.transcriptionId, job.id))).toEqual([]);
  });

  // A lost/failed response at every transition converges through GET status: before the commit the job
  // is still awaiting_upload (whole-file retry succeeds exactly once), after it the job is queued.
  for (const point of ["upload.after_temp_write", "upload.after_hash_verify", "upload.after_probe", "upload.after_rename", "upload.after_commit"] as const) {
    test(`response loss at ${point} converges via status with exactly one accepted upload and one dispatch per region`, async () => {
      const bytes = await audio("stereo");
      const job = await (await h.create(bytes)).json();
      h.faults.once(point, "error");
      const lost = await h.put(job.id, job.upload.capability, bytes);
      expect(lost.status).toBe(500);
      const status = (await (await h.api(`/v1/transcriptions/${job.id}`)).json()).status;
      if (point === "upload.after_commit") {
        expect(status).toBe("queued");
        expect((await h.put(job.id, job.upload.capability, bytes)).status).toBe(401);
      } else {
        expect(status).toBe("awaiting_upload");
        expect(await readdir(jobDir(h.uploadDir, job.id))).toEqual([]); // temp/final removed
        expect((await h.put(job.id, job.upload.capability, bytes)).status).toBe(201);
      }
      expect(await h.work()).toBe(true);
      expect((await h.row(job.id)).status).toBe("completed");
      expect(h.tinfoil.calls.length).toBe(2);
    });
  }

  test("a crash between rename and commit leaves a final file that reconciliation removes; the retry is accepted", async () => {
    const bytes = await audio("stereo");
    const job = await (await h.create(bytes)).json();
    h.faults.once("upload.after_rename", "crash");
    await h.put(job.id, job.upload.capability, bytes).catch(() => {});
    const crashed = await h.row(job.id);
    const lease = crashed.uploadLeaseToken!;
    expect({ status: crashed.status, lease: typeof lease }).toEqual({ status: "awaiting_upload", lease: "string" });
    expect(await exists(join(jobDir(h.uploadDir, job.id), audioName(lease)))).toBe(true);
    // A live-looking lease blocks a second PUT until it goes stale.
    expect((await errorOf(await h.put(job.id, job.upload.capability, bytes))).code).toBe("upload_in_progress");
    h.ctx.config.upload.leaseStaleSeconds = 0;
    await Bun.sleep(5);
    await runSweep(h.ctx);
    expect(await readdir(jobDir(h.uploadDir, job.id))).toEqual([]);
    expect((await h.put(job.id, job.upload.capability, bytes)).status).toBe(201);
  });

  test("length, type and truncated bodies are rejected without changing the job", async () => {
    const bytes = await audio("stereo");
    const job = await (await h.create(bytes)).json();
    const cases = [
      [await h.put(job.id, job.upload.capability, bytes, { contentLength: bytes.byteLength - 1 }), 400, "upload_length_mismatch"],
      [await h.put(job.id, job.upload.capability, bytes, { contentType: "audio/wav" }), 415, "unsupported_media_type"],
      [await h.put(job.id, job.upload.capability, trickle(bytes, 4, 1, { stopAfter: 2 }), { contentLength: bytes.byteLength }), 408, "upload_interrupted"],
      [await h.put(job.id, job.upload.capability, trickle(bytes, 4, 1, { errorAfter: 2 }), { contentLength: bytes.byteLength }), 408, "upload_interrupted"],
    ] as const;
    for (const [res, status, code] of cases) expect({ status: res.status, code: (await errorOf(res)).code }).toEqual({ status, code });
    expect(await h.row(job.id)).toMatchObject({ status: "awaiting_upload", uploadLeaseToken: null });
    expect(await readdir(jobDir(h.uploadDir, job.id))).toEqual([]);
    expect((await h.put(job.id, job.upload.capability, bytes)).status).toBe(201);
  });

  test("a stalled, a too-slow and an over-long PUT are cut off; heartbeats never move the hard expiry", async () => {
    const bytes = await audio("stereo");
    const job = await (await h.create(bytes)).json();
    h.ctx.config.upload.idleTimeoutSeconds = 0.1;
    const stalled = await h.put(job.id, job.upload.capability, trickle(bytes, 2, 300), { contentLength: bytes.byteLength });
    expect(await errorOf(stalled)).toMatchObject({ code: "upload_interrupted", message: "The upload stalled" });
    h.ctx.config.upload.idleTimeoutSeconds = 60;

    Object.assign(h.ctx.config.upload, { progressGraceSeconds: 0.05, minBytesPerSecond: 10_000_000 });
    const slow = await h.put(job.id, job.upload.capability, trickle(bytes, 10, 20), { contentLength: bytes.byteLength });
    expect(await errorOf(slow)).toMatchObject({ code: "upload_interrupted", message: "The upload is too slow" });
    Object.assign(h.ctx.config.upload, { progressGraceSeconds: 60, minBytesPerSecond: 1 });

    Object.assign(h.ctx.config.upload, { maxPutSeconds: 0.3, leaseHeartbeatSeconds: 0.05 });
    const hardExpiries = new Set<number>();
    const watcher = setInterval(async () => {
      const row = await h.row(job.id);
      if (row.uploadLeaseHardExpiresAt) hardExpiries.add(row.uploadLeaseHardExpiresAt.getTime());
    }, 25);
    const long = await h.put(job.id, job.upload.capability, trickle(bytes, 40, 20), { contentLength: bytes.byteLength });
    clearInterval(watcher);
    expect(await errorOf(long)).toMatchObject({ code: "upload_interrupted", message: "The upload exceeded its maximum duration" });
    expect(hardExpiries.size).toBe(1);
    Object.assign(h.ctx.config.upload, { maxPutSeconds: 1_800, leaseHeartbeatSeconds: 10 });
    expect((await h.row(job.id)).status).toBe("awaiting_upload");
  });

  test("the lease hard expiry is clamped to the job's upload deadline", async () => {
    const bytes = await audio("stereo");
    const job = await (await h.create(bytes)).json();
    await h.ctx.db.update(transcriptions).set({ uploadDeadlineAt: new Date(Date.now() + 150) }).where(eq(transcriptions.id, job.id));
    const res = await h.put(job.id, job.upload.capability, trickle(bytes, 20, 20), { contentLength: bytes.byteLength });
    expect(await errorOf(res)).toMatchObject({ code: "upload_interrupted", message: "The upload exceeded its maximum duration" });
  });

  test("service-wide concurrent PUT limit", async () => {
    h.ctx.config.limits.maxConcurrentUploads = 1;
    const bytes = await audio("stereo");
    const a = await (await h.create(bytes)).json();
    const b = await (await h.create(bytes, { tenant: TENANT_B })).json();
    const [first, second] = await Promise.all([
      h.put(a.id, a.upload.capability, trickle(bytes, 5, 40), { contentLength: bytes.byteLength }),
      Bun.sleep(30).then(() => h.put(b.id, b.upload.capability, bytes)),
    ]);
    expect(first.status).toBe(201);
    expect({ status: second.status, code: (await errorOf(second)).code }).toEqual({ status: 429, code: "service_busy" });
    expect((await h.put(b.id, b.upload.capability, bytes)).status).toBe(201);
  });
});

describe("upload validation fails the job and deletes its bytes", () => {
  const cases = [
    ["sha256 mismatch", "stereo", "audio/mpeg", { sha256: "0".repeat(64) }, "upload_integrity_failed"],
    ["declared wav, bytes are mp3", "stereo", "audio/wav", {}, "invalid_audio"],
    ["declared mp4, bytes are wav", "mono_wav", "audio/mp4", {}, "invalid_audio"],
    ["declared webm, bytes are m4a", "stereo_m4a", "audio/webm", {}, "invalid_audio"],
    ["three channels", "three_channel_wav", "audio/wav", {}, "unsupported_recording"],
    ["over the 7,200 s cap", "over_cap_mp3", "audio/mpeg", {}, "recording_too_long"],
  ] as const;
  for (const [label, fixture, contentType, body, code] of cases) {
    test(label, async () => {
      const bytes = await audio(fixture);
      const job = await (await h.create(bytes, { contentType, body })).json();
      const res = await h.put(job.id, job.upload.capability, bytes, { contentType });
      expect(res.status).toBe(422);
      expect(await errorOf(res)).toMatchObject({ code: "upload_rejected", status: "failed", job_error: { code } });
      expect(await h.row(job.id)).toMatchObject({ status: "failed", errorCode: code, deletionState: "files_deleted" });
      expect(await exists(jobDir(h.uploadDir, job.id))).toBe(false);
      expect((await h.put(job.id, job.upload.capability, bytes, { contentType })).status).toBe(401);
    }, 60_000); // generating the real 7,201 s fixture takes seconds on CI runners
  }
});

describe("measuring a recording without a container duration is bounded", () => {
  const upload = async (bytes: Uint8Array) => {
    const job = await (await h.create(bytes, { contentType: "audio/webm" })).json();
    const res = await h.put(job.id, job.upload.capability, bytes, { contentType: "audio/webm" });
    return { job, res, error: await errorOf(res) };
  };

  test("more packets than the duration cap allows fails recording_too_long, whatever the timestamps claim", async () => {
    h.ctx.config.limits.maxDurationSeconds = 60; // at most 24,000 packets of 2.5 ms
    const { job, res, error } = await upload(laceBombWebm(200)); // 51,200 packets whose timestamps span 2 s
    expect(res.status).toBe(422);
    expect(error).toMatchObject({ code: "upload_rejected", job_error: { code: "recording_too_long" } });
    expect(h.tinfoil.calls.length).toBe(0);
    expect(await exists(jobDir(h.uploadDir, job.id))).toBe(false);
  });

  test("a scan past its wall-clock budget is stopped: the PUT fails invalid_audio within the budget", async () => {
    h.ctx.config.limits.durationScanSeconds = 0.3;
    const bytes = laceBombWebm(4_000); // ~1M packets: seconds of ffprobe if nothing stopped it
    const started = Date.now();
    const { res, error } = await upload(bytes);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(res.status).toBe(422);
    expect(error).toMatchObject({ code: "upload_rejected", job_error: { code: "invalid_audio" } });
  }, 30_000);
});

describe("deadlines", () => {
  test("an upload not accepted by the deadline fails upload_expired", async () => {
    const bytes = await audio("stereo");
    const job = await (await h.create(bytes)).json();
    await h.ctx.db.update(transcriptions).set({ uploadDeadlineAt: new Date(Date.now() - 1000) }).where(eq(transcriptions.id, job.id));
    await runSweep(h.ctx);
    const status = await (await h.api(`/v1/transcriptions/${job.id}`)).json();
    expect(status).toMatchObject({ status: "failed", error: { code: "upload_expired" }, retention: { audio: "deleted" } });
  });
});
