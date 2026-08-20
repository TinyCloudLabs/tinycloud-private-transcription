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
    const vexaMeetings = await (await fetch(`${h.vexa.baseUrl}/meetings`, { headers: { "X-API-Key": h.vexa.apiKey } })).json() as { meetings: { native_meeting_id: string }[] };
    expect(vexaMeetings.meetings.find((meeting: { native_meeting_id: string }) => meeting.native_meeting_id === vexaKey.split("/").at(-1))).not.toHaveProperty("automatic_leave");
    await h.vexa.control(vexaKey.split("/")[0], vexaKey.slice(vexaKey.indexOf("/") + 1), { status: "completed", completion_reason: "stopped" });
  });

  test.each([
    ["Jitsi", "https://jitsi.local/FinalizesAfterLeave", "jitsi/FinalizesAfterLeave@jitsi.local"],
    ["Google Meet", "https://meet.google.com/aaa-bbbb-ccc", "google_meet/aaa-bbbb-ccc"],
  ])("%s completed(left_alone) follows TinyCloud's normal transcript finalization", async (_name, meetingUrl, vexaKey) => {
    const response = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: meetingUrl } });
    expect(response.status).toBe(201);
    const { id } = await response.json();
    await h.waitFor(async () => h.vexa.meetings.get(vexaKey) ?? null, { label: `${vexaKey} dispatched` });
    await h.vexa.control(vexaKey.split("/")[0], vexaKey.slice(vexaKey.indexOf("/") + 1), {
      status: "active",
      segments: [{ start: 0, end: 1, text: "Last participant left.", speaker: "Alice", completed: true }],
    });
    await h.waitFor(async () => {
      const meeting = await (await h.api(`/v1/meetings/${id}`)).json();
      return meeting.status === "in_progress" ? meeting : null;
    }, { label: `${vexaKey} in progress` });
    await h.vexa.control(vexaKey.split("/")[0], vexaKey.slice(vexaKey.indexOf("/") + 1), { status: "completed", completion_reason: "left_alone" });
    await h.waitFor(async () => {
      const meeting = await (await h.api(`/v1/meetings/${id}`)).json();
      return meeting.status === "completed" ? meeting : null;
    }, { label: `${vexaKey} completed` });
    const transcript = await h.api(`/v1/meetings/${id}/transcript`);
    expect(transcript.status).toBe(200);
    expect((await transcript.json()).text).toContain("Last participant left.");
    const health = await (await h.api("/health", { key: null })).json();
    expect(health.checks.bot_capacity.running).toBe(0);
  });
});
