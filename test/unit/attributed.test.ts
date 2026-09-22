import { expect, test } from "bun:test";
import { attributedBatches, transcribeAttributedManifest, type AttributedManifest } from "../../src/providers/transcription/attributed.ts";
import { createHash } from "node:crypto";
const bytes = new Uint8Array(32000); const hash = createHash("sha256").update(bytes).digest("hex");
const range = (sequence: number, speaker_key: string, speaker_name: string, start_ms: number, end_ms: number) => ({ version: 1 as const, meeting_id: "m", sequence, idempotency_key: `r${sequence}`, speaker_key, speaker_name, attribution: { source: "glow-bound" as const, confidence: .9 }, start_ms, end_ms, codec: "pcm_f32le" as const, sample_rate: 16000, channels: 1 as const, byte_count: bytes.byteLength, sha256: hash, state: "uploaded" as const, url: `/${sequence}` });
test("closed evidence batches contiguous named speakers and maps text without diarization", async () => {
  const manifest: AttributedManifest = { version: 1, meeting_id: "m", state: "closed", ranges: [range(0, "a", "Alice", 0, 3000), range(1, "a", "Alice", 3000, 6000), range(2, "b", "Bob", 6000, 9000)] };
  expect(attributedBatches(manifest)).toHaveLength(2);
  const transcript = await transcribeAttributedManifest(manifest, async () => bytes, async (_pcm, batch) => ({ text: batch.speaker_name === "Alice" ? "hello" : "world" }), "en");
  expect(transcript.segments.map((s) => s.speaker_name)).toEqual(["Alice", "Bob"]);
});
test("open, failed, and sub-two-second evidence cannot become canonical", () => {
  expect(() => attributedBatches({ version: 1, meeting_id: "m", state: "open", ranges: [] })).toThrow();
  expect(attributedBatches({ version: 1, meeting_id: "m", state: "closed", ranges: [range(0, "a", "Alice", 0, 1000)] })).toEqual([]);
});
