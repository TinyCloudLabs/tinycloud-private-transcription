import { afterAll, expect, spyOn, test } from "bun:test";
import { RedisClient } from "bun";
import { Hono } from "hono";
import { createApp } from "../../src/api/app.ts";
import type { AuthEnv } from "../../src/api/auth.ts";
import { processJob } from "../../src/worker/index.ts";
import { createBatchRoutes } from "../../src/uploads/routes.ts";
import type { BatchContext } from "../../src/uploads/context.ts";
import { realtimeRequestHarness } from "../support/realtime-request.ts";
import { Queue } from "../../src/worker/queue.ts";

const redis = new RedisClient("redis://127.0.0.1:56379");
const queues: Queue[] = [];
function realQueue() {
  const queue = new Queue(redis, `test:realtime:${crypto.randomUUID()}`);
  queues.push(queue);
  return queue;
}
afterAll(async () => {
  for (const queue of queues) await queue.clear();
  redis.close();
});

const UUID = "a8098c1a-f86e-4b1f-92a7-4b50b53ec932";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AUTH = { authorization: "Bearer tc_live_SYNTHETIC_API_TOKEN" };
const PRIVATE = "PRIVATE_PAYLOAD_TOKEN_ERROR";

for (const presented of [UUID, UUID.toUpperCase()]) {
  test(`realtime accepts and lowercases canonical UUID ${presented}`, async () => {
    const { ctx } = realtimeRequestHarness("http://127.0.0.1:1");
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await createApp(ctx).request("/v1/meetings/missing", { headers: { ...AUTH, "x-request-id": presented } });
      expect(response.status).toBe(404);
      expect(response.headers.get("x-request-id")).toBe(UUID);
      const events = output.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(events.filter((e) => e.event === "ptx_realtime_request")).toHaveLength(1);
      expect(events[0]).toMatchObject({ request_id: UUID, request_id_replaced: false, method: "GET", route: "/v1/meetings/:id", status: 404 });
    } finally { output.mockRestore(); }
  });
}

for (const presented of [undefined, "not-a-uuid", `${UUID},${UUID}`, "00000000-0000-0000-0000-000000000000", "a8098c1a-f86e-0b1f-92a7-4b50b53ec932", "a8098c1a-f86e-4b1f-72a7-4b50b53ec932", "f".repeat(2048)]) {
  test(`realtime mints a UUID for ${presented?.slice(0, 40) ?? "absent header"}`, async () => {
    const { ctx } = realtimeRequestHarness("http://127.0.0.1:1");
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      const headers: Record<string, string> = presented === undefined ? {} : { "x-request-id": presented };
      const response = await createApp(ctx).request("/v1/meetings", { headers });
      expect(response.status).toBe(401);
      const id = response.headers.get("x-request-id");
      expect(id).toMatch(UUID_PATTERN);
      expect(id).not.toBe(presented);
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ request_id: id, request_id_replaced: presented !== undefined, status: 401 });
    } finally { output.mockRestore(); }
  });
}

test("API create retains serialized local worker IDs without disclosing them to providers", async () => {
  const received: Array<{ id: string | null; nativeId: string }> = [];
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const release = Promise.withResolvers<void>();
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as { native_meeting_id: string };
    const index = body.native_meeting_id.includes("first") ? 0 : 1;
    entered[index]!.resolve();
    await release.promise;
    received.push({ id: req.headers.get("x-request-id"), nativeId: body.native_meeting_id });
    return new Response(PRIVATE, { status: 429 });
  } });
  const { ctx } = realtimeRequestHarness(provider.url.origin);
  ctx.queue = realQueue();
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    const app = createApp(ctx);
    const ids = [UUID, "019a0000-1234-7000-b123-123456789abc"];
    // Each worker reads its meeting before the next create replaces this harness's single row.
    const workers: Promise<unknown>[] = [];
    for (const [index, id] of ids.entries()) {
      const response = await app.request("/v1/meetings", {
        method: "POST", headers: { ...AUTH, "content-type": "application/json", "x-request-id": id.toUpperCase() },
        body: JSON.stringify({ meeting_url: `https://jitsi.local/${index ? "second" : "first"}-${PRIVATE}`, metadata: { token: PRIVATE } }),
      });
      expect(response.status).toBe(201);
      const job = (await ctx.queue.pop(0.1))!;
      expect(job.requestId).toBe(id);
      workers.push(processJob(ctx, job));
      await entered[index]!.promise;
    }
    release.resolve();
    await Promise.all(workers);
    expect(received.map((r) => r.id)).toEqual([null, null]);
    const retries = (await ctx.queue.pending()).delayed.map(({ job }) => job);
    expect(retries.map((job) => job.requestId).sort()).toEqual([...ids].sort());
    // Run a delayed continuation outside all API async scopes.
    await processJob(ctx, retries.find((job) => job.requestId === ids[1])!);
    expect(received.at(-1)?.id).toBeNull();
    const lines = output.mock.calls.map(([line]) => String(line));
    expect(lines.join("\n")).not.toContain(PRIVATE);
    expect(lines.join("\n")).not.toContain("SYNTHETIC_API_TOKEN");
    expect(lines.join("\n")).not.toContain("SYNTHETIC_PROVIDER_TOKEN");
    const events = lines.map((line) => JSON.parse(line)).filter((event) => event.event === "ptx_realtime_worker");
    expect(events.map((event) => event.request_id).sort()).toEqual([ids[0], ids[1], ids[1]].sort());
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(["ts", "level", "msg", "event", "request_id", "request_id_replaced", "job_type", "outcome", "duration_ms"].sort());
      expect(event).toMatchObject({ request_id_replaced: false, job_type: "meeting.start", outcome: "processed" });
    }
  } finally { output.mockRestore(); provider.stop(true); }
});

test("typed request events exclude raw path, query, body, bearer, native ID and thrown error text", async () => {
  const { ctx } = realtimeRequestHarness("http://127.0.0.1:1");
  const routes = new Hono<AuthEnv>().post("/:id/stop", () => { throw new Error(PRIVATE); });
  const app = createApp(ctx, { "/v1/meetings": { scope: "meetings:*", routes } });
  const output = spyOn(console, "log").mockImplementation(() => {});
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await app.request(`/v1/meetings/${PRIVATE}/stop?token=${PRIVATE}`, {
      method: "POST", headers: { ...AUTH, "x-request-id": UUID }, body: PRIVATE,
    });
    expect(response.status).toBe(500);
    const unknown = await app.request(`/${PRIVATE}?url=https://private.example/${PRIVATE}`, { method: "PATCH" });
    expect(unknown.status).toBe(404);
    const lines = output.mock.calls.map(([line]) => String(line));
    expect([...lines, ...errors.mock.calls.flat().map(String)].join("\n")).not.toContain(PRIVATE);
    expect(lines.join("\n")).not.toContain("SYNTHETIC_API_TOKEN");
    const events = lines.map((line) => JSON.parse(line)).filter((event) => event.event === "ptx_realtime_request");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ request_id: UUID, method: "POST", route: "/v1/meetings/:id/stop", status: 500 });
    expect(events[1]).toMatchObject({ route: "unmatched", method: "PATCH", status: 404 });
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(["ts", "level", "msg", "event", "request_id", "request_id_replaced", "method", "route", "status", "duration_ms"].sort());
      expect(Number.isSafeInteger(event.duration_ms)).toBe(true);
      expect(event.duration_ms).toBeGreaterThanOrEqual(0);
      expect(event.duration_ms).toBeLessThanOrEqual(86_400_000);
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(512);
    }
  } finally { output.mockRestore(); errors.mockRestore(); }
});

test("worker restores queued UUID locally outside HTTP scope without provider disclosure", async () => {
  const forwarded: Array<string | null> = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    forwarded.push(req.headers.get("x-request-id"));
    return new Response(PRIVATE, { status: 429 });
  } });
  const { ctx } = realtimeRequestHarness(provider.url.origin);
  ctx.queue = realQueue();
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    const response = await createApp(ctx).request("/v1/meetings", {
      method: "POST", headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ meeting_url: "https://jitsi.local/synthetic" }),
    });
    expect(response.status).toBe(201);
    await processJob(ctx, { ...(await ctx.queue.pop(0.1))!, requestId: UUID });
    expect(forwarded).toEqual([null]);
    const event = output.mock.calls.map(([line]) => JSON.parse(String(line))).find((event) => event.event === "ptx_realtime_worker");
    expect(event).toMatchObject({ request_id: UUID, request_id_replaced: false });
  } finally { output.mockRestore(); provider.stop(true); }
});

test("batch upload and transcription errors retain non-UUID X-Correlation-Id contract and no realtime header", async () => {
  const { ctx } = realtimeRequestHarness("http://127.0.0.1:1");
  const batch = createBatchRoutes({ ...ctx, config: { corsOrigins: [] } } as unknown as BatchContext);
  for (const [method, path] of [["POST", "/v1/transcriptions"], ["PUT", "/uploads/invalid"]]) {
    const response = await batch.request(path!, { method, headers: { "x-correlation-id": "batch.legacy:upload-1", "x-request-id": UUID } });
    expect(response.status).toBe(401);
    expect(response.headers.get("x-correlation-id")).toBe("batch.legacy:upload-1");
    expect(await response.json()).toMatchObject({ error: { correlation_id: "batch.legacy:upload-1" } });
    expect(response.headers.get("x-request-id")).toBeNull();
  }
});

test("worker rejects unrecognized job types without logging attacker-controlled fields", async () => {
  const { ctx } = realtimeRequestHarness("http://127.0.0.1:1");
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(processJob(ctx, { type: PRIVATE, requestId: PRIVATE } as never)).rejects.toBeInstanceOf(Error);
    const lines = output.mock.calls.map(([line]) => String(line));
    expect(lines.join("\n")).not.toContain(PRIVATE);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "ptx_realtime_worker", job_type: "unknown", outcome: "error" });
  } finally { output.mockRestore(); }
});

test("worker error event mints for malformed queued IDs without exposing thrown payloads", async () => {
  const { ctx } = realtimeRequestHarness("http://127.0.0.1:1");
  ctx.db.select = (() => { throw new Error(PRIVATE); }) as typeof ctx.db.select;
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(processJob(ctx, { type: "meeting.start", meetingId: PRIVATE, requestId: PRIVATE })).rejects.toBeInstanceOf(Error);
    const line = String(output.mock.calls[0]?.[0]);
    expect(line).not.toContain(PRIVATE);
    const event = JSON.parse(line);
    expect(event).toMatchObject({ event: "ptx_realtime_worker", request_id_replaced: true, job_type: "meeting.start", outcome: "error" });
    expect(event.request_id).toMatch(UUID_PATTERN);
  } finally { output.mockRestore(); }
});

test("request-scoped delayed removal cancels the exact enriched retry payload", async () => {
  const { ctx } = realtimeRequestHarness("http://127.0.0.1:1");
  ctx.queue = realQueue();
  const routes = new Hono<AuthEnv>().post("/", async (c) => {
    const job = { type: "meeting.poll", meetingId: "synthetic", pollToken: "lease" } as const;
    await ctx.queue.push(job, 60_000);
    expect((await ctx.queue.pending()).delayed.map(({ job }) => job.requestId)).toEqual([UUID]);
    expect(await ctx.queue.removeDelayed(job)).toBe(1);
    return c.body(null, 204);
  });
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    const response = await createApp(ctx, { "/v1/meetings": { scope: "meetings:*", routes } }).request("/v1/meetings", { method: "POST", headers: { ...AUTH, "x-request-id": UUID } });
    expect(response.status).toBe(204);
    expect(await ctx.queue.size()).toEqual({ ready: 0, delayed: 0 });
  } finally { output.mockRestore(); }
});

for (const [label, type] of [
  ["array", ["meeting.start"]],
  ["nested-array", [["meeting.start"]]],
  ["object", { type: "meeting.start" }],
  ["trailing-newline", "meeting.start\n"],
  ["prototype-name", "__proto__"],
] as const) {
  test(`worker event rejects non-enum job type ${label} without coercion`, async () => {
    const { ctx } = realtimeRequestHarness("http://127.0.0.1:1");
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(processJob(ctx, { type, requestId: UUID } as never)).rejects.toBeInstanceOf(Error);
      const event = JSON.parse(String(output.mock.calls[0]?.[0]));
      expect(event).toMatchObject({ job_type: "unknown", outcome: "error" });
      expect(typeof event.job_type).toBe("string");
    } finally { output.mockRestore(); }
  });
}
