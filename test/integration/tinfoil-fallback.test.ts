/**
 * TRANSCRIPTION_PROVIDER=tinfoil against a Vexa that persists no usable recording (mock: `recordings: []`,
 * same as the real rig's "silent tap" after the bitrate sanity check): the worker asks Vexa for
 * `recording_enabled`, then falls back to the Vexa-native transcript instead of failing the meeting.
 * No Tinfoil call is made (nothing to send).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
const log = {
  debug: (msg: string, data?: Record<string, unknown>) => logs.push({ level: "debug", msg, data }),
  info: (msg: string, data?: Record<string, unknown>) => logs.push({ level: "info", msg, data }),
  warn: (msg: string, data?: Record<string, unknown>) => logs.push({ level: "warn", msg, data }),
  error: (msg: string, data?: Record<string, unknown>) => logs.push({ level: "error", msg, data }),
};

beforeAll(async () => {
  h = await startHarness({
    // Unreachable on purpose: any attempt to call Tinfoil would surface as provider_unavailable.
    transcription: new TinfoilTranscriptionProvider({ baseUrl: "http://127.0.0.1:9", apiKey: "tk_test", model: "voxtral-small-24b", timeoutMs: 1000 }),
    log,
  });
});
afterAll(async () => {
  await h.stop();
});

describe("tinfoil provider without a usable recording", () => {
  const nativeId = "TinfoilRoom@jitsi.local";
  let id: string;

  test("bot is requested with recording_enabled", async () => {
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/TinfoilRoom", language: "en", webhook_url: h.webhook.url } });
    expect(r.status).toBe(201);
    id = (await r.json()).id;
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${id}`)).json()).status === "joining" ? true : null));
    expect(h.vexa.meetings.get(`jitsi/${nativeId}`)?.recording_enabled).toBe(true);
  });

  test("falls back to the vexa-native transcript and logs it", async () => {
    await h.vexa.control("jitsi", nativeId, {
      status: "completed",
      completion_reason: "stopped",
      segments: [{ start: 0, end: 4.1, text: "The quick brown fox jumps over the lazy dog.", language: "en", speaker: "Alice", completed: true }],
    });
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${id}`)).json()).status === "completed" ? true : null), { label: "completed" });
    const t = await (await h.api(`/v1/meetings/${id}/transcript`)).json();
    expect(t.text).toBe("Alice: The quick brown fox jumps over the lazy dog.");
    expect(logs.find((l) => l.msg === "falling back to vexa-native transcript")).toMatchObject({ level: "warn", data: { meetingId: id, provider: "tinfoil", reason: "no_usable_recording" } });
    expect(t.provider).toBe("vexa");
    expect(t.fallback_from).toBe("tinfoil");
    expect(t.fallback_reason).toBe("no_usable_recording");
    expect(logs.find((l) => l.msg === "transcript finalized")).toMatchObject({ data: { provider: "vexa", fallback_from: "tinfoil" } });
    const hook = await h.waitFor(async () => h.webhook.received.find((w) => w.body.type === "meeting.completed" && w.body.data.meeting_id === id) ?? null);
    expect(hook.body.data).toMatchObject({ transcript_provider: "vexa", fallback_from: "tinfoil", fallback_reason: "no_usable_recording" });
  });

  test("GET /v1/meetings/{id} surfaces the fallback once completed", async () => {
    const m = await (await h.api(`/v1/meetings/${id}`)).json();
    expect(m).toMatchObject({
      status: "completed",
      transcript_provider: "vexa",
      fallback_from: "tinfoil",
      fallback_reason: "no_usable_recording",
    });
  });
});
