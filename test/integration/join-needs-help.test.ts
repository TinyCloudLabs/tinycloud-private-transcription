/**
 * needs_help is its own pre-admission state. Its join window runs from the first observation for
 * JOIN_NEEDS_HELP_MAX_SECONDS (not JOIN_TIMEOUT_SECONDS), and while it lasts the meeting carries the
 * fixed status_message. Here JOIN_TIMEOUT is long, so a failure inside the test proves the
 * needs_help window governed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NEEDS_HELP_MESSAGE } from "../../src/domain/state.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ joinTimeoutSeconds: 60, joinNeedsHelpMaxSeconds: 3, needsHelpStateEnabled: true });
});
afterAll(async () => {
  await h.stop();
});

async function meetingOf(id: string) {
  return (await h.api(`/v1/meetings/${id}`)).json();
}

describe("needs_help join window", () => {
  test("needs_help exposes status_message and fails at the needs_help window, not JOIN_TIMEOUT", async () => {
    const nativeId = "NeedsHelpA@jitsi.local";
    const r = await h.api("/v1/meetings", {
      method: "POST",
      json: { meeting_url: "https://jitsi.local/NeedsHelpA", webhook_url: h.webhook.url },
    });
    expect(r.status).toBe(201);
    const id = (await r.json()).id;
    await h.waitFor(async () => ((await meetingOf(id)).status === "joining" ? true : null), { label: "joining" });

    await h.vexa.control("jitsi", nativeId, { status: "needs_help", escalation_reason: "modal_dialog" });
    const blocked = await h.waitFor(
      async () => {
        const b = await meetingOf(id);
        return b.status === "needs_help" ? b : null;
      },
      { label: "needs_help" },
    );
    expect(blocked.status_message).toBe(NEEDS_HELP_MESSAGE);
    expect(blocked.capture.escalation_reason).toBe("modal_dialog");

    const failed = await h.waitFor(
      async () => {
        const b = await meetingOf(id);
        return b.status === "failed" ? b : null;
      },
      { timeoutMs: 8000, label: `meeting ${id} -> failed` },
    );
    expect(failed.error).toMatchObject({ type: "meeting_join_failed", code: "meeting_join_failed" });
    const hook = await h.waitFor(
      async () => h.webhook.received.find((w) => w.body.type === "meeting.failed" && w.body.data.meeting_id === id) ?? null,
      { timeoutMs: 10000, label: "meeting.failed webhook" },
    );
    expect(hook.body.data.capture.provider_status).toBe("needs_help");
    expect(hook.body.data.capture.escalation_reason).toBe("modal_dialog");
    await h.waitFor(async () => (h.vexa.requests.some((q) => q.method === "DELETE" && q.path === `/bots/jitsi/${encodeURIComponent(nativeId)}`) ? true : null), { label: "bot stop request" });
  });
});
