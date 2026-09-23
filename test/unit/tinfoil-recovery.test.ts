import { describe, expect, test } from "bun:test";
import { PCM_RATE, pcmToWav } from "../../src/providers/transcription/audio.ts";
import { quietBoundedChunks, safeTinfoilLanguage, TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";

const toneWav = (seconds: number) => pcmToWav(new Int16Array(Math.round(PCM_RATE * seconds)).fill(2_000), PCM_RATE);
const input = (bytes: Uint8Array) => ({
  meetingId: "mtg_recovery",
  language: "en",
  vexaSegments: [{ start: 0, end: 1, text: "Vexa words", language: "en", speaker: "Alice" }],
  fetchAudio: async () => ({ bytes, filename: "meeting.webm", contentType: "audio/webm" }),
});

describe("whole-recording Tinfoil recovery", () => {
  test("drops provider language metadata that is not a bounded language identifier", () => {
    expect(safeTinfoilLanguage("pt-BR")).toBe("pt-BR");
    for (const value of ["https://private.example/token", "Bearer secret", "x".repeat(36), { language: "en" }]) {
      expect(safeTinfoilLanguage(value)).toBeUndefined();
    }
  });
  test("plans an hour as contiguous bounded chunks ending at 3600 seconds", () => {
    const chunks = quietBoundedChunks({ samples: new Int16Array(3_600).fill(1), sampleRate: 1, durationSec: 3_600 }, 600);
    expect(chunks.length).toBeGreaterThanOrEqual(6);
    expect(chunks.length).toBeLessThanOrEqual(7);
    expect(chunks[0]!.from).toBe(0);
    expect(chunks.at(-1)!.to).toBe(3_600);
    expect(chunks.every((chunk, index) => chunk.to - chunk.from <= 600 && (index === 0 || chunk.from === chunks[index - 1]!.to))).toBe(true);
  });

  test("sends scaled long audio as ordered chunks and exposes only Unknown attribution", async () => {
    const names: string[] = [];
    let active = 0;
    let maxActive = 0;
    const provider = new TinfoilTranscriptionProvider({
      baseUrl: "https://tinfoil.test",
      apiKey: "test",
      model: "voxtral-small-24b",
      wholeChunkSec: 2,
      fetch: (async (_url: string, init: RequestInit) => {
        const file = (init.body as FormData).get("file") as File;
        names.push(file.name);
        active++;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(5);
        active--;
        return Response.json({ text: `text ${file.name}`, language: "en" });
      }) as typeof fetch,
    });
    const transcript = await provider.transcribe(input(toneWav(12)));
    expect(names.length).toBeGreaterThanOrEqual(6);
    expect(names.length).toBeLessThanOrEqual(7);
    expect(maxActive).toBe(2);
    expect(transcript.segments.map((segment) => segment.text)).toEqual(names.map((name) => `text ${name}`));
    expect(transcript.speakers).toEqual([{ id: "speaker_0", name: "Unknown" }]);
    expect(transcript.segments.every((segment) => segment.speaker_name === "Unknown" && segment.attribution === "unknown")).toBe(true);
    expect(transcript.duration_seconds).toBe(12);
  });

  test("silent and undecodable recordings make no paid call", async () => {
    let calls = 0;
    const provider = new TinfoilTranscriptionProvider({
      baseUrl: "https://tinfoil.test",
      apiKey: "test",
      model: "voxtral-small-24b",
      fetch: (async () => { calls++; return Response.json({ text: "unexpected" }); }) as unknown as typeof fetch,
    });
    await expect(provider.transcribe(input(pcmToWav(new Int16Array(PCM_RATE), PCM_RATE)))).rejects.toMatchObject({ code: "transcription_failed" });
    await expect(provider.transcribe(input(new Uint8Array([1, 2, 3])))).rejects.toMatchObject({ code: "transcription_failed" });
    expect(calls).toBe(0);
  });

  test.each([
    ["malformed JSON", new Response("not-json", { status: 200 })],
    ["missing text", Response.json({ language: "en" })],
  ])("%s fails instead of storing a partial transcript", async (_label, response) => {
    const provider = new TinfoilTranscriptionProvider({
      baseUrl: "https://tinfoil.test",
      apiKey: "test",
      model: "voxtral-small-24b",
      fetch: (async () => response.clone()) as unknown as typeof fetch,
    });
    await expect(provider.transcribe(input(toneWav(1)))).rejects.toMatchObject({ code: "transcription_failed" });
  });

  test("a middle-chunk failure stops later waves and returns no partial transcript", async () => {
    const names: string[] = [];
    const provider = new TinfoilTranscriptionProvider({
      baseUrl: "https://tinfoil.test",
      apiKey: "test",
      model: "voxtral-small-24b",
      wholeChunkSec: 2,
      maxRetries: 0,
      fetch: (async (_url: string, init: RequestInit) => {
        const file = (init.body as FormData).get("file") as File;
        names.push(file.name);
        return file.name === "chunk-3.wav" ? new Response("bad", { status: 400 }) : Response.json({ text: file.name });
      }) as typeof fetch,
    });
    await expect(provider.transcribe(input(toneWav(12)))).rejects.toMatchObject({ code: "transcription_failed" });
    expect(names).toEqual(["chunk-1.wav", "chunk-2.wav", "chunk-3.wav", "chunk-4.wav"]);
  });

  test.each([
    ["429", () => new Response("busy", { status: 429 })],
    ["5xx", () => new Response("down", { status: 503 })],
    ["network error", () => { throw new TypeError("network unavailable"); }],
    ["timeout", () => { const error = new Error("timed out"); error.name = "TimeoutError"; throw error; }],
  ])("retries a transient %s once and then succeeds", async (_label, fail) => {
    let calls = 0;
    const provider = new TinfoilTranscriptionProvider({
      baseUrl: "https://tinfoil.test",
      apiKey: "test",
      model: "voxtral-small-24b",
      maxRetries: 1,
      retryDelayMs: 0,
      fetch: (async () => ++calls === 1 ? fail() : Response.json({ text: "Recovered" })) as unknown as typeof fetch,
    });
    expect((await provider.transcribe(input(toneWav(1)))).text).toBe("Unknown: Recovered");
    expect(calls).toBe(2);
  });
});
