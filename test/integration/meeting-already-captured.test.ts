/**
 * TC-581: Vexa answers 409 when its user already has a bot in the meeting. Every PTX project shares
 * that one Vexa user, so a second request for a call another live PTX meeting is capturing fails
 * with `meeting_already_captured`, which tinychat shows as "already being captured". The sibling's
 * id and project never reach the caller. A 409 with no live sibling stays `meeting_join_failed`.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApiKey } from "../../src/api/auth.ts";
import { meetings } from "../../src/db/schema.ts";
import { startHarness, type Harness } from "./harness.ts";

const room = (name: string) => `https://jitsi.local/${name}`;
const nativeId = (name: string) => `${name}@jitsi.local`;

const ALREADY_CAPTURED = {
  type: "meeting_join_failed",
  code: "meeting_already_captured",
  message: "Another notetaker from this service is already in this meeting.",
};

async function withHarness(fn: (h: Harness) => Promise<void>) {
  const h = await startHarness({ maxConcurrentBots: 5 });
  try {
    await fn(h);
  } finally {
    await h.stop();
  }
}

async function waitForStatus(h: Harness, id: string, status: string, key?: string) {
  return h.waitFor(async () => {
    const m = await (await h.api(`/v1/meetings/${id}`, key ? { key } : {})).json();
    return m.status === status ? m : null;
  }, { label: `meeting ${status}` });
}

const vexaCreatesFor = (h: Harness, name: string) =>
  h.vexa.requests.filter((r) => r.method === "POST" && r.path === "/bots" && (r.body as { native_meeting_id?: string })?.native_meeting_id === nativeId(name)).length;

describe("Vexa 409 at bot start (TC-581)", () => {
  test("a live sibling meeting fails the second request with meeting_already_captured", async () => {
    await withHarness(async (h) => {
      const first = await (await h.api("/v1/meetings", { method: "POST", json: { meeting_url: room("Shared") } })).json();
      await waitForStatus(h, first.id, "joining");
      await h.vexa.control("jitsi", nativeId("Shared"), { status: "active" });
      await waitForStatus(h, first.id, "in_progress");

      const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: room("Shared"), webhook_url: h.webhook.url } });
      expect(r.status).toBe(201);
      const second = await r.json();
      const failed = await waitForStatus(h, second.id, "failed");
      expect(failed.error).toEqual(ALREADY_CAPTURED);
      expect(vexaCreatesFor(h, "Shared")).toBe(2);

      const hook = await h.waitFor(async () => h.webhook.received.find((w) => w.body.type === "meeting.failed" && w.body.data.meeting_id === second.id), { label: "meeting.failed webhook" });
      expect(hook.body.data.error).toEqual({ code: ALREADY_CAPTURED.code, message: ALREADY_CAPTURED.message });
      // The live meeting is untouched.
      expect((await (await h.api(`/v1/meetings/${first.id}`)).json()).status).toBe("in_progress");
    });
  }, 20_000);

  test("a 409 with no live sibling stays meeting_join_failed", async () => {
    await withHarness(async (h) => {
      // A bot PTX does not track holds the room in Vexa.
      const untracked = await fetch(`${h.vexa.baseUrl}/bots`, {
        method: "POST",
        headers: { "X-API-Key": h.vexa.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "jitsi", native_meeting_id: nativeId("Lonely") }),
      });
      expect(untracked.status).toBe(201);
      // A finished PTX meeting for the same call does not count as live.
      const done = await (await h.api("/v1/meetings", { method: "POST", json: { meeting_url: room("Lonely") } })).json();
      await h.ctx.db.update(meetings).set({ status: "completed", vexaPlatform: "jitsi", vexaNativeMeetingId: nativeId("Lonely") }).where(eq(meetings.id, done.id));

      const m = await (await h.api("/v1/meetings", { method: "POST", json: { meeting_url: room("Lonely") } })).json();
      const failed = await waitForStatus(h, m.id, "failed");
      expect(failed.error).toEqual({
        type: "meeting_join_failed",
        code: "meeting_join_failed",
        message: "A bot is already in this meeting or the meeting could not be joined.",
      });
    });
  }, 20_000);

  test("a live sibling in another project counts, without leaking its id or project", async () => {
    await withHarness(async (h) => {
      const other = await createApiKey(h.ctx, "other-project");
      const sibling = await (await h.api("/v1/meetings", { method: "POST", json: { meeting_url: room("CrossProject") }, key: other.key })).json();
      await waitForStatus(h, sibling.id, "joining", other.key);

      const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: room("CrossProject"), webhook_url: h.webhook.url } });
      const mine = await r.json();
      const failed = await waitForStatus(h, mine.id, "failed");
      expect(failed.error).toEqual(ALREADY_CAPTURED);

      const hook = await h.waitFor(async () => h.webhook.received.find((w) => w.body.type === "meeting.failed" && w.body.data.meeting_id === mine.id), { label: "meeting.failed webhook" });
      for (const payload of [JSON.stringify(failed), hook.rawBody]) {
        expect(payload).not.toContain(sibling.id);
        expect(payload).not.toContain("other-project");
      }
      // The other project's meeting keeps its bot.
      expect((await (await h.api(`/v1/meetings/${sibling.id}`, { key: other.key })).json()).status).toBe("joining");
    });
  }, 20_000);
});
