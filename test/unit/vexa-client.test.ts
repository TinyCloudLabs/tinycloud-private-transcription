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
  const epoch = Date.now() / 1000;
  await mock.control("jitsi", "Shape@jitsi.local", {
    status: "completed",
    completion_reason: "stopped",
    segments: [{ start: epoch, end: epoch + 5, text: "The quick brown fox jumps over the lazy dog.", language: "en", speaker: "Alice", completed: true }],
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

test("provider identifiers and bodies never enter Vexa errors or stacks", async () => {
  const marker = "PRIVATE_TRANSCRIPT https://private.example/token";
  const hostile = new VexaClient({
    baseUrl: "http://127.0.0.1:1",
    apiKey: "PRIVATE_AUTHORIZATION",
    fetch: (async () => new Response(marker, { status: 502 })) as unknown as typeof fetch,
  });
  try {
    await hostile.getTranscript("jitsi", marker);
    throw new Error("expected Vexa request to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(VexaHttpError);
    expect(String(error)).not.toContain("PRIVATE_TRANSCRIPT");
    expect((error as Error).stack ?? "").not.toContain("PRIVATE_TRANSCRIPT");
    expect(String(error)).not.toContain("PRIVATE_AUTHORIZATION");
  }
});

test("listRecordings reads every page of Vexa's paged /recordings and passes the meeting filter (TC-904)", async () => {
  const all = Array.from({ length: 450 }, (_, i) => ({ id: 1000 + i, meeting_id: i % 7, media_files: [{ id: i, type: "audio" }] }));
  const queries: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      queries.push(url.search);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const meetingId = url.searchParams.get("meeting_id");
      const rows = all.filter((r) => meetingId === null || r.meeting_id === Number(meetingId));
      const page = rows.slice(offset, offset + limit);
      return Response.json({ recordings: page, total: rows.length, limit, offset, has_more: offset + page.length < rows.length });
    },
  });
  try {
    const paged = new VexaClient({ baseUrl: `http://localhost:${server.port}`, apiKey: "k" });
    const every = await paged.listRecordings();
    expect(every.recordings.map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(queries).toEqual(["?limit=200&offset=0", "?limit=200&offset=200", "?limit=200&offset=400"]);
    queries.length = 0;
    const one = await paged.listRecordings({ meetingId: 3 });
    expect(one.recordings.length).toBe(all.filter((r) => r.meeting_id === 3).length);
    expect(queries).toEqual(["?limit=200&offset=0&meeting_id=3"]);
  } finally {
    server.stop(true);
  }
});
