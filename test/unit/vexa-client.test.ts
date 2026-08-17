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

  await client.deleteMeeting("jitsi", "Room@jitsi.local");
  await expect(client.getTranscript("jitsi", "Room@jitsi.local")).rejects.toBeInstanceOf(VexaHttpError);
});

test("bad api key -> VexaHttpError 401", async () => {
  const bad = new VexaClient({ baseUrl: mock.baseUrl, apiKey: "nope" });
  await expect(bad.botStatus()).rejects.toMatchObject({ status: 401 });
});
