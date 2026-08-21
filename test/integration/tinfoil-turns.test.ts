/**
 * TRANSCRIPTION_PROVIDER=tinfoil happy path with a persisted recording: mock Vexa serves a two-speaker
 * WAV (fixtures/alice.wav ++ fixtures/bob.wav) through the recordings API, a mock Tinfoil answers each
 * per-turn clip, and the stored transcript keeps Vexa's speaker turns with `provider: "tinfoil"`.
 * Needs ffmpeg (decode) — skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createApiKey } from "../../src/api/auth.ts";
import { meetings } from "../../src/db/schema.ts";
import { ApiError } from "../../src/domain/errors.ts";
import { getMeetingById } from "../../src/services/meetings.ts";
import { handleMeetingPoll } from "../../src/worker/meeting-job.ts";
import { decodeToPcm, pcmToWav, PCM_RATE } from "../../src/providers/transcription/audio.ts";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { startHarness, type Harness } from "./harness.ts";

const ffmpeg = Bun.which("ffmpeg");
let h: Harness;
let tinfoil: ReturnType<typeof Bun.serve>;
const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
const log = {
  debug: (msg: string, data?: Record<string, unknown>) => logs.push({ level: "debug", msg, data }),
  info: (msg: string, data?: Record<string, unknown>) => logs.push({ level: "info", msg, data }),
  warn: (msg: string, data?: Record<string, unknown>) => logs.push({ level: "warn", msg, data }),
  error: (msg: string, data?: Record<string, unknown>) => logs.push({ level: "error", msg, data }),
};
let recordingB64 = "";
let silentRecordingB64 = "";
let aliceSec = 0;
const tinfoilCalls: number[] = [];

describe.skipIf(!ffmpeg || !existsSync("fixtures/bob.wav"))("tinfoil provider with a persisted recording (per-turn)", () => {
  beforeAll(async () => {
    const a = await decodeToPcm(new Uint8Array(await Bun.file("fixtures/alice.wav").arrayBuffer()));
    const b = await decodeToPcm(new Uint8Array(await Bun.file("fixtures/bob.wav").arrayBuffer()));
    aliceSec = a.durationSec;
    const joined = new Int16Array(a.samples.length + b.samples.length);
    joined.set(a.samples, 0);
    joined.set(b.samples, a.samples.length);
    recordingB64 = Buffer.from(pcmToWav(joined, PCM_RATE)).toString("base64");
    silentRecordingB64 = Buffer.from(pcmToWav(new Int16Array(PCM_RATE * 6), PCM_RATE)).toString("base64");
    tinfoil = Bun.serve({
      port: 0,
      async fetch(req) {
        const form = await req.formData();
        const file = form.get("file") as File;
        const pcm = await decodeToPcm(new Uint8Array(await file.arrayBuffer()));
        tinfoilCalls.push(pcm.durationSec);
        // Pretend to be Voxtral: text depends on who is speaking (Alice's clip is the longer one at ~7 s).
        const text = pcm.durationSec > 6.8 ? "The quick brown fox jumps over the lazy dog. Hello from Alice." : "Good morning everyone, this is Bob. The meeting starts now.";
        return Response.json({ text, usage: { type: "duration", seconds: pcm.durationSec } });
      },
    });
    h = await startHarness({
      transcription: new TinfoilTranscriptionProvider({ baseUrl: `http://127.0.0.1:${tinfoil.port}`, apiKey: "tk_test", model: "voxtral-small-24b", log }),
      log,
    });
  });
  afterAll(async () => {
    await h?.stop();
    tinfoil?.stop(true);
  });

  const nativeId = "TurnsRoom@jitsi.local";
  let id: string;

  test("meeting completes with a per-turn Tinfoil transcript, provider=tinfoil", async () => {
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/TurnsRoom", language: "en", webhook_url: h.webhook.url } });
    expect(r.status).toBe(201);
    id = (await r.json()).id;
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${id}`)).json()).status === "joining" ? true : null));
    await h.vexa.control("jitsi", nativeId, {
      status: "completed",
      completion_reason: "stopped",
      recording_base64: recordingB64,
      recording_content_type: "audio/wav",
      segments: [
        { start: 1.5, end: 6.0, text: "The quick brown fox jumps over the lazy dog.", language: "en", speaker: "Alice", completed: true },
        { start: 6.5, end: 8.1, text: "Hello from Alice.", language: "en", speaker: "Alice", completed: true },
        { start: aliceSec + 1.5, end: aliceSec + 3.25, text: "Good morning everyone, this is Bob.", language: "en", speaker: "Bob", completed: true },
        { start: aliceSec + 3.75, end: aliceSec + 7.35, text: "The meeting starts now.", language: "en", speaker: "Bob", completed: true },
      ],
    });
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${id}`)).json()).status === "completed" ? true : null), { label: "completed" });
    const t = await (await h.api(`/v1/meetings/${id}/transcript`)).json();
    expect(t.provider).toBe("tinfoil");
    expect(t.speakers.map((s: any) => s.name)).toEqual(["Alice", "Bob"]);
    expect(t.segments).toHaveLength(2);
    expect(t.segments[0]).toMatchObject({ speaker_name: "Alice", start: 1.5, end: 8.1, text: "The quick brown fox jumps over the lazy dog. Hello from Alice." });
    expect(t.segments[1]).toMatchObject({ speaker_name: "Bob", text: "Good morning everyone, this is Bob. The meeting starts now." });
    expect(t.text).toBe("Alice: The quick brown fox jumps over the lazy dog. Hello from Alice.\nBob: Good morning everyone, this is Bob. The meeting starts now.");
    expect(t.duration_seconds).toBeGreaterThan(21);
    expect(tinfoilCalls).toHaveLength(2);
    expect(logs.find((l) => l.msg === "transcript finalized")).toMatchObject({ data: { provider: "tinfoil", segments: 2, stats: { mode: "turns", turns: 2, transcribed: 2, calls: 2 } } });
    await h.waitFor(async () => h.webhook.received.find((w) => w.body.type === "meeting.completed" && w.body.data.meeting_id === id) ?? null);
  });

  test("completed(left_alone) salvages its retained recording when live segments are empty", async () => {
    const nativeId = "RetainedRecording@jitsi.local";
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/RetainedRecording", language: "en" } });
    expect(r.status).toBe(201);
    const { id: meetingId } = await r.json();
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "joining" ? true : null));

    await h.vexa.control("jitsi", nativeId, {
      status: "completed",
      completion_reason: "left_alone",
      recording_base64: recordingB64,
      recording_content_type: "audio/wav",
      segments: [],
    });

    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "completed" ? true : null), { label: "retained recording completed" });
    const transcript = await (await h.api(`/v1/meetings/${meetingId}/transcript`)).json();
    expect(transcript.provider).toBe("tinfoil");
    expect(transcript.text).toContain("quick brown fox");
  });

  test("failed(evicted) salvages retained audio instead of discarding it", async () => {
    const nativeId = "EvictedWithAudio@jitsi.local";
    const r = await h.api("/v1/meetings", {
      method: "POST",
      json: { meeting_url: "https://jitsi.local/EvictedWithAudio", language: "en", webhook_url: h.webhook.url },
    });
    expect(r.status).toBe(201);
    const { id: meetingId } = await r.json();
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "joining" ? true : null));

    await h.vexa.control("jitsi", nativeId, {
      status: "failed",
      completion_reason: "evicted",
      recording_base64: recordingB64,
      recording_content_type: "audio/wav",
      segments: [],
    });

    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "completed" ? true : null), { label: "evicted recording completed" });
    const transcript = await (await h.api(`/v1/meetings/${meetingId}/transcript`)).json();
    expect(transcript.provider).toBe("tinfoil");
    expect(transcript.text).toContain("quick brown fox");
    await h.waitFor(async () => h.webhook.received.find((w) => w.body.type === "meeting.completed" && w.body.data.meeting_id === meetingId) ?? null);
    expect(h.webhook.received.filter((w) => w.body.type === "meeting.completed" && w.body.data.meeting_id === meetingId)).toHaveLength(1);
    expect(h.webhook.received.filter((w) => w.body.type === "meeting.failed" && w.body.data.meeting_id === meetingId)).toHaveLength(0);
  });

  test("failed meeting can be recovered once retained audio becomes available", async () => {
    const nativeId = "RecoverRecording@jitsi.local";
    const r = await h.api("/v1/meetings", {
      method: "POST",
      json: { meeting_url: "https://jitsi.local/RecoverRecording", language: "en", webhook_url: h.webhook.url },
    });
    expect(r.status).toBe(201);
    const { id: meetingId } = await r.json();
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "joining" ? true : null));
    await h.vexa.control("jitsi", nativeId, { status: "failed", completion_reason: "evicted", segments: [] });
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "failed" ? true : null), { label: "failed before recording ready" });

    await h.vexa.control("jitsi", nativeId, {
      status: "failed",
      completion_reason: "evicted",
      recording_base64: recordingB64,
      recording_content_type: "audio/wav",
    });

    const { key: otherProjectKey } = await createApiKey(h.ctx, "other-project");
    expect((await h.api(`/v1/meetings/${meetingId}/recover`, { method: "POST", key: otherProjectKey })).status).toBe(404);

    const [recover1, recover2] = await Promise.all([
      h.api(`/v1/meetings/${meetingId}/recover`, { method: "POST" }),
      h.api(`/v1/meetings/${meetingId}/recover`, { method: "POST" }),
    ]);
    expect(recover1.status).toBe(200);
    expect(recover2.status).toBe(200);
    expect(["processing", "completed"]).toContain((await recover1.json()).status);
    expect(["processing", "completed"]).toContain((await recover2.json()).status);

    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "completed" ? true : null), { label: "recovered meeting completed" });
    expect((await (await h.api(`/v1/meetings/${meetingId}/transcript`)).json()).text).toContain("quick brown fox");
    const completedAgain = await h.api(`/v1/meetings/${meetingId}/recover`, { method: "POST" });
    expect(await completedAgain.json()).toEqual({ id: meetingId, status: "completed" });
    await Bun.sleep(100);
    expect(h.webhook.received.filter((w) => w.body.type === "meeting.completed" && w.body.data.meeting_id === meetingId)).toHaveLength(1);
  });

  test("zero live segments plus an unusable recording fails instead of storing an empty transcript", async () => {
    const nativeId = "SilentRecording@jitsi.local";
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/SilentRecording", language: "en" } });
    const { id: meetingId } = await r.json();
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "joining" ? true : null));
    await h.vexa.control("jitsi", nativeId, {
      status: "completed",
      completion_reason: "left_alone",
      recording_base64: silentRecordingB64,
      recording_content_type: "audio/wav",
      segments: [{ start: 0, end: 1, text: "   ", language: "en", speaker: "Alice", completed: true }],
    });

    const failed = await h.waitFor(async () => {
      const body = await (await h.api(`/v1/meetings/${meetingId}`)).json();
      return body.status === "failed" ? body : null;
    }, { label: "silent recording failed" });
    expect(failed.error.code).toBe("transcription_failed");
    expect(await (await h.api(`/v1/meetings/${meetingId}/transcript`)).json()).toEqual({ meeting_id: meetingId, status: "failed" });
  });

  test("a transient retained-recording fetch outage retries instead of failing the meeting", async () => {
    const nativeId = "RecordingFetchRetry@jitsi.local";
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/RecordingFetchRetry", language: "en" } });
    const { id: meetingId } = await r.json();
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "joining" ? true : null));

    const originalMaster = h.ctx.vexa.recordingMaster.bind(h.ctx.vexa);
    let failOnce = true;
    h.ctx.vexa.recordingMaster = async (...args) => {
      if (failOnce) {
        failOnce = false;
        throw new ApiError("provider_timeout", "capture provider timeout");
      }
      return originalMaster(...args);
    };
    await h.vexa.control("jitsi", nativeId, {
      status: "completed",
      completion_reason: "left_alone",
      recording_base64: recordingB64,
      recording_content_type: "audio/wav",
      segments: [],
    });
    await h.waitFor(async () => ((await getMeetingById(h.ctx, meetingId))?.transcriptionAttempts === 1 ? true : null), { label: "recording fetch retry queued" });
    expect((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status).not.toBe("failed");

    h.ctx.vexa.recordingMaster = originalMaster;
    await handleMeetingPoll(h.ctx, meetingId);
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "completed" ? true : null), { label: "recording fetch retry completed" });
  });

  test("a recovery enqueue failure restores failed state so the caller can retry", async () => {
    const nativeId = "RecoverAfterQueueFailure@jitsi.local";
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/RecoverAfterQueueFailure", language: "en" } });
    const { id: meetingId } = await r.json();
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "joining" ? true : null));
    await h.vexa.control("jitsi", nativeId, { status: "failed", completion_reason: "evicted", segments: [] });
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "failed" ? true : null));
    await h.vexa.control("jitsi", nativeId, {
      status: "failed",
      completion_reason: "evicted",
      recording_base64: recordingB64,
      recording_content_type: "audio/wav",
    });

    const originalPush = h.ctx.queue.push.bind(h.ctx.queue);
    h.ctx.queue.push = async (job, delayMs) => {
      if (job.type === "meeting.poll" && job.meetingId === meetingId) throw new Error("redis unavailable");
      return originalPush(job, delayMs);
    };
    const unavailable = await h.api(`/v1/meetings/${meetingId}/recover`, { method: "POST" });
    expect(unavailable.status).toBe(500);
    expect((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status).toBe("failed");
    h.ctx.queue.push = originalPush;

    expect((await h.api(`/v1/meetings/${meetingId}/recover`, { method: "POST" })).status).toBe(200);
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "completed" ? true : null), { label: "recovery after queue restored" });
  });

  test("recover on a stranded processing row repairs the database-to-queue crash window", async () => {
    const nativeId = "RecoverStrandedProcessing@jitsi.local";
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/RecoverStrandedProcessing", language: "en" } });
    const { id: meetingId } = await r.json();
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "joining" ? true : null));
    await h.vexa.control("jitsi", nativeId, { status: "failed", completion_reason: "evicted", segments: [] });
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "failed" ? true : null));
    await h.vexa.control("jitsi", nativeId, {
      status: "failed",
      completion_reason: "evicted",
      recording_base64: recordingB64,
      recording_content_type: "audio/wav",
    });

    // Simulate a process dying after the database commit but before Redis accepted the poll.
    const failed = await getMeetingById(h.ctx, meetingId);
    expect(failed?.status).toBe("failed");
    await h.ctx.db.update(meetings).set({ status: "processing" }).where(eq(meetings.id, meetingId));

    const repaired = await h.api(`/v1/meetings/${meetingId}/recover`, { method: "POST" });
    expect(await repaired.json()).toEqual({ id: meetingId, status: "processing" });
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "completed" ? true : null), { label: "stranded processing recovery completed" });
  });
});
