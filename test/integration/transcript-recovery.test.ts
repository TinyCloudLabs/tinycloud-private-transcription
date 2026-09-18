import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { PCM_RATE, pcmToWav } from "../../src/providers/transcription/audio.ts";
import { ApiError } from "../../src/domain/errors.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
let tinfoilCalls: Array<{ fields: string[]; fileSize: number }> = [];
const recording = (seconds = 1) => Buffer.from(pcmToWav(new Int16Array(PCM_RATE * seconds).fill(2_000), PCM_RATE)).toString("base64");
const recordingBase64 = recording();
beforeAll(async () => {
  h = await startHarness({
    transcriptRecovery: new TinfoilTranscriptionProvider({
      baseUrl: "https://tinfoil.test",
      apiKey: "test",
      model: "voxtral-small-24b",
      fetch: (async (_url: string, init: RequestInit) => {
        const form = init.body as FormData;
        const file = form.get("file") as File;
        tinfoilCalls.push({ fields: [...form.keys()], fileSize: file.size });
        return Response.json({ text: "Recovered final remarks.", language: "en", duration: 120 });
      }) as unknown as typeof fetch,
    }),
  });
});
afterAll(() => h.stop());

const waitStatus = (id: string, status: string) => h.waitFor(async () => {
  const body = await (await h.api(`/v1/meetings/${id}`)).json();
  return body.status === status ? body : null;
});

describe("recording recovery and transcript JSON compatibility", () => {
  test("health continues to report Vexa while recording recovery is configured", async () => {
    const health = await (await h.api("/health", { key: null })).json();
    expect(health.checks.transcription_provider).toBe("vexa");
  });

  test("a short complete native timeline is preserved unchanged", async () => {
    const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/ShortComplete" } });
    const { id } = await created.json();
    const native = "ShortComplete@jitsi.local";
    await waitStatus(id, "joining");
    expect(h.vexa.meetings.get(`jitsi/${native}`)?.recording_enabled).toBe(true);
    const callsBefore = tinfoilCalls.length;
    await h.vexa.control("jitsi", native, {
      status: "completed",
      completion_reason: "stopped",
      start_time: "2026-09-18T10:00:00.000Z",
      end_time: "2026-09-18T10:00:10.000Z",
      segments: [{ start: 0, end: 3, text: "Native final words.", speaker: "Alice", completed: true }],
      recording_base64: recordingBase64,
    });
    await waitStatus(id, "completed");
    const transcript = await (await h.api(`/v1/meetings/${id}/transcript`)).json();
    expect(transcript).toMatchObject({ provider: "vexa", speakers: [{ name: "Alice" }], text: "Alice: Native final words." });
    expect(transcript.segments).toEqual([{
      id: "seg_001",
      speaker_id: "speaker_0",
      speaker_name: "Alice",
      start: 0,
      end: 3,
      text: "Native final words.",
    }]);
    expect(tinfoilCalls).toHaveLength(callsBefore);
    const [stored] = await h.ctx.db.execute(sql`select jsonb_typeof(segments_json) as type from transcripts where meeting_id = ${id}`);
    expect(stored).toEqual({ type: "object" });
  });

  test("a materially incomplete native timeline falls back to the full recording without diarization", async () => {
    const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/RecoveryRoom" } });
    const { id } = await created.json();
    const native = "RecoveryRoom@jitsi.local";
    await waitStatus(id, "joining");
    await h.vexa.control("jitsi", native, {
      status: "completed",
      completion_reason: "stopped",
      start_time: "2026-09-18T10:00:00.000Z",
      end_time: "2026-09-18T10:02:00.000Z",
      segments: [{ start: 0, end: 20, text: "Only the beginning survived.", speaker: "Alice", completed: true }],
      recording_base64: recordingBase64,
    });
    await waitStatus(id, "completed");
    const response = await h.api(`/v1/meetings/${id}/transcript`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: "tinfoil", speakers: [{ name: "Unknown" }], text: "Unknown: Recovered final remarks." });
    expect(tinfoilCalls.at(-1)).toMatchObject({ fields: ["model", "response_format", "file"] });
    expect(tinfoilCalls.at(-1)!.fileSize).toBeGreaterThan(PCM_RATE * 2);
  });

  test("a scaled long recording is chunked through the public recovery path", async () => {
    const original = h.ctx.transcriptRecovery;
    const names: string[] = [];
    h.ctx.transcriptRecovery = new TinfoilTranscriptionProvider({
      baseUrl: "https://tinfoil.test",
      apiKey: "test",
      model: "voxtral-small-24b",
      wholeChunkSec: 1,
      fetch: (async (_url: string, init: RequestInit) => {
        const file = (init.body as FormData).get("file") as File;
        names.push(file.name);
        return Response.json({ text: file.name, language: "en" });
      }) as typeof fetch,
    });
    const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/ScaledLong" } });
    const { id } = await created.json();
    await waitStatus(id, "joining");
    await h.vexa.control("jitsi", "ScaledLong@jitsi.local", {
      status: "completed",
      completion_reason: "stopped",
      start_time: "2026-09-18T10:00:00.000Z",
      end_time: "2026-09-18T10:02:00.000Z",
      segments: [{ start: 0, end: 10, text: "Incomplete native text.", speaker: "Alice", completed: true }],
      recording_base64: recording(3),
    });
    await waitStatus(id, "completed");
    h.ctx.transcriptRecovery = original;
    const transcript = await (await h.api(`/v1/meetings/${id}/transcript`)).json();
    expect(names.length).toBeGreaterThan(1);
    expect(transcript.provider).toBe("tinfoil");
    expect(transcript.segments.map((segment: { text: string }) => segment.text)).toEqual(names);
    expect(transcript.segments.every((segment: { speaker_name: string }) => segment.speaker_name === "Unknown")).toBe(true);
    expect(transcript.duration_seconds).toBe(3);
  });

  test.each(["left_alone", "evicted"] as const)("empty completed %s capture is salvaged from retained audio", async (reason) => {
    const room = `Empty-${reason}`;
    const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: `https://jitsi.local/${room}` } });
    const { id } = await created.json();
    await waitStatus(id, "joining");
    await h.vexa.control("jitsi", `${room}@jitsi.local`, {
      status: "completed",
      completion_reason: reason,
      segments: [],
      recording_base64: recordingBase64,
    });
    await waitStatus(id, "completed");
    expect(await (await h.api(`/v1/meetings/${id}/transcript`)).json()).toMatchObject({
      provider: "tinfoil",
      speakers: [{ name: "Unknown" }],
    });
  });

  test("failed active-stage capture is salvaged but a pre-admission failure remains mapped", async () => {
    const active = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/FailedActive" } });
    const { id: activeId } = await active.json();
    await waitStatus(activeId, "joining");
    await h.vexa.control("jitsi", "FailedActive@jitsi.local", {
      status: "failed",
      failure_stage: "active",
      completion_reason: "evicted",
      segments: [],
      recording_base64: recordingBase64,
    });
    await waitStatus(activeId, "completed");
    expect(await (await h.api(`/v1/meetings/${activeId}/transcript`)).json()).toMatchObject({ provider: "tinfoil" });

    const callsBefore = tinfoilCalls.length;
    const waiting = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/FailedWaiting" } });
    const { id: waitingId } = await waiting.json();
    await waitStatus(waitingId, "joining");
    await h.vexa.control("jitsi", "FailedWaiting@jitsi.local", {
      status: "failed",
      failure_stage: "awaiting_admission",
      completion_reason: "awaiting_admission_timeout",
      segments: [],
      recording_base64: recordingBase64,
    });
    const failed = await waitStatus(waitingId, "failed");
    expect(failed.error.code).toBe("waiting_room_timeout");
    expect(tinfoilCalls).toHaveLength(callsBefore);
  });

  test("recording readiness is retried and succeeds when the recording appears", async () => {
    const originalList = h.ctx.vexa.listRecordings.bind(h.ctx.vexa);
    const originalMaster = h.ctx.vexa.recordingMaster.bind(h.ctx.vexa);
    let listCalls = 0;
    let masterCalls = 0;
    h.ctx.vexa.listRecordings = async () => ++listCalls === 1 ? { recordings: [] } : originalList();
    h.ctx.vexa.recordingMaster = async (...args) => ++masterCalls === 1 ? { raw_url: null } : originalMaster(...args);
    const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/DelayedRecording" } });
    const { id } = await created.json();
    await waitStatus(id, "joining");
    await h.vexa.control("jitsi", "DelayedRecording@jitsi.local", {
      status: "completed",
      completion_reason: "left_alone",
      segments: [],
      recording_base64: recordingBase64,
    });
    await waitStatus(id, "completed");
    h.ctx.vexa.listRecordings = originalList;
    h.ctx.vexa.recordingMaster = originalMaster;
    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(masterCalls).toBeGreaterThanOrEqual(2);
  });

  test("an active-stage terminal row with no retained recording keeps its mapped failure", async () => {
    const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/NoRecording" } });
    const { id } = await created.json();
    await waitStatus(id, "joining");
    await h.vexa.control("jitsi", "NoRecording@jitsi.local", {
      status: "completed",
      completion_reason: "left_alone",
      segments: [],
    });
    const failed = await waitStatus(id, "failed");
    expect(failed.error.code).toBe("meeting_ended");
  });

  test("exhausted recovery preserves nonempty Vexa text while zero-word exhaustion fails explicitly", async () => {
    const original = h.ctx.transcriptRecovery;
    let attempts = 0;
    h.ctx.transcriptRecovery = {
      name: "tinfoil",
      async transcribe() {
        attempts++;
        throw new ApiError("provider_unavailable", "Tinfoil unavailable");
      },
    };
    const withWords = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/PreserveNative" } });
    const { id: withWordsId } = await withWords.json();
    await waitStatus(withWordsId, "joining");
    await h.vexa.control("jitsi", "PreserveNative@jitsi.local", {
      status: "completed",
      completion_reason: "stopped",
      start_time: "2026-09-18T10:00:00.000Z",
      end_time: "2026-09-18T10:02:00.000Z",
      segments: [{ start: 0, end: 10, text: "Keep these Vexa words.", speaker: "Alice", completed: true }],
      recording_base64: recordingBase64,
    });
    await waitStatus(withWordsId, "completed");
    expect(await (await h.api(`/v1/meetings/${withWordsId}/transcript`)).json()).toMatchObject({
      provider: "vexa",
      text: "Alice: Keep these Vexa words.",
    });

    const empty = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/FailEmpty" } });
    const { id: emptyId } = await empty.json();
    await waitStatus(emptyId, "joining");
    await h.vexa.control("jitsi", "FailEmpty@jitsi.local", {
      status: "completed",
      completion_reason: "left_alone",
      segments: [],
      recording_base64: recordingBase64,
    });
    const failed = await waitStatus(emptyId, "failed");
    h.ctx.transcriptRecovery = original;
    expect(failed.error.code).toBe("transcription_failed");
    expect(attempts).toBe(2);
  });

  test("GET transcript serializes legacy double-encoded jsonb rows as objects", async () => {
    const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/LegacyJson" } });
    const { id } = await created.json();
    const native = "LegacyJson@jitsi.local";
    await waitStatus(id, "joining");
    await h.vexa.control("jitsi", native, { status: "completed", completion_reason: "stopped", segments: [{ start: 0, end: 1, text: "Native text", speaker: "Alice", completed: true }] });
    await waitStatus(id, "completed");
    const legacy = JSON.stringify({ speakers: [{ id: "speaker_0", name: "Legacy" }], segments: [{ id: "seg_001", speaker_id: "speaker_0", speaker_name: "Legacy", start: 0, end: 1, text: "Still readable" }], text: "Legacy: Still readable" });
    await h.ctx.db.execute(sql`update transcripts set segments_json = ${JSON.stringify(legacy)}::jsonb where meeting_id = ${id}`);
    const response = await h.api(`/v1/meetings/${id}/transcript`);
    expect(response.status).toBe(200);
    const transcript = await response.json();
    expect(transcript).toMatchObject({ speakers: [{ name: "Legacy" }], segments: [{ text: "Still readable" }], text: "Legacy: Still readable" });
  });
});
