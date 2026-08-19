/**
 * Worker-side join deadline (JOIN_TIMEOUT_SECONDS): a meeting still `joining` or
 * `waiting_for_admission` when the deadline fires is failed (meeting_join_failed /
 * waiting_room_timeout), its Vexa bot is stopped, and meeting.failed is delivered.
 * The mock Vexa never admits the bot, mirroring the meet.jit.si "parked forever" case.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ joinTimeoutSeconds: 1.5 });
});
afterAll(async () => {
  await h.stop();
});

async function meetingOf(id: string) {
  return (await h.api(`/v1/meetings/${id}`)).json();
}

const waitFailed = (id: string) =>
  h.waitFor(async () => {
    const b = await meetingOf(id);
    return b.status === "failed" ? b : null;
  }, { timeoutMs: 8000, label: `meeting ${id} -> failed` });

describe("join deadline", () => {
  test("stuck in joining -> failed meeting_join_failed, bot stopped, webhook delivered", async () => {
    const nativeId = "JoinTimeoutA@jitsi.local";
    const r = await h.api("/v1/meetings", {
      method: "POST",
      json: { meeting_url: "https://jitsi.local/JoinTimeoutA", webhook_url: h.webhook.url },
    });
    expect(r.status).toBe(201);
    const id = (await r.json()).id;
    // Mock stays "requested" (mapped to joining) — never admitted.
    await h.waitFor(async () => ((await meetingOf(id)).status === "joining" ? true : null), { label: "joining" });

    const failed = await waitFailed(id);
    expect(failed.error).toMatchObject({ type: "meeting_join_failed", code: "meeting_join_failed" });
    expect(h.vexa.requests.some((q) => q.method === "DELETE" && q.path === `/bots/jitsi/${encodeURIComponent(nativeId)}`)).toBe(true);
    const hook = await h.waitFor(
      async () => h.webhook.received.find((w) => w.body.type === "meeting.failed" && w.body.data.meeting_id === id) ?? null,
      { label: "meeting.failed webhook" },
    );
    expect(hook.body.data.error.code).toBe("meeting_join_failed");
  });

  test("stuck in waiting_for_admission -> failed waiting_room_timeout", async () => {
    const nativeId = "JoinTimeoutB@jitsi.local";
    const r = await h.api("/v1/meetings", {
      method: "POST",
      json: { meeting_url: "https://jitsi.local/JoinTimeoutB", webhook_url: h.webhook.url },
    });
    const id = (await r.json()).id;
    await h.waitFor(async () => ((await meetingOf(id)).status === "joining" ? true : null), { label: "joining" });
    await h.vexa.control("jitsi", nativeId, { status: "awaiting_admission" });
    await h.waitFor(async () => ((await meetingOf(id)).status === "waiting_for_admission" ? true : null), { label: "waiting_for_admission" });

    const failed = await waitFailed(id);
    expect(failed.error).toMatchObject({ type: "meeting_join_failed", code: "waiting_room_timeout" });
    expect(h.vexa.requests.some((q) => q.method === "DELETE" && q.path === `/bots/jitsi/${encodeURIComponent(nativeId)}`)).toBe(true);
    const hook = await h.waitFor(
      async () => h.webhook.received.find((w) => w.body.type === "meeting.failed" && w.body.data.meeting_id === id) ?? null,
      { label: "meeting.failed webhook" },
    );
    expect(hook.body.data.error.code).toBe("waiting_room_timeout");
  });

  test("admitted meetings are untouched by the deadline", async () => {
    const nativeId = "JoinTimeoutC@jitsi.local";
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/JoinTimeoutC" } });
    const id = (await r.json()).id;
    await h.waitFor(async () => ((await meetingOf(id)).status === "joining" ? true : null), { label: "joining" });
    await h.vexa.control("jitsi", nativeId, { status: "active" });
    await h.waitFor(async () => ((await meetingOf(id)).status === "in_progress" ? true : null), { label: "in_progress" });
    // Let the 1.5s deadline fire, then confirm the meeting is still in progress.
    await Bun.sleep(2000);
    expect((await meetingOf(id)).status).toBe("in_progress");
  });
});
