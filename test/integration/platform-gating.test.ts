/**
 * ENABLED_PLATFORMS gating: detection recognizes zoom/google_meet/teams, but only the platforms
 * in the list are accepted. Default list ("jitsi") is covered in api.test.ts; here a deployment
 * that also enables zoom accepts a zoom URL while google_meet stays gated.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ enabledPlatforms: ["jitsi", "zoom"] });
});
afterAll(async () => {
  await h.stop();
});

describe("ENABLED_PLATFORMS", () => {
  test("enabled platform (zoom) is accepted with detection intact", async () => {
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://zoom.us/j/84335626851" } });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ status: "queued", platform: "zoom" });
  });

  test("jitsi stays accepted", async () => {
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/GatingRoom" } });
    expect(r.status).toBe(201);
    expect((await r.json()).platform).toBe("jitsi");
  });

  test("platform outside the list is still gated with a clear message", async () => {
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.google.com/abc-defg-hij" } });
    expect(r.status).toBe(400);
    const e = (await r.json()).error;
    expect(e.code).toBe("unsupported_platform");
    expect(e.message).toContain("google_meet");
    expect(e.message).toContain("not enabled on this deployment");
  });
});
