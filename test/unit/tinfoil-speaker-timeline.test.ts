import { expect, test } from "bun:test";
import { pcmToWav, PCM_RATE } from "../../src/providers/transcription/audio.ts";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import type { SpeakerInterval } from "../../src/providers/transcription/speaker-timeline.ts";

function fixture(timeline: SpeakerInterval[], failAt = -1, responseAtFailure?: unknown) {
  const samples = Int16Array.from({ length: PCM_RATE * 3 }, (_, i) => (i % 8000) - 4000);
  const uploaded: Int16Array[] = [];
  const provider = new TinfoilTranscriptionProvider({
    baseUrl: "https://transcription.invalid", apiKey: "fixture", model: "fixture", concurrency: 1,
    fetch: (async (_url, opts) => {
      const file = (opts!.body as FormData).get("file") as File;
      const bytes = await file.arrayBuffer();
      uploaded.push(new Int16Array(bytes.slice(44)));
      if (uploaded.length === failAt) return responseAtFailure === undefined
        ? new Response("unavailable", { status: 503 }) : Response.json(responseAtFailure);
      return Response.json({ text: `words ${uploaded.length}`, usage: { seconds: (bytes.byteLength - 44) / 2 / PCM_RATE } });
    }) as typeof fetch,
  });
  const input = { meetingId: "synthetic", language: "en", vexaSegments: [],
    fetchAudio: async () => ({ bytes: pcmToWav(samples, PCM_RATE), filename: "test.wav", contentType: "audio/wav", speakerTimeline: timeline }) };
  return { provider, input, samples, uploaded };
}

test("Tinfoil receives every PCM sample exactly once including unknown gaps, overlap and short turns", async () => {
  const f = fixture([
    { start: 0.1, end: 1.1, participantId: "a", name: "Sam", attribution: "identified" },
    { start: 1, end: 1.2, participantId: "b", name: "Sam", attribution: "identified" },
    { start: 2, end: 3, participantId: "a", name: "Sam", attribution: "identified" },
  ]);
  const result = await f.provider.transcribe(f.input);
  expect(result.segments.map(s => s.attribution)).toEqual(["unknown", "identified", "overlap", "identified", "unknown", "identified"]);
  expect(result.segments[1]!.speaker_id).not.toBe(result.segments[3]!.speaker_id);
  expect(result.segments[1]!.speaker_id).toBe(result.segments[5]!.speaker_id);
  const received = new Int16Array(f.uploaded.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of f.uploaded) { received.set(a, offset); offset += a.length; }
  expect(Buffer.from(received.buffer).equals(Buffer.from(f.samples.buffer))).toBe(true);
  expect(f.provider.lastStats).toMatchObject({ mode: "timeline", skipped_short: 0, failed: 0 });
  expect(result.duration_seconds).toBe(3);
});

test("malformed timeline falls back to complete audio with explicit unknown attribution", async () => {
  const f = fixture([{ start: NaN, end: 1, participantId: "a", name: "Alice", attribution: "identified" }]);
  const result = await f.provider.transcribe(f.input);
  expect(f.uploaded).toHaveLength(1);
  expect(f.uploaded[0]!.length).toBe(f.samples.length);
  expect(result.segments[0]).toMatchObject({ speaker_name: "Unknown", attribution: "unknown", start: 0, end: 3 });
});

test("a failed timeline window cannot finalize an incomplete transcript or continue paid requests", async () => {
  const f = fixture([
    { start: 0, end: 1, participantId: "a", name: "Alice", attribution: "identified" },
    { start: 1, end: 2, participantId: "b", name: "Bob", attribution: "identified" },
  ], 2);
  await expect(f.provider.transcribe(f.input)).rejects.toMatchObject({ code: "provider_unavailable" });
  expect(f.uploaded).toHaveLength(2);
  expect(f.provider.lastStats).toBeNull();
});

test("HTTP success with missing transcription text cannot silently remove a speaker's words", async () => {
  const f = fixture([
    { start: 0, end: 1, participantId: "a", name: "Alice", attribution: "identified" },
    { start: 1, end: 2, participantId: "b", name: "Bob", attribution: "identified" },
  ], 2, { error: "synthetic malformed provider response" });
  await expect(f.provider.transcribe(f.input)).rejects.toMatchObject({ code: "transcription_failed" });
  expect(f.uploaded).toHaveLength(2);
  expect(f.provider.lastStats).toBeNull();
});

test("an explicit empty transcription remains valid for a window with no recognized speech", async () => {
  const f = fixture([
    { start: 0, end: 1, participantId: "a", name: "Alice", attribution: "identified" },
    { start: 1, end: 2, participantId: "b", name: "Bob", attribution: "identified" },
  ], 2, { text: "", usage: { seconds: 1 } });
  const result = await f.provider.transcribe(f.input);
  expect(f.uploaded).toHaveLength(3);
  expect(result.segments.map(s => s.text)).toEqual(["words 1", "words 3"]);
  expect(result.duration_seconds).toBe(3);
});
