import { afterAll, beforeAll, expect, test } from "bun:test";
import { meetings } from "../../src/db/schema.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
beforeAll(async () => { h = await startHarness({ enabledPlatforms: ["google_meet"], maxConcurrentBots: 5 }); });
afterAll(async () => { await h.stop(); });

const line = "Paste the meet.google.com/abc-defg-hij link for this meeting";

test("lookup inputs return the owner guidance without creating or dispatching a meeting", async () => {
  const target = "https://meet.google.com/lookup/TeamOne?authuser=1";
  const encoded = encodeURIComponent(target);
  for (const input of [
    target,
    "meet.google.com/lookup/TeamTwo",
    `https://accounts.google.com/AccountChooser?continue=${encoded}`,
    `https://www.google.com/url?q=${encoded}`,
    `https://google.com/url?url=${encoded}`,
    `https://meet.app.goo.gl/?link=${encoded}`,
  ]) {
    const response = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: input } });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({ code: "invalid_meeting_url", message: line });
  }
  expect(await h.ctx.db.select().from(meetings)).toEqual([]);
  expect(h.vexa.requests.filter((request) => request.method === "POST" && request.path === "/bots")).toEqual([]);
});

test("plain and wrapped dashed-code links still dispatch to their canonical meetings", async () => {
  for (const [input, canonical, code] of [
    ["meet.google.com/abc-defg-hij", "https://meet.google.com/abc-defg-hij", "abc-defg-hij"],
    ["https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fmeet.google.com%2Fklm-nopq-rst", "https://meet.google.com/klm-nopq-rst", "klm-nopq-rst"],
  ]) {
    const response = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: input } });
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created.meeting_url).toBe(canonical!);
    await h.waitFor(async () => {
      const meeting = await (await h.api(`/v1/meetings/${created.id}`)).json();
      return meeting.status === "joining" ? meeting : null;
    });
    expect(h.vexa.meetings.get(`google_meet/${code}`)?.meeting_url).toBe(canonical!);
  }
  expect(h.vexa.requests.filter((request) => request.method === "POST" && request.path === "/bots").map((request) => request.body)).toMatchObject([
    { platform: "google_meet", native_meeting_id: "abc-defg-hij", meeting_url: "https://meet.google.com/abc-defg-hij" },
    { platform: "google_meet", native_meeting_id: "klm-nopq-rst", meeting_url: "https://meet.google.com/klm-nopq-rst" },
  ]);
}, 20_000);
