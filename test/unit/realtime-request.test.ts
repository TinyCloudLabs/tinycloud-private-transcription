import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../../src/api/app.ts";
import type { AuthEnv } from "../../src/api/auth.ts";
import { processJob } from "../../src/worker/index.ts";
import { createBatchRoutes } from "../../src/uploads/routes.ts";
import type { BatchContext } from "../../src/uploads/context.ts";
import { realtimeRequestHarness } from "../support/realtime-request.ts";
import { LoopbackSignalCaptureAdapter } from "../../src/providers/signal/adapter.ts";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";

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
      expect(events[0]).toMatchObject({ request_id: UUID, method: "GET", route: "/v1/meetings/:id", status: 404 });
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
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ request_id: id, status: 401 });
    } finally { output.mockRestore(); }
  });
}

test("API create survives serialized queue handoff, worker retry and concurrent outbound contexts", async () => {
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
  const { ctx, ready, delayed } = realtimeRequestHarness(provider.url.origin);
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
      const job = JSON.parse(ready.pop()!);
      expect(job.requestId).toBe(id);
      workers.push(processJob(ctx, job));
      await entered[index]!.promise;
    }
    release.resolve();
    await Promise.all(workers);
    expect(received.sort((a, b) => a.nativeId.localeCompare(b.nativeId)).map((r) => r.id)).toEqual(ids);
    const retries = [...delayed.keys()].map((member) => JSON.parse(member.slice(0, member.lastIndexOf("|"))));
    expect(retries.map((job) => job.requestId).sort()).toEqual([...ids].sort());
    // Run a delayed continuation outside all API async scopes.
    await processJob(ctx, retries.find((job) => job.requestId === ids[1])!);
    expect(received.at(-1)?.id).toBe(ids[1]);
    const lines = output.mock.calls.map(([line]) => String(line));
    expect(lines.join("\n")).not.toContain(PRIVATE);
    expect(lines.join("\n")).not.toContain("SYNTHETIC_API_TOKEN");
    expect(lines.join("\n")).not.toContain("SYNTHETIC_PROVIDER_TOKEN");
    const events = lines.map((line) => JSON.parse(line)).filter((event) => event.event === "ptx_realtime_worker");
    expect(events.map((event) => event.request_id).sort()).toEqual([ids[0], ids[1], ids[1]].sort());
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(["ts", "level", "msg", "event", "request_id", "job_type", "outcome", "duration_ms"].sort());
      expect(event).toMatchObject({ job_type: "meeting.start", outcome: "processed" });
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
      expect(Object.keys(event).sort()).toEqual(["ts", "level", "msg", "event", "request_id", "method", "route", "status", "duration_ms"].sort());
      expect(Number.isSafeInteger(event.duration_ms)).toBe(true);
      expect(event.duration_ms).toBeGreaterThanOrEqual(0);
      expect(event.duration_ms).toBeLessThanOrEqual(86_400_000);
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(512);
    }
  } finally { output.mockRestore(); errors.mockRestore(); }
});

test("worker restores queued UUID at the external edge even outside any HTTP scope", async () => {
  const forwarded: Array<string | null> = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    forwarded.push(req.headers.get("x-request-id"));
    return new Response(PRIVATE, { status: 429 });
  } });
  const { ctx, ready } = realtimeRequestHarness(provider.url.origin);
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    const response = await createApp(ctx).request("/v1/meetings", {
      method: "POST", headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ meeting_url: "https://jitsi.local/synthetic" }),
    });
    expect(response.status).toBe(201);
    await processJob(ctx, { ...JSON.parse(ready.pop()!), requestId: UUID });
    expect(forwarded).toEqual([UUID]);
  } finally { output.mockRestore(); provider.stop(true); }
});

test("realtime async context reaches Signal and Tinfoil without changing unscoped calls", async () => {
  const received: Array<{ path: string; id: string | null }> = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    received.push({ path: new URL(req.url).pathname, id: req.headers.get("x-request-id") });
    return Response.json({ status: "joining", text: "synthetic" });
  } });
  const { ctx } = realtimeRequestHarness(provider.url.origin);
  const signal = new LoopbackSignalCaptureAdapter(provider.url.origin);
  const tinfoil = new TinfoilTranscriptionProvider({ baseUrl: provider.url.origin, apiKey: PRIVATE, model: "synthetic" });
  const call = async () => {
    await signal.status(`sig_${UUID}`);
    await tinfoil.transcribeRecordingWindows([{ samples: new Int16Array(800).fill(500), sampleRate: 8000, durationSec: 0.1 }], null, "synthetic", Date.now() + 10_000);
  };
  const routes = new Hono<AuthEnv>().get("/", async (c) => { await call(); return c.json({ ok: true }); });
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    const response = await createApp(ctx, { "/v1/meetings": { scope: "meetings:*", routes } }).request("/v1/meetings", { headers: { ...AUTH, "x-request-id": UUID } });
    expect(response.status).toBe(200);
    expect(received).toEqual([
      { path: `/v1/calls/sig_${UUID}`, id: UUID },
      { path: "/v1/audio/transcriptions", id: UUID },
    ]);
    received.length = 0;
    await call();
    expect(received.map((r) => r.id)).toEqual([null, null]);
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
    expect(event).toMatchObject({ event: "ptx_realtime_worker", job_type: "meeting.start", outcome: "error" });
    expect(event.request_id).toMatch(UUID_PATTERN);
  } finally { output.mockRestore(); }
});

test("request-scoped delayed removal cancels the exact enriched retry payload", async () => {
  const { ctx, delayed } = realtimeRequestHarness("http://127.0.0.1:1");
  const routes = new Hono<AuthEnv>().post("/", async (c) => {
    const job = { type: "meeting.poll", meetingId: "synthetic", pollToken: "lease" } as const;
    await ctx.queue.push(job, 60_000);
    expect([...delayed.keys()].map((member) => JSON.parse(member.slice(0, member.lastIndexOf("|"))).requestId)).toEqual([UUID]);
    expect(await ctx.queue.removeDelayed(job)).toBe(1);
    return c.body(null, 204);
  });
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    const response = await createApp(ctx, { "/v1/meetings": { scope: "meetings:*", routes } }).request("/v1/meetings", { method: "POST", headers: { ...AUTH, "x-request-id": UUID } });
    expect(response.status).toBe(204);
    expect(delayed.size).toBe(0);
  } finally { output.mockRestore(); }
});
