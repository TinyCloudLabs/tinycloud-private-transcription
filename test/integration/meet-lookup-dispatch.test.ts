import { afterAll, beforeAll, expect, test } from "bun:test";
import { meetings } from "../../src/db/schema.ts";
import { startHarness, type Harness } from "./harness.ts";

interface MeetingView { id: string; status: string; meeting_url: string }
let h: Harness;
// Real API, Postgres and worker make creation, queueing and bot dispatch observable. Details: TC-2181
beforeAll(async () => { h = await startHarness({ enabledPlatforms: ["google_meet"], maxConcurrentBots: 3 }); });
afterAll(async () => { await h.stop(); });

const botRequests = () => h.vexa.requests.filter((r) => r.method === "POST" && r.path === "/bots");

test("lookup links return invalid_meeting_url and create no meeting, queue entry or bot request. Details: TC-2181", async () => {
  const wrapped = (base: string, key: string, target: string) => `${base}?${new URLSearchParams({ [key]: target })}`;
  for (const input of [
    "https://meet.google.com/lookup/DirectNick?authuser=1",
    "meet.google.com/lookup/BareNick",
    "Join https://meet.google.com/lookup/InviteNick Backup https://meet.google.com/yas-buib-ppd",
    wrapped("https://accounts.google.com/AccountChooser", "continue", "https://meet.google.com/lookup/AccountNick"),
    wrapped("https://www.google.com/url", "q", "https://meet.google.com/lookup/RedirectQ"),
    wrapped("https://meet.app.goo.gl/", "link", "https://meet.google.com/lookup/AppNick/"),
  ]) {
    const response = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: input } });
    expect(response.status).toBe(400);
    const body: { error: { code: string } } = await response.json();
    expect(body.error.code).toBe("invalid_meeting_url");
  }
  expect(await h.ctx.db.select().from(meetings)).toEqual([]);
  expect(botRequests()).toEqual([]);
});

test("a plain dashed Meet code link still creates a meeting and dispatches the bot. Details: TC-2181", async () => {
  const response = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.google.com/abc-defg-hij" } });
  expect(response.status).toBe(201);
  const created: MeetingView = await response.json();
  await h.waitFor(async () => {
    const meeting: MeetingView = await (await h.api(`/v1/meetings/${created.id}`)).json();
    return meeting.status === "joining" ? meeting : null;
  }, { label: "dashed code -> joining" });
  expect(botRequests().at(-1)?.body).toMatchObject({
    platform: "google_meet",
    native_meeting_id: "abc-defg-hij",
    meeting_url: "https://meet.google.com/abc-defg-hij",
  });
}, 20_000);
