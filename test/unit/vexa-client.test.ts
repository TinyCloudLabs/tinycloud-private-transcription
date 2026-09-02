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
  const meetings = await client.listMeetings();
  expect(meetings.meetings.some((meeting) => meeting.native_meeting_id === "Shape@jitsi.local")).toBe(true);
  const st = await client.botStatus();
  expect(st).toMatchObject({ count: expect.any(Number), running: expect.any(Array), running_bots: expect.any(Array) });
});

test("bad api key -> VexaHttpError 401", async () => {
  const bad = new VexaClient({ baseUrl: mock.baseUrl, apiKey: "nope" });
  await expect(bad.botStatus()).rejects.toMatchObject({ status: 401 });
});

test("non-success provider bodies are discarded at the Vexa adapter boundary", async () => {
  const body = "PROVIDER_BODY_SENTINEL https://provider.invalid/path sk_SECRET_SENTINEL";
  const rejectedFetch = (async () => new Response(body, { status: 503 })) as unknown as typeof fetch;
  const rejected = new VexaClient({
    baseUrl: "https://adapter.invalid",
    apiKey: "synthetic",
    fetch: rejectedFetch,
  });
  const error = await rejected.getTranscript("jitsi", "IDENTIFIER_SENTINEL").catch((value) => value);
  expect(error).toBeInstanceOf(VexaHttpError);
  expect(error).toMatchObject({ status: 503 });
  expect(error).not.toHaveProperty("detail");
  expect(JSON.stringify(error)).not.toContain(body);
  expect(JSON.stringify(error)).not.toContain("IDENTIFIER_SENTINEL");
  expect(String(error)).not.toContain("sk_SECRET_SENTINEL");
  expect(String(error)).not.toContain("IDENTIFIER_SENTINEL");
});

test("an invalid success response is sanitized at the Vexa adapter boundary", async () => {
  const invalidFetch = (async () =>
    new Response('{"provider_body":"PROVIDER_BODY_SENTINEL","secret":"sk_SECRET_SENTINEL"', {
      status: 200,
    })) as unknown as typeof fetch;
  const invalid = new VexaClient({ baseUrl: "https://adapter.invalid", apiKey: "synthetic", fetch: invalidFetch });
  const error = await invalid.getTranscript("jitsi", "IDENTIFIER_SENTINEL").catch((value) => value);
  expect(error).toMatchObject({ code: "provider_unavailable" });
  expect(String(error)).not.toContain("PROVIDER_BODY_SENTINEL");
  expect(JSON.stringify(error)).not.toContain("sk_SECRET_SENTINEL");
  expect(JSON.stringify(error)).not.toContain("IDENTIFIER_SENTINEL");
});
