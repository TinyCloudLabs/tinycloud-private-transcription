import { expect, test } from "bun:test";
import { createMockVexa, type MockVexaRequestCount } from "../../src/providers/vexa/mock-server.ts";

test("mock Vexa request history exposes only bounded operations, methods, and counts", async () => {
  const apiKey = "vxa_MOCK_HISTORY_SECRET_SENTINEL";
  const nativeMeetingId = "MOCK_HISTORY_RAW_ID_SENTINEL@jitsi.local";
  const meetingUrl = "https://private.invalid/MOCK_HISTORY_URL_SENTINEL";
  const mock = createMockVexa({ apiKey });
  const headers = { "Content-Type": "application/json", "X-API-Key": apiKey };

  const created = await mock.app.request("/bots", {
    method: "POST",
    headers,
    body: JSON.stringify({
      platform: "jitsi",
      native_meeting_id: nativeMeetingId,
      meeting_url: meetingUrl,
      bot_name: "MOCK_HISTORY_PROVIDER_BODY_SENTINEL",
    }),
  });
  expect(created.status).toBe(201);
  const transcript = await mock.app.request(`/transcripts/jitsi/${encodeURIComponent(nativeMeetingId)}`, {
    headers: { "X-API-Key": apiKey },
  });
  expect(transcript.status).toBe(200);

  const exposed = (await (await mock.app.request("/_mock/requests")).json()) as MockVexaRequestCount[];
  const expected: MockVexaRequestCount[] = [
    { operation: "create_bot", method: "POST", count: 1 },
    { operation: "get_transcript", method: "GET", count: 1 },
  ];
  expect(mock.requests).toEqual(expected);
  expect(exposed).toEqual(expected);
  for (const entry of [...mock.requests, ...exposed]) {
    expect(Object.keys(entry).sort()).toEqual(["count", "method", "operation"]);
  }

  const serialized = JSON.stringify({ local: mock.requests, exposed });
  for (const sentinel of [
    nativeMeetingId,
    "MOCK_HISTORY_URL_SENTINEL",
    "MOCK_HISTORY_PROVIDER_BODY_SENTINEL",
    "MOCK_HISTORY_SECRET_SENTINEL",
  ]) {
    expect(serialized).not.toContain(sentinel);
  }
});
