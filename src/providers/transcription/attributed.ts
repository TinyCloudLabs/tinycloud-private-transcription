import { createHash } from "node:crypto";
import { ApiError } from "../../domain/errors.ts";
import { normalizeSegments, type NormalizedTranscript } from "../../domain/transcript.ts";

export interface AttributedRange {
  version: 1; meeting_id: string; sequence: number; idempotency_key: string;
  speaker_key: string; speaker_name: string;
  attribution: { source: "glow-bound" | "provisional"; confidence: number };
  start_ms: number; end_ms: number; codec: "pcm_f32le"; sample_rate: number; channels: 1;
  byte_count: number; sha256: string; state: "sealed" | "uploaded" | "failed"; url?: string;
}
export interface AttributedManifest { version: 1; meeting_id: string; state: "open" | "closed"; ranges: AttributedRange[]; }
export interface AttributedBatch { idempotency_key: string; speaker_key: string; speaker_name: string; start_ms: number; end_ms: number; ranges: AttributedRange[]; }

const MIN_SECONDS = 2;
const TARGET_SECONDS = 90;
const MAX_SECONDS = 120;

/** Batch only adjacent, single-speaker evidence.  No fallback mixes speakers or invents a label. */
export function attributedBatches(manifest: AttributedManifest): AttributedBatch[] {
  if (manifest.state !== "closed") throw new ApiError("transcription_failed", "Attributed audio manifest is still open");
  const ranges = [...manifest.ranges].sort((a, b) => a.sequence - b.sequence);
  if (ranges.some((r, i) => r.meeting_id !== manifest.meeting_id || r.sequence !== i || r.state !== "uploaded" || !r.url || r.end_ms < r.start_ms)) {
    throw new ApiError("transcription_failed", "Attributed audio manifest has unresolved or unordered ranges");
  }
  const batches: AttributedBatch[] = [];
  let current: AttributedRange[] = [];
  const flush = () => {
    if (!current.length) return;
    const start = current[0]!.start_ms, end = current.at(-1)!.end_ms;
    if (end - start >= MIN_SECONDS * 1000) batches.push({ idempotency_key: current.map((r) => r.idempotency_key).join(","), speaker_key: current[0]!.speaker_key, speaker_name: current[0]!.speaker_name, start_ms: start, end_ms: end, ranges: current });
    current = [];
  };
  for (const range of ranges) {
    const start = current[0]?.start_ms ?? range.start_ms;
    const compatible = current.length && current[0]!.speaker_key === range.speaker_key && current.at(-1)!.end_ms === range.start_ms && range.end_ms - start <= MAX_SECONDS * 1000;
    if (current.length && !compatible) flush();
    current.push(range);
    if (range.end_ms - (current[0]?.start_ms ?? range.start_ms) >= TARGET_SECONDS * 1000) flush();
  }
  flush();
  return batches;
}

export async function transcribeAttributedManifest(
  manifest: AttributedManifest,
  read: (range: AttributedRange) => Promise<Uint8Array>,
  textOnly: (pcm: Uint8Array, batch: AttributedBatch) => Promise<{ text: string; language?: string }>,
  language: string | null,
): Promise<NormalizedTranscript> {
  const batches = attributedBatches(manifest);
  const raw = [];
  for (const batch of batches) {
    const parts = await Promise.all(batch.ranges.map(async (range) => {
      const bytes = await read(range);
      if (bytes.byteLength !== range.byte_count || createHash("sha256").update(bytes).digest("hex") !== range.sha256) throw new ApiError("transcription_failed", "Attributed audio integrity check failed");
      return bytes;
    }));
    const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
    if (!size) continue;
    const pcm = new Uint8Array(size); let offset = 0;
    for (const part of parts) { pcm.set(part, offset); offset += part.byteLength; }
    const response = await textOnly(pcm, batch);
    if (response.text.trim()) raw.push({ start: batch.start_ms / 1000, end: batch.end_ms / 1000, text: response.text, speaker: batch.speaker_name, speakerKey: batch.speaker_key, attribution: "identified" as const, language: response.language ?? null });
  }
  const transcript = normalizeSegments(raw, language);
  if (!transcript.text.trim()) throw new ApiError("transcription_failed", "No substantive attributed audio was transcribed");
  return transcript;
}
