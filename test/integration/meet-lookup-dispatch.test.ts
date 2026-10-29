import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, type Harness } from "./harness.ts";

interface MeetingView { id: string; status: string; meeting_url: string }
let h: Harness;
// Real provider HTTP and Postgres transitions use the worker's live poll loop. Details: TC-2181
beforeAll(async () => { h = await startHarness({ enabledPlatforms: ["google_meet"], maxConcurrentBots: 3 }); });
afterAll(async () => { await h.stop(); });

async function create(url: string): Promise<MeetingView> {
  const response = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: url } });
  expect(response.status).toBe(201);
  return response.json();
}

async function waitStatus(id: string, status: string): Promise<MeetingView> {
  return h.waitFor(async () => {
    const meeting: MeetingView = await (await h.api(`/v1/meetings/${id}`)).json();
    return meeting.status === status ? meeting : null;
  }, { label: `lookup ${id} -> ${status}` });
}

test("direct and wrapped lookup targets dispatch with their exact nickname identity. Details: TC-2181", async () => {
  for (const [input, target, nativeId] of [
    ["https://meet.google.com/lookup/DirectNick?authuser=1", "https://meet.google.com/lookup/DirectNick?authuser=1", "DirectNick"],
    ["meet.google.com/lookup/BareNick", "https://meet.google.com/lookup/BareNick", "BareNick"],
    [`https://accounts.google.com/AccountChooser?continue=${encodeURIComponent("https://meet.google.com/lookup/AccountNick?authuser=1")}`, "https://meet.google.com/lookup/AccountNick?authuser=1", "AccountNick"],
    [`https://www.google.com/url?q=${encodeURIComponent("https://meet.google.com/lookup/RedirectQ")}`, "https://meet.google.com/lookup/RedirectQ", "RedirectQ"],
    [`https://google.com/url?url=${encodeURIComponent("https://meet.google.com/lookup/RedirectUrl")}`, "https://meet.google.com/lookup/RedirectUrl", "RedirectUrl"],
    [`https://meet.app.goo.gl/?link=${encodeURIComponent("https://meet.google.com/lookup/AppNick/")}`, "https://meet.google.com/lookup/AppNick/", "AppNick"],
  ] as const) {
    const created = await create(input);
    expect(created.meeting_url).toBe(target);
    await waitStatus(created.id, "joining");
    const request = h.vexa.requests.filter((r) => r.method === "POST" && r.path === "/bots").at(-1);
    expect(request?.body).toMatchObject({ platform: "google_meet", native_meeting_id: nativeId, meeting_url: target });
    expect(request?.body).not.toMatchObject({ native_meeting_id: "None" });
    expect(h.vexa.meetings.get(`google_meet/${nativeId}`)?.meeting_url).toBe(target);
    const stopped = await h.api(`/v1/meetings/${created.id}/stop`, { method: "POST" });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ id: created.id, status: "cancelled" });
    await h.vexa.control("google_meet", nativeId, { status: "completed" });
  }
}, 20_000);

test("two lookup nicknames dispatch, poll and stop independently with the same wire identity. Details: TC-2181", async () => {
  const first = await create("https://meet.google.com/lookup/TeamAlpha?authuser=1");
  const secondTarget = "https://meet.google.com/lookup/Team%42eta?authuser=2";
  const second = await create(`https://accounts.google.com/AccountChooser?continue=${encodeURIComponent(secondTarget)}`);
  const captures = [
    { meeting: first, nativeId: "TeamAlpha", text: "Alpha transcript" },
    { meeting: second, nativeId: "Team%42eta", text: "Beta transcript" },
  ];
  for (const { meeting, nativeId, text } of captures) {
    await waitStatus(meeting.id, "joining");
    await h.vexa.control("google_meet", nativeId, { status: "active", segments: [
      { start: 0, end: 1, text, language: "en", speaker: "Owner", completed: true },
    ] });
    await waitStatus(meeting.id, "in_progress");
    expect(h.vexa.requests.some((r) => r.method === "GET" && r.path === `/transcripts/google_meet/${encodeURIComponent(nativeId)}`)).toBe(true);
  }
  const dispatches = h.vexa.requests.filter((r) => r.method === "POST" && r.path === "/bots").slice(-2);
  expect(dispatches.map((r) => r.body)).toMatchObject([
    { native_meeting_id: "TeamAlpha", meeting_url: first.meeting_url },
    { native_meeting_id: "Team%42eta", meeting_url: secondTarget },
  ]);
  for (const request of dispatches) expect(request.body).not.toMatchObject({ native_meeting_id: "None" });

  for (const { meeting, nativeId, text } of captures) {
    const stopped = await h.api(`/v1/meetings/${meeting.id}/stop`, { method: "POST" });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ id: meeting.id, status: "processing" });
    expect(h.vexa.requests.filter((r) => r.method === "DELETE" && r.path === `/bots/google_meet/${encodeURIComponent(nativeId)}`)).toHaveLength(1);
    if (meeting.id === first.id) {
      const untouched: MeetingView = await (await h.api(`/v1/meetings/${second.id}`)).json();
      expect(untouched.status).toBe("in_progress");
      expect(h.vexa.meetings.get("google_meet/Team%42eta")?.status).toBe("active");
    }
    await h.vexa.control("google_meet", nativeId, { status: "completed", segments: [
      { start: 0, end: 1, text, language: "en", speaker: "Owner", completed: true },
    ], completion_reason: "stopped" });
    await waitStatus(meeting.id, "completed");
    const transcript = await h.api(`/v1/meetings/${meeting.id}/transcript`);
    expect(transcript.status).toBe(200);
    expect(await transcript.json()).toMatchObject({ text: `Owner: ${text}` });
  }
}, 20_000);
