import { expect, test } from "bun:test";
import { attributedBatches, readAttributedBatch, transcribeAttributedManifest, type AttributedManifest } from "../../src/providers/transcription/attributed.ts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import golden from "../fixtures/vexa-attributed-audio-v1-manifest.closed.json";
import numericGolden from "../fixtures/vexa-attributed-audio-v1-manifest.numeric.closed.json";

test("keeps the cross-repo Vexa attributed-audio.v1 producer artifact byte-exact", async () => {
  const bytes = await readFile(new URL("../fixtures/vexa-attributed-audio-v1-manifest.closed.json", import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("5f11706d8b54911515d0a95bd1f741815ad8ac6ef17ea6470f3a4ebd95e40d14");
  expect(golden).toMatchObject({ meeting_id: "meeting-1", clock_origin: "first_admitted_capture_epoch_ms", state: "closed" });
});

test("uses a separate numeric fixture for runtime Vexa meeting-id binding", () => {
  expect(attributedBatches(numericGolden as AttributedManifest, 1)).toHaveLength(1);
});

const bytesFor = (start: number, end: number, voiced = true) => {
  const pcm = new Float32Array((end - start) * 16);
  if (voiced) pcm.fill(.1);
  return new Uint8Array(pcm.buffer);
};
const range = (sequence: number, speaker_key: string, speaker_name: string, start_ms: number, end_ms: number, source: "glow-bound" | "provisional" = "glow-bound", voiced = true) => {
  const bytes = bytesFor(start_ms, end_ms, voiced);
  return { version: 1 as const, meeting_id: "m", sequence, idempotency_key: `r${sequence}`, speaker_key, speaker_name,
    attribution: { source, confidence: source === "glow-bound" ? .9 : 0 }, start_ms, end_ms, codec: "pcm_f32le" as const,
    sample_rate: 16000, channels: 1 as const, channel: 0, turn_generation: 1, clock_origin_ms: 0, audio_duration_ms: end_ms - start_ms, byte_count: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
    state: "uploaded" as const, path: `/meetings/1/attributed-audio/ranges/${sequence}`, bytes };
};
const manifest = (ranges: ReturnType<typeof range>[], state: "open" | "closed" = "closed"): AttributedManifest =>
  ({ version: 1, meeting_id: "1", state, clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, ranges: ranges.map(({ bytes: _bytes, ...range }) => ({ ...range, meeting_id: "1" })) });
test("closed evidence batches contiguous named speakers and maps text without diarization", async () => {
  const a = range(0, "a", "Alice", 0, 3000), b = range(1, "a", "Alice", 3000, 6000), c = range(2, "b", "Bob", 6000, 9000);
  const input = manifest([a, b, c]);
  expect(attributedBatches(input, 1)).toHaveLength(2);
  const transcript = await transcribeAttributedManifest(input, async item => ({ 0: a, 1: b, 2: c }[item.sequence]!.bytes), async (_pcm, batch) => ({ text: batch.speaker_name === "Alice" ? "hello" : "world" }), "en", 1);
  expect(transcript.segments.map((s) => s.speaker_name)).toEqual(["Alice", "Bob"]);
});
test("short voiced evidence is retained, silence avoids a paid call, and provisional stays provisional", async () => {
  const short = range(0, "a", "Alice", 0, 1000);
  const provisional = range(1, "p", "Maybe Alice", 1000, 2000, "provisional");
  const silent = range(2, "b", "Bob", 2000, 3000, "glow-bound", false);
  const input = manifest([short, provisional, silent]);
  let calls = 0;
  const transcript = await transcribeAttributedManifest(input, async item => ({ 0: short, 1: provisional, 2: silent }[item.sequence]!.bytes), async (_pcm, batch) => { calls++; return { text: batch.speaker_name }; }, "en", 1);
  expect(calls).toBe(2);
  expect(transcript.segments.map(s => s.attribution)).toEqual(["identified", "provisional"]);
});
test("interleaved speakers accumulate independent chronological 90-second timelines", () => {
  const a0 = range(0, "a", "Alice", 0, 45_000);
  const b = range(1, "b", "Bob", 45_000, 50_000);
  const a1 = range(2, "a", "Alice", 50_000, 95_000);
  const batches = attributedBatches(manifest([a0, b, a1]), 1);
  expect(batches.map((batch) => [batch.speaker_name, batch.ranges.map((item) => item.sequence)])).toEqual([["Alice", [0, 2]], ["Bob", [1]]]);
});
test("open, failed, absolute, and oversized evidence are rejected before fetch", () => {
  const one = range(0, "a", "Alice", 0, 1000);
  expect(() => attributedBatches(manifest([], "open"), 1)).toThrow();
  expect(attributedBatches(manifest([({ ...one, state: "failed", path: undefined } as unknown as typeof one)]), 1)).toEqual([]);
  expect(() => attributedBatches(manifest([{ ...one, path: "s3://bucket/x" }]), 1)).toThrow();
  expect(() => attributedBatches(manifest([range(0, "a", "Alice", 0, 120000)]), 1)).toThrow();
});

test("requires the exact numeric Vexa meeting identity even for empty evidence", () => {
  expect(() => attributedBatches({ ...manifest([]), meeting_id: "2" }, 1)).toThrow();
  const one = range(0, "a", "Alice", 0, 1_000);
  expect(() => attributedBatches({ ...manifest([one]), meeting_id: "2" }, 1)).toThrow();
});

test("rejects extra, secret-shaped, and oversized producer fields before they can be staged", () => {
  const one = range(0, "alice", "Alice", 0, 1000);
  expect(() => attributedBatches(manifest([{ ...one, idempotency_key: "https://private.example/PRIVATE_TRANSCRIPT" }]), 1)).toThrow();
  expect(() => attributedBatches(manifest([{ ...one, idempotency_key: "x".repeat(257) }]), 1)).toThrow();
  expect(() => attributedBatches(manifest([{ ...one, provider_debug: "credential=do-not-store" } as any]), 1)).toThrow();
});

test("accepts bounded international speaker names but rejects unsafe names and extreme timelines", () => {
  const one = range(0, "jose", "José", 0, 1_000);
  expect(attributedBatches(manifest([one]), 1)[0]!.speaker_name).toBe("José");
  for (const speaker_name of ["https://private.example", "Bearer token", "Alice\nBob"]) {
    expect(() => attributedBatches(manifest([{ ...one, speaker_name }]), 1)).toThrow();
  }
  expect(() => attributedBatches(manifest([{ ...one, start_ms: 1e300, end_ms: 1e300, audio_duration_ms: 0, byte_count: 0 }]), 1)).toThrow();
});

test("checksum-valid non-finite PCM is rejected before silence classification", async () => {
  const bytes = new Uint8Array(new Float32Array([Number.NaN, 0]).buffer);
  const corrupted = { ...range(0, "a", "Alice", 0, 1), byte_count: bytes.byteLength, audio_duration_ms: .125,
    sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
  const batch = attributedBatches(manifest([corrupted]), 1)[0]!;
  await expect(readAttributedBatch(batch, async () => bytes)).rejects.toThrow();
});

test("rejects exact 120-second sample durations and splits exact batch wall spans", () => {
  const one = range(0, "a", "Alice", 0, 1_000);
  expect(() => attributedBatches(manifest([{ ...one, audio_duration_ms: 120_000 }]), 1)).toThrow();
  const left = range(0, "a", "Alice", 0, 60_000), right = range(1, "a", "Alice", 60_000, 120_000);
  const batches = attributedBatches(manifest([left, right]), 1);
  expect(batches).toHaveLength(2);
  expect(batches.every((batch) => batch.end_ms - batch.start_ms < 120_000)).toBe(true);
});
