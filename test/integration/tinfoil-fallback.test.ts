/**
 * TRANSCRIPTION_PROVIDER=tinfoil against a Vexa that persists no usable recording (mock: `recordings: []`,
 * same as the real rig's "silent tap" after the bitrate sanity check): the worker asks Vexa for
 * `recording_enabled`, then falls back to the Vexa-native transcript instead of failing the meeting.
 * No Tinfoil call is made (nothing to send).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { protectedCorrelation } from "../../src/log.ts";
import { pcmToWav, PCM_RATE } from "../../src/providers/transcription/audio.ts";
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

  test("bot is requested in recording-only mode", async () => {
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/TinfoilRoom", language: "en", webhook_url: h.webhook.url } });
    expect(r.status).toBe(201);
    id = (await r.json()).id;
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${id}`)).json()).status === "joining" ? true : null));
    expect(h.vexa.meetings.get(`jitsi/${nativeId}`)?.recording_enabled).toBe(true);
    expect(h.vexa.meetings.get(`jitsi/${nativeId}`)?.transcribe_enabled).toBe(false);
  });

  test("falls back to the vexa-native transcript and logs it", async () => {
    await h.vexa.control("jitsi", nativeId, {
      status: "completed",
      completion_reason: "stopped",
      duration_seconds: 4.1,
      segments: [{ start: 0, end: 4.1, text: "The quick brown fox jumps over the lazy dog.", language: "en", speaker: "Alice", completed: true }],
    });
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${id}`)).json()).status === "completed" ? true : null), { label: "completed" });
    const t = await (await h.api(`/v1/meetings/${id}/transcript`)).json();
    expect(t.text).toBe("Alice: The quick brown fox jumps over the lazy dog.");
    expect(t.segments).toEqual([expect.objectContaining({ provenance: "vexa_fallback" })]);
    expect(logs.find((l) => l.msg === "falling back to vexa-native transcript")).toMatchObject({
      level: "warn",
      data: {
        meetingCorrelation: protectedCorrelation("meeting", id),
        provider: "tinfoil",
        reason: "no_usable_recording",
      },
    });
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

  test("rejects the legacy some-words fallback when the finalized interval has a gap", async () => {
    const native = "TinfoilGap@jitsi.local";
    const created = await h.api("/v1/meetings", {
      method: "POST",
      json: { meeting_url: "https://jitsi.local/TinfoilGap", language: "en" },
    });
    expect(created.status).toBe(201);
    const gapId = (await created.json()).id as string;
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${gapId}`)).json()).status === "joining" ? true : null));
    await h.vexa.control("jitsi", native, {
      status: "completed",
      completion_reason: "stopped",
      duration_seconds: 4.1,
      segments: [
        { start: 0, end: 1, text: "leading words", language: "en", speaker: "Alice", completed: true },
        { start: 2, end: 4.1, text: "trailing words", language: "en", speaker: "Alice", completed: true },
      ],
    });
    const failed = await h.waitFor(async () => {
      const body = await (await h.api(`/v1/meetings/${gapId}`)).json();
      return body.status === "failed" ? body : null;
    }, { label: "coverage-incomplete legacy fallback" });
    expect(failed.error?.code).toBe("coverage_incomplete");
    const unavailable = await (await h.api(`/v1/meetings/${gapId}/transcript`)).json();
    expect(unavailable).toMatchObject({ status: "failed" });
    expect(unavailable.text).toBeUndefined();
  });

  test("rejects coverage that ends before the decoded recording duration", async () => {
    const native = "TinfoilTrailing@jitsi.local";
    const created = await h.api("/v1/meetings", {
      method: "POST",
      json: { meeting_url: "https://jitsi.local/TinfoilTrailing", language: "en" },
    });
    const trailingId = (await created.json()).id as string;
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${trailingId}`)).json()).status === "joining" ? true : null));
    const recording = pcmToWav(new Int16Array(PCM_RATE * 4), PCM_RATE);
    await h.vexa.control("jitsi", native, {
      status: "completed",
      completion_reason: "stopped",
      duration_seconds: 2,
      recording_base64: Buffer.from(recording).toString("base64"),
      recording_content_type: "audio/wav",
      segments: [{ start: 0, end: 2, text: "only half", language: "en", speaker: "Alice", completed: true }],
    });
    const failed = await h.waitFor(async () => {
      const body = await (await h.api(`/v1/meetings/${trailingId}`)).json();
      return body.status === "failed" ? body : null;
    }, { label: "decoded-duration fallback rejection" });
    expect(failed.error?.code).toBe("coverage_incomplete");
    const transcript = await (await h.api(`/v1/meetings/${trailingId}/transcript`)).json();
    expect(transcript.text).toBeUndefined();
  });

  test("rejects fallback ending at a rounded-down millisecond when decoded audio has a sub-millisecond tail", async () => {
    const native = "TinfoilSubMillisecondTail@jitsi.local";
    const created = await h.api("/v1/meetings", {
      method: "POST",
      json: { meeting_url: "https://jitsi.local/TinfoilSubMillisecondTail", language: "en" },
    });
    expect(created.status).toBe(201);
    const tailId = (await created.json()).id as string;
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${tailId}`)).json()).status === "joining" ? true : null));
    const recording = pcmToWav(new Int16Array(PCM_RATE * 2 + 1), PCM_RATE);
    await h.vexa.control("jitsi", native, {
      status: "completed",
      completion_reason: "stopped",
      duration_seconds: 2,
      recording_base64: Buffer.from(recording).toString("base64"),
      recording_content_type: "audio/wav",
      segments: [{ start: 0, end: 2, text: "rounded-down coverage", language: "en", speaker: "Alice", completed: true }],
    });
    const failed = await h.waitFor(async () => {
      const body = await (await h.api(`/v1/meetings/${tailId}`)).json();
      return body.status === "failed" ? body : null;
    }, { label: "sub-millisecond-tail fallback rejection" });
    expect(failed.error?.code).toBe("coverage_incomplete");
    const transcript = await (await h.api(`/v1/meetings/${tailId}/transcript`)).json();
    expect(transcript.text).toBeUndefined();
  });
});
