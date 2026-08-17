import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { VexaNativeProvider } from "../../src/providers/transcription/vexa-native.ts";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { createTranscriptionProvider } from "../../src/providers/transcription/index.ts";
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
  let mode: "ok" | "500" | "401" = "ok";

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
        return Response.json(fixture);
      },
    });
  });
  afterAll(() => server.stop(true));

  const provider = () =>
    new TinfoilTranscriptionProvider({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "tk_test", model: "voxtral-small-24b" });
  const audio = async () => ({ bytes: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]), filename: "meeting.wav", contentType: "audio/wav" });

  test("posts multipart audio and normalizes verbose_json with speaker attribution", async () => {
    mode = "ok";
    const t = await provider().transcribe({ meetingId: "mtg_x", language: "en", vexaSegments, fetchAudio: audio });
    expect(lastRequest).toEqual({ auth: "Bearer tk_test", model: "voxtral-small-24b", format: "verbose_json", fileName: "meeting.wav", fileSize: 8 });
    expect(t.language).toBe("en");
    expect(t.duration_seconds).toBe(6.4);
    expect(t.segments.map((s) => s.speaker_name)).toEqual(["Sam", "Bob"]);
    expect(t.text).toBe("Sam: Hello, this is a test of the private transcription pipeline.\nBob: Sounds good to me.");
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
  expect(createTranscriptionProvider({ transcriptionProvider: "vexa", tinfoil: { baseUrl: "", apiKey: "", model: "" } }).name).toBe("vexa");
  expect(createTranscriptionProvider({ transcriptionProvider: "tinfoil", tinfoil: { baseUrl: "x", apiKey: "", model: "m" } }).name).toBe("tinfoil");
});
