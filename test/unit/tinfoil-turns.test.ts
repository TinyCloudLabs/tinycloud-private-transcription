/**
 * Tinfoil per-turn mode against a mock OpenAI-compatible server: a synthetic two-speaker recording
 * (fixtures/alice.wav followed by fixtures/bob.wav) is cut per Vexa speaker turn and each clip is posted
 * separately; the mock answers with the clip's duration so we can check the cuts. Needs ffmpeg on PATH
 * (the provider decodes the recording with it) — skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { decodeToPcm, pcmToWav, rmsDbfs, sliceToWav, PCM_RATE } from "../../src/providers/transcription/audio.ts";
import { mergeTurns } from "../../src/providers/transcription/turns.ts";
import { quietBoundedChunks, TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { TranscriptionFallbackError } from "../../src/providers/transcription/types.ts";

const ffmpeg = Bun.which("ffmpeg");

describe("mergeTurns", () => {
  test("merges adjacent same-speaker segments within the gap, keeps speaker changes and long gaps apart", () => {
    const turns = mergeTurns([
      { start: 6.5, end: 8.1, text: "Hello from Alice.", language: "en", speaker: "Alice" },
      { start: 1.5, end: 6.0, text: "The quick brown fox jumps over the lazy dog.", language: "en", speaker: "Alice" },
      { start: 12.65, end: 14.4, text: "Good morning everyone, this is Bob.", language: "en", speaker: "Bob" },
      { start: 14.9, end: 18.5, text: "The meeting starts now.", language: "en", speaker: "Bob" },
      { start: 19.5, end: 20.0, text: "Right.", language: "en", speaker: "Bob" }, // gap 1.0 > 0.75 → new turn
      { start: 20.0, end: 20.2, text: "draft", language: "en", speaker: "Alice", completed: false },
    ]);
    expect(turns).toEqual([
      { speaker: "Alice", start: 1.5, end: 8.1, vexaText: "The quick brown fox jumps over the lazy dog. Hello from Alice.", language: "en" },
      { speaker: "Bob", start: 12.65, end: 18.5, vexaText: "Good morning everyone, this is Bob. The meeting starts now.", language: "en" },
      { speaker: "Bob", start: 19.5, end: 20, vexaText: "Right.", language: "en" },
    ]);
  });
  test("unknown speakers merge with each other only", () => {
    const turns = mergeTurns([
      { start: 0, end: 1, text: "a", language: null, speaker: null },
      { start: 1.2, end: 2, text: "b", language: null, speaker: "" },
      { start: 2.1, end: 3, text: "c", language: null, speaker: "Sam" },
    ]);
    expect(turns.map((t) => [t.speaker, t.start, t.end])).toEqual([[null, 0, 2], ["Sam", 2.1, 3]]);
  });
});

describe("audio helpers", () => {
  test("pcmToWav/sliceToWav produce a canonical 16-bit mono WAV of the requested window", () => {
    const samples = new Int16Array(PCM_RATE * 2).fill(1000); // 2 s
    const wav = sliceToWav({ samples, sampleRate: PCM_RATE, durationSec: 2 }, 0.5, 1.0);
    expect(wav.length).toBe(44 + PCM_RATE * 0.5 * 2);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(PCM_RATE);
    expect(rmsDbfs({ samples: new Int16Array(100), sampleRate: PCM_RATE, durationSec: 0 })).toBe(-Infinity);
    expect(pcmToWav(new Int16Array(0), PCM_RATE).length).toBe(44);
  });

  test("whole-file chunk boundaries move to nearby low-energy audio without exceeding the limit", () => {
    const samples = new Int16Array(PCM_RATE * 12).fill(2000);
    samples.fill(0, Math.floor(3.9 * PCM_RATE), Math.floor(4.1 * PCM_RATE));
    const chunks = quietBoundedChunks({ samples, sampleRate: PCM_RATE, durationSec: 12 }, 5);
    expect(chunks[0]!.to).toBeGreaterThan(3.9);
    expect(chunks[0]!.to).toBeLessThan(4.1);
    expect(chunks.every((chunk) => chunk.to - chunk.from <= 5)).toBe(true);
    expect(chunks[0]!.from).toBe(0);
    expect(chunks.at(-1)!.to).toBe(12);
  });
});

describe.skipIf(!ffmpeg || !existsSync("fixtures/bob.wav"))("TinfoilTranscriptionProvider per-turn mode (mock server, synthetic 2-speaker WAV)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let recording: Uint8Array; // alice.wav ++ bob.wav, 16 kHz mono
  let aliceSec = 0;
  const requests: { name: string; seconds: number; dbfs: number; language: string | null }[] = [];
  let failNames: RegExp | null = null; // requests whose file name matches fail with 500
  let failStatus = 500;
  let flakyOnce = new Set<string>(); // first attempt for these names → 500, then ok

  const ALICE_TEXT = "The quick brown fox jumps over the lazy dog. Hello from Alice.";
  const vexaSegments = (bobStart: number) => [
    { start: 1.5, end: 6.0, text: "The quick brown fox jumps over the lazy dog.", language: "en", speaker: "Alice", completed: true },
    { start: 6.5, end: 8.1, text: "Hello from Alice.", language: "en", speaker: "Alice", completed: true },
    { start: bobStart + 1.5, end: bobStart + 3.25, text: "Good morning everyone, this is Bob.", language: "en", speaker: "Bob", completed: true },
    { start: bobStart + 3.75, end: bobStart + 7.35, text: "The meeting starts now.", language: "en", speaker: "Bob", completed: true },
    { start: bobStart + 9.0, end: bobStart + 9.2, text: "uh", language: "en", speaker: "Alice", completed: true }, // < 0.4 s → skipped
  ];

  beforeAll(async () => {
    const a = await decodeToPcm(new Uint8Array(await Bun.file("fixtures/alice.wav").arrayBuffer()));
    const b = await decodeToPcm(new Uint8Array(await Bun.file("fixtures/bob.wav").arrayBuffer()));
    aliceSec = a.durationSec;
    const joined = new Int16Array(a.samples.length + b.samples.length);
    joined.set(a.samples, 0);
    joined.set(b.samples, a.samples.length);
    recording = pcmToWav(joined, PCM_RATE);
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const form = await req.formData();
        const file = form.get("file") as File;
        const name = file.name;
        const pcm = await decodeToPcm(new Uint8Array(await file.arrayBuffer()));
        requests.push({ name, seconds: Math.round(pcm.durationSec * 100) / 100, dbfs: Math.round(rmsDbfs(pcm)), language: form.get("language") as string | null });
        if (flakyOnce.has(name)) { flakyOnce.delete(name); return new Response("flake", { status: 500 }); }
        if (failNames?.test(name)) return new Response("boom", { status: failStatus });
        return Response.json({ text: `clip ${pcm.durationSec.toFixed(2)}s`, usage: { type: "duration", seconds: pcm.durationSec } });
      },
    });
  });
  afterAll(() => server.stop(true));

  const provider = (extra: Partial<ConstructorParameters<typeof TinfoilTranscriptionProvider>[0]> = {}) =>
    new TinfoilTranscriptionProvider({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "tk_test", model: "voxtral-small-24b", ...extra });
  const input = (segments = vexaSegments(aliceSec)) => ({
    meetingId: "mtg_turns",
    language: "en",
    vexaSegments: segments,
    fetchAudio: async () => ({ bytes: recording, filename: "meeting.wav", contentType: "audio/wav" }),
  });

  test("cuts one clip per merged speaker turn, keeps speaker/timing from Vexa, text from Tinfoil, duration from audio", async () => {
    requests.length = 0;
    const p = provider();
    const t = await p.transcribe(input());
    // 2 turns transcribed (Alice, Bob); the 0.2 s "uh" is skipped; one call each.
    expect(requests).toHaveLength(2);
    expect(p.calls).toBe(2);
    expect(p.lastStats).toMatchObject({ mode: "turns", turns: 3, transcribed: 2, skipped_short: 1, failed: 0, calls: 2 });
    for (const r of requests) {
      expect(r.language).toBe("en");
      expect(r.dbfs).toBeGreaterThan(-45); // clips contain speech, not silence
    }
    expect(t.speakers.map((s) => s.name)).toEqual(["Alice", "Bob"]);
    expect(t.segments).toHaveLength(2);
    // Alice turn 1.5–8.1 (+0.25 s pad each side = 7.1 s clip); Bob turn 1.5–7.35 rel (+pad = 6.35 s clip).
    expect(t.segments[0]).toMatchObject({ speaker_name: "Alice", start: 1.5, end: 8.1, text: "clip 7.10s" });
    expect(t.segments[1]).toMatchObject({ speaker_name: "Bob", start: Math.round((aliceSec + 1.5) * 1000) / 1000, end: Math.round((aliceSec + 7.35) * 1000) / 1000, text: "clip 6.35s" });
    expect(t.text).toBe("Alice: clip 7.10s\nBob: clip 6.35s");
    expect(t.duration_seconds).toBeGreaterThan(21); // whole recording (~21.6 s), not the last turn end
    expect(t.language).toBe("en");
  });

  test("retries a transient 5xx per turn (backoff) and counts every call", async () => {
    requests.length = 0;
    flakyOnce = new Set(["turn-2.wav"]);
    const p = provider({ maxRetries: 2 });
    const t = await p.transcribe(input());
    expect(t.segments).toHaveLength(2);
    expect(p.calls).toBe(3);
    expect(p.lastStats).toMatchObject({ transcribed: 2, failed: 0, calls: 3 });
  });

  test("a minority of failed turns keeps Vexa's words for those turns (4xx is not retried)", async () => {
    requests.length = 0;
    failNames = /turn-2/;
    failStatus = 400;
    const p = provider();
    const t = await p.transcribe(input());
    failNames = null;
    expect(requests).toHaveLength(2);
    expect(p.lastStats).toMatchObject({ transcribed: 1, failed: 1, calls: 2 });
    expect(t.segments.map((s) => s.text)).toEqual(["clip 7.10s", "Good morning everyone, this is Bob. The meeting starts now."]);
  });

  test("more than half of the turns failing → TranscriptionFallbackError (worker stores the Vexa transcript)", async () => {
    // Three turns: Alice, Bob, and Alice again (make the trailing "uh" a real 1 s turn); Bob + trailing fail.
    const segs = vexaSegments(aliceSec);
    segs[4] = { ...segs[4]!, end: segs[4]!.start + 1 };
    failNames = /turn-(2|3)/;
    failStatus = 400;
    const p = provider();
    const err = await p.transcribe(input(segs)).catch((e) => e);
    failNames = null;
    expect(err).toBeInstanceOf(TranscriptionFallbackError);
    expect(err.reason).toBe("turns_failed");
    expect(p.lastStats).toMatchObject({ turns: 3, transcribed: 1, failed: 2 });
  });

  test("every turn hitting an outage (5xx after retries) → provider_unavailable (worker retries later)", async () => {
    failNames = /./;
    failStatus = 503;
    const p = provider({ maxRetries: 1 });
    await expect(p.transcribe(input())).rejects.toMatchObject({ code: "provider_unavailable" });
    failNames = null;
    expect(p.lastStats).toMatchObject({ failed: 2, calls: 4 });
  });

  test("silent recording → TranscriptionFallbackError(silent_recording), no Tinfoil call", async () => {
    requests.length = 0;
    const silent = pcmToWav(new Int16Array(PCM_RATE * 5), PCM_RATE);
    const p = provider();
    const err = await p.transcribe({ ...input(), fetchAudio: async () => ({ bytes: silent, filename: "m.wav", contentType: "audio/wav" }) }).catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptionFallbackError);
    expect(err.reason).toBe("silent_recording");
    expect(requests).toHaveLength(0);
    expect(p.calls).toBe(0);
  });

  test("undecodable bytes → TranscriptionFallbackError(undecodable)", async () => {
    const p = provider();
    const err = await p.transcribe({ ...input(), fetchAudio: async () => ({ bytes: new Uint8Array([1, 2, 3, 4]), filename: "m.webm", contentType: "audio/webm" }) }).catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptionFallbackError);
    expect(err.reason).toBe("undecodable");
  });

  test("segmentation=whole sends the recording once and attributes it to the dominant speaker", async () => {
    requests.length = 0;
    const p = provider({ segmentation: "whole" });
    const t = await p.transcribe(input());
    expect(requests).toHaveLength(1);
    expect(requests[0]!.name).toBe("meeting.wav");
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0]!.speaker_name).toBe("Alice");
    expect(p.lastStats?.mode).toBe("whole");
  });

  test("no Vexa segments at all → whole-file mode (nothing to cut by)", async () => {
    requests.length = 0;
    const p = provider();
    const t = await p.transcribe(input([]));
    expect(requests).toHaveLength(1);
    expect(t.segments[0]!.speaker_name).toBe("Unknown");
  });

  test("long whole-file transcription is split into bounded chunks without content holes", async () => {
    requests.length = 0;
    const p = provider({ segmentation: "whole", wholeChunkSec: 5, concurrency: 2 });
    const t = await p.transcribe(input([]));
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((r) => r.seconds <= 5.01)).toBe(true);
    expect(t.segments).toHaveLength(requests.length);
    expect(t.segments[0]!.start).toBe(0);
    expect(t.segments.at(-1)!.end).toBeCloseTo(t.duration_seconds, 2);
    expect(p.lastStats).toMatchObject({ mode: "whole", turns: requests.length, transcribed: requests.length, failed: 0 });
  });

  test("a failed whole-file chunk stops scheduling later paid requests", async () => {
    requests.length = 0;
    failNames = /chunk-1/;
    failStatus = 400;
    const p = provider({ segmentation: "whole", wholeChunkSec: 5, concurrency: 2 });
    await expect(p.transcribe(input([]))).rejects.toMatchObject({ code: "transcription_failed" });
    failNames = null;
    const requestsAtRejection = requests.length;
    await Bun.sleep(100);
    expect(requests).toHaveLength(requestsAtRejection);
  });
});
