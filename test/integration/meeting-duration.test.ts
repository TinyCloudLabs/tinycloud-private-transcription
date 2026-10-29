import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApiKey } from "../../src/api/auth.ts";
import { meetings } from "../../src/db/schema.ts";
import { getMeetingById, stopMeetingIfDurationElapsed } from "../../src/services/meetings.ts";
import { startWorker, type WorkerHandle } from "../../src/worker/index.ts";
import { startHarness, type Harness } from "./harness.ts";

interface MeetingView {
  id: string;
  status: string;
  meeting_url: string;
  created_at: string;
  max_duration_seconds: number;
  scheduled_stop_at: string | null;
}

let h: Harness;
let resumed: WorkerHandle | undefined;
// Uses persisted Postgres deadlines and actual worker heartbeats. Details: TC-2185
beforeEach(async () => {
  h = await startHarness({ maxConcurrentBots: 100, workerPopTimeoutSec: .05, workerHeartbeatIntervalMs: 25 });
  await h.worker.stop();
}, 20_000);
afterEach(async () => {
  await resumed?.stop();
  resumed = undefined;
  await h?.stop();
});

async function create(overrides: Record<string, unknown> = {}): Promise<MeetingView> {
  const response = await h.api("/v1/meetings", { method: "POST", json: {
    meeting_url: `https://jitsi.local/Duration-${crypto.randomUUID()}`, ...overrides,
  } });
  expect(response.status).toBe(201);
  return response.json();
}

async function patch(id: string, json: unknown): Promise<MeetingView> {
  const response = await h.api(`/v1/meetings/${id}`, { method: "PATCH", json });
  expect(response.status).toBe(200);
  return response.json();
}

test("create persists an explicit stop deadline, including the capped No limit choice. Details: TC-2185", async () => {
  for (const [input, seconds] of [[{}, 14_400], [{ max_duration_seconds: 1 }, 1], [{ max_duration_seconds: 14_400 }, 14_400], [{ max_duration_seconds: null }, 14_400]] as const) {
    const meeting = await create(input);
    expect(meeting.max_duration_seconds).toBe(seconds);
    expect(Date.parse(meeting.scheduled_stop_at!) - Date.parse(meeting.created_at)).toBe(seconds * 1000);
    const fetched: MeetingView = await (await h.api(`/v1/meetings/${meeting.id}`)).json();
    expect(fetched.scheduled_stop_at).toBe(meeting.scheduled_stop_at);
    expect(fetched.max_duration_seconds).toBe(seconds);
  }
});

test("create validates duration and keeps it in idempotent request identity. Details: TC-2185", async () => {
  for (const value of [0, -1, 1.5, 14_401, "900", true, [], {}]) {
    const response = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/DurationValidation", max_duration_seconds: value } });
    expect(response.status).toBe(400);
  }
  expect(await h.ctx.db.select().from(meetings)).toEqual([]);
  const json = { meeting_url: "https://jitsi.local/DurationIdempotency", max_duration_seconds: 120 };
  const headers = { "Idempotency-Key": "duration-create" };
  const first = await h.api("/v1/meetings", { method: "POST", headers, json });
  expect(first.status).toBe(201);
  const meeting: MeetingView = await first.json();
  const retry = await h.api("/v1/meetings", { method: "POST", headers, json });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ id: meeting.id, scheduled_stop_at: meeting.scheduled_stop_at });
  expect((await h.api("/v1/meetings", { method: "POST", headers, json: { ...json, max_duration_seconds: 121 } })).status).toBe(409);
});

test("live +15/+30 additions are atomic and No limit observes the four-hour cap. Details: TC-2185", async () => {
  const meeting = await create({ max_duration_seconds: 3600 });
  expect((await patch(meeting.id, { extend_by_seconds: 900 })).max_duration_seconds).toBe(4500);
  expect((await patch(meeting.id, { extend_by_seconds: 1800 })).max_duration_seconds).toBe(6300);
  await Promise.all([patch(meeting.id, { extend_by_seconds: 900 }), patch(meeting.id, { extend_by_seconds: 1800 })]);
  const concurrent: MeetingView = await (await h.api(`/v1/meetings/${meeting.id}`)).json();
  expect(concurrent.max_duration_seconds).toBe(9000);
  expect(Date.parse(concurrent.scheduled_stop_at!) - Date.parse(meeting.created_at)).toBe(9_000_000);
  const unlimited = await patch(meeting.id, { max_duration_seconds: null });
  expect(unlimited.max_duration_seconds).toBe(14_400);
  expect(Date.parse(unlimited.scheduled_stop_at!) - Date.parse(meeting.created_at)).toBe(14_400_000);
  expect((await patch(meeting.id, { extend_by_seconds: 1800 })).scheduled_stop_at).toBe(unlimited.scheduled_stop_at);
  expect((await patch(meeting.id, { max_duration_seconds: 7200 })).max_duration_seconds).toBe(7200);
});

test("duration updates validate choices and stay within the authenticated project. Details: TC-2185", async () => {
  const meeting = await create();
  for (const json of [null, [], {}, { extend_by_seconds: 60 }, { extend_by_seconds: "900" }, { max_duration_seconds: 0 }, { max_duration_seconds: 14_401 }, { max_duration_seconds: 1, extend_by_seconds: 900 }]) {
    expect((await h.api(`/v1/meetings/${meeting.id}`, { method: "PATCH", json })).status).toBe(400);
  }
  const foreign = await createApiKey(h.ctx, "duration-other-owner");
  expect((await h.api(`/v1/meetings/${meeting.id}`, { method: "PATCH", key: foreign.key, json: { extend_by_seconds: 900 } })).status).toBe(404);
  const unchanged: MeetingView = await (await h.api(`/v1/meetings/${meeting.id}`)).json();
  expect(unchanged.scheduled_stop_at).toBe(meeting.scheduled_stop_at);
  await h.ctx.db.update(meetings).set({ status: "processing" }).where(eq(meetings.id, meeting.id));
  expect((await h.api(`/v1/meetings/${meeting.id}`, { method: "PATCH", json: { max_duration_seconds: null } })).status).toBe(400);
});

test("an observed old deadline does not stop an extended meeting. Details: TC-2185", async () => {
  const meeting = await create();
  const observed = new Date();
  await h.ctx.db.update(meetings).set({ scheduledStopAt: new Date(observed.getTime() - 1000) }).where(eq(meetings.id, meeting.id));
  const extended = await patch(meeting.id, { extend_by_seconds: 900 });
  expect(await stopMeetingIfDurationElapsed(h.ctx, meeting.id, observed)).toBe(false);
  const row = await getMeetingById(h.ctx, meeting.id);
  expect(row?.status).toBe("queued");
  expect(row?.scheduledStopAt?.toISOString() ?? null).toBe(extended.scheduled_stop_at);
  expect(h.vexa.requests.filter((r) => r.method === "DELETE")).toEqual([]);
});

test("a restarted worker cancels an elapsed queued meeting before dispatch. Details: TC-2185", async () => {
  const meeting = await create();
  await h.ctx.db.update(meetings).set({ scheduledStopAt: new Date(Date.now() - 1000) }).where(eq(meetings.id, meeting.id));
  resumed = startWorker(h.ctx, { popTimeoutSec: .05, heartbeatIntervalMs: 25 });
  const cancelled = await h.waitFor(async () => {
    const row = await getMeetingById(h.ctx, meeting.id);
    return row?.status === "cancelled" ? row : null;
  });
  expect(cancelled.captureDiagnostics?.stop_requested_by).toBe("duration_limit");
  await resumed.stop();
  expect(h.vexa.requests.filter((r) => r.method === "POST" && r.path === "/bots")).toEqual([]);
});

test("persisted live expiry stops capture and finalizes after a worker restart without a client stop call. Details: TC-2185", async () => {
  const meeting = await create();
  const nativeId = `${new URL(meeting.meeting_url).pathname.slice(1)}@jitsi.local`;
  resumed = startWorker(h.ctx, { popTimeoutSec: .05, heartbeatIntervalMs: 25 });
  await h.waitFor(async () => h.vexa.meetings.has(`jitsi/${nativeId}`) ? true : null);
  const segments = [{ start: 0, end: 1, text: "Duration meeting transcript", language: "en", speaker: "Owner", completed: true }];
  await h.vexa.control("jitsi", nativeId, { status: "active", segments });
  await h.waitFor(async () => (await getMeetingById(h.ctx, meeting.id))?.status === "in_progress");
  await resumed.stop();
  await h.ctx.db.update(meetings).set({ scheduledStopAt: new Date(Date.now() - 1000) }).where(eq(meetings.id, meeting.id));
  resumed = startWorker(h.ctx, { popTimeoutSec: .05, heartbeatIntervalMs: 25 });
  const stopped = await h.waitFor(async () => {
    const row = await getMeetingById(h.ctx, meeting.id);
    return row?.status === "processing" ? row : null;
  });
  expect(stopped.captureDiagnostics?.stop_requested_by).toBe("duration_limit");
  expect(h.vexa.requests.filter((r) => r.method === "DELETE" && r.path === `/bots/jitsi/${encodeURIComponent(nativeId)}`)).toHaveLength(1);
  await h.vexa.control("jitsi", nativeId, { status: "completed", segments, completion_reason: "stopped" });
  await h.waitFor(async () => (await getMeetingById(h.ctx, meeting.id))?.status === "completed");
  const transcript = await h.api(`/v1/meetings/${meeting.id}/transcript`);
  expect(transcript.status).toBe(200);
  expect(await transcript.json()).toMatchObject({ text: "Owner: Duration meeting transcript" });
}, 20_000);
