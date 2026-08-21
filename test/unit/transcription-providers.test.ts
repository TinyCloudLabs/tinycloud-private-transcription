import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { VexaNativeProvider } from "../../src/providers/transcription/vexa-native.ts";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { createTranscriptionProvider } from "../../src/providers/transcription/index.ts";
import { pcmToWav, PCM_RATE } from "../../src/providers/transcription/audio.ts";
import fixture from "../fixtures/tinfoil-verbose.json";

const vexaSegments = [
  { start: 0, end: 4, text: "Hello this is a test of the private transcription pipeline", language: "en", speaker: "Sam", completed: true },
  { start: 4, end: 6.5, text: "Sounds good", language: "en", speaker: "Bob", completed: true },
  { start: 6.5, end: 7, text: "partial", language: "en", speaker: "Bob", completed: false },
];

describe("VexaNativeProvider", () => {
  test("passes through completed segments", async () => {
    const t = await new VexaNativeProvider().transcribe({
      meetingId: "mtg_x",
      language: null,
      vexaSegments,
      fetchAudio: async () => null,
    });
    expect(t.segments).toHaveLength(2);
    expect(t.speakers.map((s) => s.name)).toEqual(["Sam", "Bob"]);
    expect(t.language).toBe("en");
    expect(t.text).toContain("Sam: Hello");
  });
});

describe("TinfoilTranscriptionProvider (mock server)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let lastRequest: { auth: string | null; model: string | null; fileName: string | null; fileSize: number; format: string | null } | null = null;
  let mode: "ok" | "json" | "500" | "401" = "ok";

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/v1/audio/transcriptions" || req.method !== "POST") return new Response("nope", { status: 404 });
        const form = await req.formData();
        const file = form.get("file");
        lastRequest = {
          auth: req.headers.get("authorization"),
          model: form.get("model") as string | null,
          format: form.get("response_format") as string | null,
          fileName: file instanceof Blob ? (file as File).name : null,
          fileSize: file instanceof Blob ? file.size : 0,
        };
        if (mode === "500") return new Response("boom", { status: 500 });
        if (mode === "401") return new Response("{}", { status: 401 });
        // Real Tinfoil `json` shape for voxtral-small-24b (observed live 2026-08-18): text + billed duration, no segments.
        if (mode === "json") return Response.json({ text: "The quick brown fox jumps over the lazy dog. Hello from Alice.", usage: { type: "duration", seconds: 12 } });
        return Response.json(fixture);
      },
    });
  });
  afterAll(() => server.stop(true));

  const provider = () =>
    new TinfoilTranscriptionProvider({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "tk_test", model: "voxtral-small-24b", segmentation: "whole" });
  const audioBytes = pcmToWav(new Int16Array(PCM_RATE * 12).fill(2000), PCM_RATE);
  const audio = async () => ({ bytes: audioBytes, filename: "meeting.wav", contentType: "audio/wav" });

  test("posts multipart audio (response_format=json by default) and honours segments when returned", async () => {
    mode = "ok";
    const t = await provider().transcribe({ meetingId: "mtg_x", language: "en", vexaSegments, fetchAudio: audio });
    expect(lastRequest).toEqual({ auth: "Bearer tk_test", model: "voxtral-small-24b", format: "json", fileName: "meeting.wav", fileSize: audioBytes.length });
    expect(t.language).toBe("en");
    expect(t.duration_seconds).toBe(12);
    expect(t.segments.map((s) => s.speaker_name)).toEqual(["Sam", "Bob"]);
    expect(t.text).toBe("Sam: Hello, this is a test of the private transcription pipeline.\nBob: Sounds good to me.");
  });

  test("json (text + usage.seconds, no segments) -> one segment, dominant Vexa speaker, provider duration", async () => {
    mode = "json";
    const t = await provider().transcribe({ meetingId: "mtg_x", language: "en", vexaSegments, fetchAudio: audio });
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0]).toMatchObject({ start: 0, end: 12, speaker_name: "Sam" });
    expect(t.duration_seconds).toBe(12);
    expect(t.text).toBe("Sam: The quick brown fox jumps over the lazy dog. Hello from Alice.");
    mode = "ok";
  });

  test("no audio -> transcription_failed", async () => {
    await expect(
      provider().transcribe({ meetingId: "mtg_x", language: null, vexaSegments, fetchAudio: async () => null }),
    ).rejects.toMatchObject({ code: "transcription_failed" });
  });

  test("5xx -> provider_unavailable (retryable), 4xx -> transcription_failed", async () => {
    mode = "500";
    await expect(provider().transcribe({ meetingId: "m", language: null, vexaSegments, fetchAudio: audio })).rejects.toMatchObject({ code: "provider_unavailable" });
    mode = "401";
    await expect(provider().transcribe({ meetingId: "m", language: null, vexaSegments, fetchAudio: audio })).rejects.toMatchObject({ code: "transcription_failed" });
  });
});

test("provider selection by env", () => {
  expect(createTranscriptionProvider({ transcriptionProvider: "vexa", tinfoil: { baseUrl: "", apiKey: "", model: "", segmentation: "turns" } }).name).toBe("vexa");
  expect(createTranscriptionProvider({ transcriptionProvider: "tinfoil", tinfoil: { baseUrl: "x", apiKey: "", model: "m", segmentation: "whole" } }).name).toBe("tinfoil");
});
