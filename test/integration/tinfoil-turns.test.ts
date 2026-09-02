/**
 * TRANSCRIPTION_PROVIDER=tinfoil happy path with a persisted recording: mock Vexa serves a two-speaker
 * WAV (fixtures/alice.wav ++ fixtures/bob.wav) through the recordings API, a mock Tinfoil answers each
 * per-turn clip, and the stored transcript keeps Vexa's speaker turns with `provider: "tinfoil"`.
 * Needs ffmpeg (decode) — skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { meetings } from "../../src/db/schema.ts";
import { ApiError } from "../../src/domain/errors.ts";
import { getMeetingById } from "../../src/services/meetings.ts";
import { handleMeetingPoll } from "../../src/worker/meeting-job.ts";
import { decodeToPcm, pcmToWav, PCM_RATE } from "../../src/providers/transcription/audio.ts";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { VexaHttpError } from "../../src/providers/vexa/client.ts";
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

/** A well-formed manual recover request; retries of a lost response reuse the same key. */
const recover = (meetingId: string, key: string, apiKey?: string) =>
  h.api(`/v1/meetings/${meetingId}/recover`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    json: { kind: "manual" },
    ...(apiKey ? { key: apiKey } : {}),
  });
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
      // Deliberately true to prove A0/A1 containment is not bypassed by the intent switch alone.
      // No A2-A4 transactional/capability authority is installed in this harness.
      recoveryV2Enabled: true,
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

  test("speaker timing is retained even when a live segment has no Whisper words", async () => {
    const nativeId = "BlankTimelineTurn@jitsi.local";
    const callsBefore = tinfoilCalls.length;
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/BlankTimelineTurn", language: "en" } });
    const { id: meetingId } = await r.json();
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "joining" ? true : null));
    await h.vexa.control("jitsi", nativeId, {
      status: "completed",
      completion_reason: "stopped",
      recording_base64: recordingB64,
      recording_content_type: "audio/wav",
      segments: [
        { start: 1.5, end: 8.1, text: "Whisper heard Alice.", language: "en", speaker: "Alice", completed: true },
        { start: aliceSec + 1.5, end: aliceSec + 7.35, text: "   ", language: "en", speaker: "Bob", completed: true },
      ],
    });

    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "completed" ? true : null), { label: "blank timeline turn completed" });
    const transcript = await (await h.api(`/v1/meetings/${meetingId}/transcript`)).json();
    expect(transcript.speakers.map((speaker: { name: string }) => speaker.name)).toEqual(["Alice", "Bob"]);
    expect(transcript.segments).toHaveLength(2);
    expect(tinfoilCalls.length - callsBefore).toBe(2);
  });

  test("permanent and blank per-turn provider responses fail as provider_rejected without whole-meeting Vexa fallback", async () => {
    const originalProvider = h.ctx.transcription;
    const exactRecording = Buffer.from(pcmToWav(new Int16Array(PCM_RATE * 2).fill(1_000), PCM_RATE)).toString("base64");
    try {
      for (const entry of [
        { room: "PermanentTurnRejection", response: "http_400" as const },
        { room: "BlankTurnSuccess", response: "mixed_blank" as const },
      ]) {
        let calls = 0;
        h.ctx.transcription = new TinfoilTranscriptionProvider({
          baseUrl: "https://provider.invalid/inert",
          apiKey: "synthetic",
          model: "synthetic",
          maxRetries: 0,
          fetch: (async () => {
            calls += 1;
            if (entry.response === "http_400") return new Response("discarded", { status: 400 });
            return Response.json({ text: calls === 1 ? "provider sibling" : " \t\n" });
          }) as unknown as typeof fetch,
          log,
        });
        const nativeId = `${entry.room}@jitsi.local`;
        const created = await h.api("/v1/meetings", {
          method: "POST",
          json: { meeting_url: `https://jitsi.local/${entry.room}`, language: "en" },
        });
        const { id: meetingId } = await created.json();
        await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "joining" ? true : null));
        await h.vexa.control("jitsi", nativeId, {
          status: "completed",
          completion_reason: "stopped",
          duration_seconds: 2,
          recording_base64: exactRecording,
          recording_content_type: "audio/wav",
          segments: [
            { start: 0, end: 1, text: "exact first fallback", language: "en", speaker: "Alice", completed: true },
            { start: 1, end: 2, text: "exact second fallback", language: "en", speaker: "Bob", completed: true },
          ],
        });
        const failed = await h.waitFor(async () => {
          const body = await (await h.api(`/v1/meetings/${meetingId}`)).json();
          return body.status === "failed" ? body : null;
        }, { label: `${entry.room} provider rejection` });
        expect({ room: entry.room, code: failed.error.code }).toEqual({ room: entry.room, code: "provider_rejected" });
        expect(await (await h.api(`/v1/meetings/${meetingId}/transcript`)).json())
          .toEqual({ meeting_id: meetingId, status: "failed", transcript_revision: 0 });
      }
    } finally {
      h.ctx.transcription = originalProvider;
    }
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
    expect(failed.error.code).toBe("recording_silent");
    expect(await (await h.api(`/v1/meetings/${meetingId}/transcript`)).json()).toEqual({
      meeting_id: meetingId,
      status: "failed",
      transcript_revision: 0,
    });
  });

  test("initial finalization preserves exact retained-recording terminal codes", async () => {
    const cases = [
      { room: "AbsentRecording", expected: "recording_absent", recording_base64: undefined },
      {
        room: "UndecodableRecording",
        expected: "recording_undecodable",
        recording_base64: Buffer.alloc(64_000, 1).toString("base64"),
      },
    ];

    for (const entry of cases) {
      const nativeId = `${entry.room}@jitsi.local`;
      const created = await h.api("/v1/meetings", {
        method: "POST",
        json: { meeting_url: `https://jitsi.local/${entry.room}`, language: "en" },
      });
      const { id: meetingId } = await created.json();
      await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "joining" ? true : null));
      await h.vexa.control("jitsi", nativeId, {
        status: "completed",
        completion_reason: "stopped",
        ...(entry.recording_base64
          ? { recording_base64: entry.recording_base64, recording_content_type: "audio/webm" }
          : {}),
        segments: [],
      });

      const failed = await h.waitFor(async () => {
        const body = await (await h.api(`/v1/meetings/${meetingId}`)).json();
        return body.status === "failed" ? body : null;
      }, { label: `${entry.expected} terminal code` });
      expect({ room: entry.room, code: failed.error.code }).toEqual({ room: entry.room, code: entry.expected });
    }
  });

  test("persistent Vexa recording fetch failures use the exact bounded recording taxonomy", async () => {
    const originalMaster = h.ctx.vexa.recordingMaster.bind(h.ctx.vexa);
    const hostileProviderText = [
      "https://provider.invalid/recordings/VEXA_RECORDING_RAW_ID_SENTINEL",
      '{"detail":"VEXA_PROVIDER_BODY_SENTINEL"}',
      "vxa_VEXA_SECRET_SENTINEL",
      "Error: VEXA_EXCEPTION_SENTINEL",
      "at providerFrame (/srv/provider.ts:4:2) VEXA_STACK_SENTINEL",
    ].join(" ");
    const cases: {
      room: string;
      expected: "recording_absent" | "recording_fetch_transient" | "transcription_failed";
      error: () => Error;
    }[] = [
      {
        room: "PersistentRecording404",
        expected: "recording_absent",
        error: () => new VexaHttpError(404),
      },
      {
        room: "PersistentRecording429",
        expected: "recording_fetch_transient",
        error: () => new VexaHttpError(429),
      },
      {
        room: "PersistentRecording5xx",
        expected: "recording_fetch_transient",
        error: () => new VexaHttpError(503),
      },
      {
        room: "PersistentRecordingTransport",
        expected: "recording_fetch_transient",
        error: () => new ApiError("provider_unavailable", hostileProviderText),
      },
      {
        room: "PermanentRecording4xx",
        expected: "transcription_failed",
        error: () => new VexaHttpError(400),
      },
      {
        room: "UnknownRecordingError",
        expected: "transcription_failed",
        error: () => new Error(hostileProviderText),
      },
    ];

    try {
      for (const entry of cases) {
        h.ctx.vexa.recordingMaster = async () => {
          const error = entry.error();
          error.message = hostileProviderText;
          throw error;
        };
        const nativeId = `${entry.room}@jitsi.local`;
        const created = await h.api("/v1/meetings", {
          method: "POST",
          json: { meeting_url: `https://jitsi.local/${entry.room}`, language: "en" },
        });
        const { id: meetingId } = await created.json();
        await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "joining" ? true : null));
        await h.vexa.control("jitsi", nativeId, {
          status: "completed",
          completion_reason: "stopped",
          recording_base64: recordingB64,
          recording_content_type: "audio/wav",
          segments: [],
        });

        await h.waitFor(async () => {
          const meeting = await getMeetingById(h.ctx, meetingId);
          return meeting?.status === "failed" || meeting?.transcriptionAttempts === 1 ? true : null;
        }, { label: `${entry.room} first recording fetch outcome` });
        if ((await getMeetingById(h.ctx, meetingId))?.status !== "failed") {
          await handleMeetingPoll(h.ctx, meetingId);
          await handleMeetingPoll(h.ctx, meetingId);
        }

        const failed = await h.waitFor(async () => {
          const body = await (await h.api(`/v1/meetings/${meetingId}`)).json();
          return body.status === "failed" ? body : null;
        }, { label: `${entry.expected} exhausted recording fetch` });
        const stored = await getMeetingById(h.ctx, meetingId);
        expect({ room: entry.room, apiCode: failed.error.code, storedCode: stored?.errorCode }).toEqual({
          room: entry.room,
          apiCode: entry.expected,
          storedCode: entry.expected,
        });
        expect(failed.recovery.eligible).toBe(false);
        const serialized = JSON.stringify({ failed, storedMessage: stored?.errorMessage });
        for (const sentinel of ["VEXA_RECORDING_RAW_ID_SENTINEL", "VEXA_PROVIDER_BODY_SENTINEL", "VEXA_SECRET_SENTINEL", "VEXA_EXCEPTION_SENTINEL", "VEXA_STACK_SENTINEL"]) {
          expect(serialized).not.toContain(sentinel);
        }
      }
    } finally {
      h.ctx.vexa.recordingMaster = originalMaster;
    }
  }, 30_000);

  test("initial finalization preserves provider_timeout and provider_unavailable after bounded retries", async () => {
    const originalProvider = h.ctx.transcription;
    try {
      for (const code of ["provider_timeout", "provider_unavailable"] as const) {
        const failure = new Error(`synthetic ${code}`);
        if (code === "provider_timeout") failure.name = "TimeoutError";
        h.ctx.transcription = new TinfoilTranscriptionProvider({
          baseUrl: "https://provider.invalid/never-requested",
          apiKey: "synthetic",
          model: "synthetic",
          segmentation: "whole",
          fetch: (async () => {
            throw failure;
          }) as unknown as typeof fetch,
          log,
        });

        const room = code === "provider_timeout" ? "InitialProviderTimeout" : "InitialProviderUnavailable";
        const nativeId = `${room}@jitsi.local`;
        const created = await h.api("/v1/meetings", {
          method: "POST",
          json: { meeting_url: `https://jitsi.local/${room}`, language: "en" },
        });
        const { id: meetingId } = await created.json();
        await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "joining" ? true : null));
        await h.vexa.control("jitsi", nativeId, {
          status: "completed",
          completion_reason: "stopped",
          recording_base64: recordingB64,
          recording_content_type: "audio/wav",
          segments: [],
        });
        await h.waitFor(async () => ((await getMeetingById(h.ctx, meetingId))?.transcriptionAttempts === 1 ? true : null), {
          label: `${code} first attempt`,
        });
        await handleMeetingPoll(h.ctx, meetingId);
        await handleMeetingPoll(h.ctx, meetingId);

        const failed = await h.waitFor(async () => {
          const body = await (await h.api(`/v1/meetings/${meetingId}`)).json();
          return body.status === "failed" ? body : null;
        }, { label: `${code} terminal code` });
        expect({ expected: code, actual: failed.error.code }).toEqual({ expected: code, actual: code });
      }
    } finally {
      h.ctx.transcription = originalProvider;
    }
  }, 15_000);

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

  test("a transient Vexa recording response also retries when live speaker words exist", async () => {
    const nativeId = "RecordingHttpRetryWithWords@jitsi.local";
    const r = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/RecordingHttpRetryWithWords", language: "en" } });
    const { id: meetingId } = await r.json();
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "joining" ? true : null));

    const originalMaster = h.ctx.vexa.recordingMaster.bind(h.ctx.vexa);
    h.ctx.vexa.recordingMaster = async () => {
      throw new VexaHttpError(503);
    };
    await h.vexa.control("jitsi", nativeId, {
      status: "completed",
      completion_reason: "left_alone",
      recording_base64: recordingB64,
      recording_content_type: "audio/wav",
      segments: [{ start: 1.5, end: 8.1, text: "Live words remain available.", language: "en", speaker: "Alice", completed: true }],
    });
    await h.waitFor(async () => ((await getMeetingById(h.ctx, meetingId))?.transcriptionAttempts === 1 ? true : null), { label: "Vexa HTTP recording retry queued" });
    expect((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status).toBe("processing");

    h.ctx.vexa.recordingMaster = originalMaster;
    await handleMeetingPoll(h.ctx, meetingId);
    await h.waitFor(async () => ((await (await h.api(`/v1/meetings/${meetingId}`)).json()).status === "completed" ? true : null), { label: "Vexa HTTP recording retry completed" });
  });

  test("recover on a stranded processing row stays a read-only already_active answer", async () => {
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

    // Even with the recovery switch on, a processing meeting is reported and never re-driven:
    // re-queueing on demand would amplify duplicate work under client retries. Repairing this
    // crash window is recovery-v2 work.
    const before = await h.ctx.queue.size();
    const contained = await recover(meetingId, "recover-stranded-processing");
    expect(contained.status).toBe(200);
    expect(await contained.json()).toEqual({
      id: meetingId,
      status: "processing",
      recovery: {
        operation_id: null,
        disposition: "already_active",
        kind: "manual",
        phase: null,
        attempt: null,
        max_attempts: null,
        next_eligible_at: null,
      },
    });
    const after = await h.ctx.queue.size();
    expect(after.ready + after.delayed).toBeLessThanOrEqual(before.ready + before.delayed);
    expect((await getMeetingById(h.ctx, meetingId))?.status).toBe("processing");
  });
});
