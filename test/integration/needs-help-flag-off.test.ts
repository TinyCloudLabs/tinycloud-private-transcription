import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { controlIfBotExists, startHarness, type Harness } from "./harness.ts";

// NEEDS_HELP_STATE_ENABLED is left at its default (off). The raw Vexa needs_help observation must
// still hold the bot for JOIN_NEEDS_HELP_MAX_SECONDS, but no client-visible surface may carry it.
let h: Harness;
beforeAll(async () => {
  h = await startHarness({ joinTimeoutSeconds: 1.5, joinNeedsHelpMaxSeconds: 3, joinDispatchFallbackSeconds: 4 });
});
afterAll(async () => {
  await h.stop();
});

const TIMEOUT_MS = 20_000;
const meetingOf = async (id: string) => (await h.api(`/v1/meetings/${id}`)).json();
const nativeIdOf = (slug: string) => `${slug}@jitsi.local`;
const botDeletes = (nativeId: string) =>
  h.vexa.requests.filter((q) => q.method === "DELETE" && q.path === `/bots/jitsi/${encodeURIComponent(nativeId)}`).length;

describe("NEEDS_HELP_STATE_ENABLED off (default)", () => {
  test("raw needs_help is held internally and never reaches the API or webhook", async () => {
    const slug = "FlagOffNeedsHelp";
    const r = await h.api("/v1/meetings", {
      method: "POST",
      json: { meeting_url: `https://jitsi.local/${slug}`, webhook_url: h.webhook.url },
    });
    expect(r.status).toBe(201);
    const id = (await r.json()).id;
    await h.waitFor(async () => controlIfBotExists(h, "jitsi", nativeIdOf(slug), { status: "joining" }), {
      timeoutMs: 8000,
      label: "bot exists",
    });
    await h.waitFor(async () => ((await meetingOf(id)).status === "joining" ? true : null), { label: "joining" });

    await h.vexa.control("jitsi", nativeIdOf(slug), { status: "needs_help" });
    const held = await h.waitFor(
      async () => {
        const m = await meetingOf(id);
        return m.status === "waiting_for_admission" ? m : null;
      },
      { label: "needs_help served as waiting_for_admission" },
    );
    expect(JSON.stringify(held)).not.toContain("needs_help");
    expect(JSON.stringify(held)).not.toContain("escalation_reason");

    // Past joinTimeoutSeconds (1.5s) but before joinNeedsHelpMaxSeconds (3s): still held, bot not stopped.
    await Bun.sleep(2000);
    const stillHeld = await meetingOf(id);
    expect(stillHeld.status).toBe("waiting_for_admission");
    expect(botDeletes(nativeIdOf(slug))).toBe(0);

    const failed = await h.waitFor(
      async () => {
        const m = await meetingOf(id);
        return m.status === "failed" ? m : null;
      },
      { timeoutMs: 10000, label: `meeting ${id} -> failed` },
    );
    expect(JSON.stringify(failed)).not.toContain("needs_help");
    expect(JSON.stringify(failed)).not.toContain("escalation_reason");
    expect(failed.error).toMatchObject({ code: "waiting_room_timeout" });

    const hook = await h.waitFor(
      async () => h.webhook.received.find((w) => w.body.type === "meeting.failed" && w.body.data.meeting_id === id) ?? null,
      { timeoutMs: 10000, label: "meeting.failed webhook" },
    );
    expect(hook.body.data.status).toBe("failed");
    expect(JSON.stringify(hook.body)).not.toContain("needs_help");
    expect(JSON.stringify(hook.body)).not.toContain("escalation_reason");
    expect(hook.body.data.error.code).toBe("waiting_room_timeout");
  }, TIMEOUT_MS);
});
