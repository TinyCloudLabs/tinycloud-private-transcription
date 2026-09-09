import { afterAll, beforeAll, expect, test } from "bun:test";
import { startMockVexa } from "../../src/providers/vexa/mock-server.ts";
import { VexaClient, VexaHttpError } from "../../src/providers/vexa/client.ts";

let mock: ReturnType<typeof startMockVexa>;
let client: VexaClient;
beforeAll(() => {
  mock = startMockVexa(0);
  client = new VexaClient({ baseUrl: mock.baseUrl, apiKey: mock.apiKey });
});
afterAll(() => mock.stop());

test("createBot / getTranscript / stopBot / deleteMeeting against mock", async () => {
  const created = await client.createBot({
    platform: "jitsi",
    native_meeting_id: "Room@jitsi.local",
    meeting_url: "https://jitsi.local/Room",
    bot_name: "TC",
  });
  expect(created.status).toBe("requested");
  expect(created.native_meeting_id).toBe("Room@jitsi.local");

  await mock.control("jitsi", "Room@jitsi.local", {
    status: "active",
    segments: [{ start: 0, end: 1, text: "hi", language: "en", speaker: "Sam", completed: true }],
  });
  const t = await client.getTranscript("jitsi", "Room@jitsi.local");
  expect(t.status).toBe("active");
  expect(t.segments).toHaveLength(1);

  const stopped = await client.stopBot("jitsi", "Room@jitsi.local");
  expect(stopped.status).toBe("stopping");

  // Real v0.12: rows the bot lifecycle owns are not deletable (409); planned rows are.
  await expect(client.deleteMeeting("jitsi", "Room@jitsi.local")).rejects.toMatchObject({ status: 409, conflict: true });
  await mock.control("jitsi", "Room@jitsi.local", { planned: true });
  const deleted = await client.deleteMeeting("jitsi", "Room@jitsi.local");
  expect(deleted.status).toBe("deleted");
  await expect(client.getTranscript("jitsi", "Room@jitsi.local")).rejects.toBeInstanceOf(VexaHttpError);
});

test("real-shape transcript: epoch timing, turn ids, data.completion_reason", async () => {
  await client.createBot({ platform: "jitsi", native_meeting_id: "Shape@jitsi.local", meeting_url: "https://jitsi.local/Shape" });
  await mock.control("jitsi", "Shape@jitsi.local", {
    status: "completed",
    completion_reason: "stopped",
    segments: [{ start: 3.9, end: 8.9, text: "The quick brown fox jumps over the lazy dog.", language: "en", speaker: "Alice", completed: true }],
  });
  const t = await client.getTranscript("jitsi", "Shape@jitsi.local");
  expect(t.data?.completion_reason).toBe("stopped");
  expect(t.segments[0].start).toBeGreaterThan(1e9);
  expect(t.segments[0].segment_id).toBe("turn:0:0");
  expect(t.segments[0].absolute_start_time).toBeTruthy();
  const st = await client.botStatus();
  expect(st).toMatchObject({ count: expect.any(Number), running: expect.any(Array), running_bots: expect.any(Array) });
});

test("bad api key -> VexaHttpError 401", async () => {
  const bad = new VexaClient({ baseUrl: mock.baseUrl, apiKey: "nope" });
  await expect(bad.botStatus()).rejects.toMatchObject({ status: 401 });
});

test("recording timeline waits for metadata that becomes available after audio finality", async () => {
  const timeline = { version: 1, recording_id: 77, intervals: [] };
  let requests = 0;
  const late = new VexaClient({ baseUrl: "http://capture.invalid", apiKey: "fixture", fetch: (async (url) => {
    expect(String(url)).toBe("http://capture.invalid/recordings/77/speaker-timeline");
    requests++;
    if (requests === 1) return Response.json({ detail: "not available" }, { status: 404 });
    if (requests === 2) return Response.json({ detail: "incomplete" }, { status: 422 });
    return Response.json(timeline);
  }) as typeof fetch });
  expect(await late.recordingSpeakerTimeline(77)).toEqual(timeline);
});

test("missing metadata has a bounded retry budget and authorization errors are not retried", async () => {
  let requests = 0;
  const unavailable = new VexaClient({ baseUrl: "http://capture.invalid", apiKey: "fixture", fetch: (async (_url) => {
    requests++;
    return Response.json({ detail: "not available" }, { status: 404 });
  }) as typeof fetch });
  await expect(unavailable.recordingSpeakerTimeline(77)).rejects.toMatchObject({ status: 404, notFound: true });
  expect(requests).toBe(3);

  requests = 0;
  const unauthorized = new VexaClient({ baseUrl: "http://capture.invalid", apiKey: "fixture", fetch: (async (_url) => {
    requests++;
    return Response.json({ detail: "denied" }, { status: 403 });
  }) as typeof fetch });
  await expect(unauthorized.recordingSpeakerTimeline(77)).rejects.toMatchObject({ status: 403 });
  expect(requests).toBe(1);
});
