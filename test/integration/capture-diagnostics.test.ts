import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarness, type Harness } from "./harness.ts";
import { getMeetingById } from "../../src/services/meetings.ts";
import { observeCapture, recordCapture } from "../../src/services/capture.ts";

let h: Harness;
const logs: { msg: string; data?: Record<string, unknown> }[] = [];
const collect = (msg: string, data?: Record<string, unknown>) => { logs.push({ msg, data }); };
beforeAll(async () => { h = await startHarness({ log: { info: collect, debug: collect, warn: collect, error: collect } }); });
afterAll(async () => { await h.stop(); });

async function create(name: string) {
  const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: `https://jitsi.local/${name}`, webhook_url: h.webhook.url, metadata: { owner_label: "unchanged" } } });
  const { id, metadata } = await r.json();
  await h.waitFor(async () => h.vexa.meetings.get(`jitsi/${name}@jitsi.local`));
  return { id, nativeId: `${name}@jitsi.local`, metadata };
}
async function status(id: string, wanted: string) {
  return h.waitFor(async () => {
    const m = await (await h.api(`/v1/meetings/${id}`)).json();
    return m.status === wanted ? m : null;
  });
}

describe("capture evidence survives transcript finalization", () => {
  test.each(["left_alone", "evicted"] as const)("completed transcript retains %s in meeting, transcript, webhook and logs", async (reason) => {
    const { id, nativeId, metadata } = await create(`Evidence-${reason}`);
    await h.vexa.control("jitsi", nativeId, { status: "active" });
    await status(id, "in_progress");
    await h.vexa.control("jitsi", nativeId, { status: "completed", completion_reason: reason, segments: [{ start: 0, end: 5, text: "Retained words.", speaker: "Speaker", completed: true }] });
    const m = await status(id, "completed");
    expect(m.capture).toMatchObject({ completion_reason: reason, provider_status: "completed", silence_timeout_ms: 300000, audio_activity: "not_reported" });
    expect(m.metadata).toEqual(metadata);
    const t = await (await h.api(`/v1/meetings/${id}/transcript`)).json();
    expect(t.text).toContain("Retained words.");
    expect(t.capture.completion_reason).toBe(reason);
    const hook = await h.waitFor(async () => h.webhook.received.find((w) => w.body.data.meeting_id === id));
    expect(hook.body.data.capture.completion_reason).toBe(reason);
    expect(logs.some((l) => l.msg === "capture status observed" && l.data?.meetingId === id && l.data?.completion_reason === reason)).toBe(true);
    expect(logs.some((l) => l.msg === "bot dispatched" && l.data?.meetingId === id)).toBe(true);
  });

  test("capture failure retains exit code independently of a missing transcript", async () => {
    const { id, nativeId } = await create("RuntimeFailure");
    const raw = h.vexa.meetings.get(`jitsi/${nativeId}`)!;
    raw.data = { last_error: { exit_code: 137, error_details: "DO NOT EXPOSE" } };
    await h.vexa.control("jitsi", nativeId, { status: "failed" });
    const m = await status(id, "failed");
    expect(m.capture).toMatchObject({ provider_status: "failed", exit_code: 137, completion_reason: null });
    expect(JSON.stringify(m)).not.toContain("DO NOT EXPOSE");
  });

  test("a stop request is retained separately from the provider's departure reason", async () => {
    const { id, nativeId } = await create("UserStopEvidence");
    await h.vexa.control("jitsi", nativeId, { status: "active" });
    await status(id, "in_progress");
    await h.api(`/v1/meetings/${id}/stop`, { method: "POST" });
    await h.vexa.control("jitsi", nativeId, { status: "completed", completion_reason: "evicted", segments: [{ start: 0, end: 1, text: "Words", speaker: "Speaker" }] });
    const m = await status(id, "completed");
    expect(m.capture.stop_requested_by).toBe("user");
    expect(m.capture.stop_requested_at).toBeString();
    expect(m.capture.completion_reason).toBe("evicted");
  });

  test("partial retry observations preserve terminal evidence and concurrent stop metadata", async () => {
    const { id, nativeId } = await create("RetryEvidence");
    await status(id, "joining");
    const meeting = (await getMeetingById(h.ctx, id))!;
    await Promise.all([
      recordCapture(h.ctx, meeting, { provider_status: "failed", completion_reason: "evicted", exit_code: 137, observed_at: "2020-01-01T00:00:00Z" }),
      recordCapture(h.ctx, meeting, { stop_requested_by: "user", stop_requested_at: new Date().toISOString() }),
    ]);
    const before = (await getMeetingById(h.ctx, id))!;
    // A later read can omit previously supplied failure details.
    const response = await h.ctx.vexa.getTranscript("jitsi", nativeId);
    response.status = "failed";
    response.data = {};
    const after = await observeCapture(h.ctx, before, response);
    expect(after.captureDiagnostics).toMatchObject({ completion_reason: "evicted", exit_code: 137, stop_requested_by: "user" });
    await h.vexa.control("jitsi", nativeId, { status: "failed" });
    await status(id, "failed");
  });
});
