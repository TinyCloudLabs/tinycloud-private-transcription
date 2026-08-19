import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ enabledPlatforms: ["jitsi", "google_meet"], maxTimeLeftAloneMs: 60_000 });
});

afterAll(async () => h.stop());

describe("automatic leave", () => {
  test.each([
    ["Jitsi", "https://jitsi.local/EveryoneLeft", "jitsi/EveryoneLeft@jitsi.local"],
    ["Google Meet", "https://meet.google.com/abc-defg-hij", "google_meet/abc-defg-hij"],
  ])("the public create path gives %s Vexa's TinyCloud empty-room window", async (_name, meetingUrl, vexaKey) => {
    const response = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: meetingUrl } });
    expect(response.status).toBe(201);
    await h.waitFor(async () => h.vexa.meetings.get(vexaKey) ?? null, { label: `${vexaKey} dispatched` });
    expect(h.vexa.meetings.get(vexaKey)?.automatic_leave).toEqual({ max_time_left_alone: 60_000 });
  });
});
