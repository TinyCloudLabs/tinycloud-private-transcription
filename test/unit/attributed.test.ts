import { expect, test } from "bun:test";
import { attributedBatches, transcribeAttributedManifest, type AttributedManifest } from "../../src/providers/transcription/attributed.ts";
import { createHash } from "node:crypto";

const bytesFor = (start: number, end: number, voiced = true) => {
  const pcm = new Float32Array((end - start) * 16);
  if (voiced) pcm.fill(.1);
  return new Uint8Array(pcm.buffer);
};
const range = (sequence: number, speaker_key: string, speaker_name: string, start_ms: number, end_ms: number, source: "glow-bound" | "provisional" = "glow-bound", voiced = true) => {
  const bytes = bytesFor(start_ms, end_ms, voiced);
  return { version: 1 as const, meeting_id: "m", sequence, idempotency_key: `r${sequence}`, speaker_key, speaker_name,
    attribution: { source, confidence: source === "glow-bound" ? .9 : 0 }, start_ms, end_ms, codec: "pcm_f32le" as const,
    sample_rate: 16000, channels: 1 as const, channel: 0, turn_generation: 0, audio_duration_ms: end_ms - start_ms, byte_count: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
    state: "uploaded" as const, path: `/attributed-audio/m/${sequence}`, bytes };
};
const manifest = (ranges: ReturnType<typeof range>[], state: "open" | "closed" = "closed"): AttributedManifest =>
  ({ version: 1, meeting_id: "m", state, clock_origin: "meeting_start", clock_origin_ms: 0, capabilities: { attributed_audio_enabled: true }, ranges });
test("closed evidence batches contiguous named speakers and maps text without diarization", async () => {
  const a = range(0, "a", "Alice", 0, 3000), b = range(1, "a", "Alice", 3000, 6000), c = range(2, "b", "Bob", 6000, 9000);
  const input = manifest([a, b, c]);
  expect(attributedBatches(input)).toHaveLength(2);
  const transcript = await transcribeAttributedManifest(input, async item => ({ 0: a, 1: b, 2: c }[item.sequence]!.bytes), async (_pcm, batch) => ({ text: batch.speaker_name === "Alice" ? "hello" : "world" }), "en");
  expect(transcript.segments.map((s) => s.speaker_name)).toEqual(["Alice", "Bob"]);
});
test("short voiced evidence is retained, silence avoids a paid call, and provisional stays provisional", async () => {
  const short = range(0, "a", "Alice", 0, 1000);
  const provisional = range(1, "p", "Maybe Alice", 1000, 2000, "provisional");
  const silent = range(2, "b", "Bob", 2000, 3000, "glow-bound", false);
  const input = manifest([short, provisional, silent]);
  let calls = 0;
  const transcript = await transcribeAttributedManifest(input, async item => ({ 0: short, 1: provisional, 2: silent }[item.sequence]!.bytes), async (_pcm, batch) => { calls++; return { text: batch.speaker_name }; }, "en");
  expect(calls).toBe(2);
  expect(transcript.segments.map(s => s.attribution)).toEqual(["identified", "provisional"]);
});
test("open, failed, absolute, and oversized evidence are rejected before fetch", () => {
  const one = range(0, "a", "Alice", 0, 1000);
  expect(() => attributedBatches(manifest([], "open"))).toThrow();
  expect(attributedBatches(manifest([({ ...one, state: "failed", path: undefined } as unknown as typeof one)]) )).toEqual([]);
  expect(() => attributedBatches(manifest([{ ...one, path: "s3://bucket/x" }]))).toThrow();
  expect(() => attributedBatches(manifest([range(0, "a", "Alice", 0, 121000)]))).toThrow();
});
