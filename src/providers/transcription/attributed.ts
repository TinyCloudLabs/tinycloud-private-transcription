import { createHash } from "node:crypto";
import { ApiError } from "../../domain/errors.ts";
import { normalizeSegments, type NormalizedTranscript } from "../../domain/transcript.ts";

export interface AttributedRange {
  version: 1; meeting_id: string; sequence: number; idempotency_key: string;
  speaker_key: string; speaker_name: string;
  attribution: { source: "glow-bound" | "provisional"; confidence: number };
  /** Milliseconds relative to the capture-start clock in the manifest, never epoch time. */
  start_ms: number; end_ms: number; codec: "pcm_f32le"; sample_rate: number; channels: 1;
  byte_count: number; sha256: string; state: "sealed" | "uploaded" | "failed"; url?: string;
}
export interface AttributedManifest { version: 1; meeting_id: string; state: "open" | "closed"; ranges: AttributedRange[]; }
export interface AttributedBatch {
  idempotency_key: string; speaker_key: string; speaker_name: string;
  attribution: AttributedRange["attribution"]; start_ms: number; end_ms: number; ranges: AttributedRange[];
}

const TARGET_MS = 90_000;
const MAX_MS = 120_000;
const PCM_FLOAT_BYTES = 4;

const invalid = (message: string): never => { throw new ApiError("transcription_failed", message); };
const sameAttribution = (a: AttributedRange, b: AttributedRange) =>
  a.attribution.source === b.attribution.source && a.attribution.confidence === b.attribution.confidence;
const relativePath = (path: string | undefined) => typeof path === "string" && /^\/(?!\/)/.test(path);

/** Validate producer evidence before any fetch/allocation. This is the Vexa/PTX trust boundary. */
function validateRange(manifest: AttributedManifest, range: AttributedRange, sequence: number): void {
  const duration = range.end_ms - range.start_ms;
  const expectedBytes = duration * range.sample_rate * range.channels * PCM_FLOAT_BYTES / 1000;
  if (
    range.version !== 1 || range.meeting_id !== manifest.meeting_id || range.sequence !== sequence
    || !range.idempotency_key || !range.speaker_key || !range.speaker_name.trim()
    || !Number.isFinite(range.start_ms) || !Number.isFinite(range.end_ms) || range.start_ms < 0 || duration < 0
    || duration > MAX_MS || range.codec !== "pcm_f32le" || range.channels !== 1
    || !Number.isInteger(range.sample_rate) || range.sample_rate <= 0 || !Number.isSafeInteger(range.byte_count) || range.byte_count < 0
    || expectedBytes !== range.byte_count || !/^[a-f0-9]{64}$/i.test(range.sha256)
    || range.state !== "uploaded" || !relativePath(range.url)
    || !range.attribution || !Number.isFinite(range.attribution.confidence) || range.attribution.confidence < 0 || range.attribution.confidence > 1
  ) invalid("Attributed audio manifest contains invalid or non-relative evidence");
}

/** Batch only adjacent, single-speaker, homogeneous evidence. Oversized evidence is rejected before bytes are fetched. */
export function attributedBatches(manifest: AttributedManifest): AttributedBatch[] {
  if (manifest.version !== 1 || !manifest.meeting_id || manifest.state !== "closed") invalid("Attributed audio manifest is not a closed v1 manifest");
  const ranges = [...manifest.ranges].sort((a, b) => a.sequence - b.sequence);
  ranges.forEach((range, sequence) => validateRange(manifest, range, sequence));
  const batches: AttributedBatch[] = [];
  let current: AttributedRange[] = [];
  const flush = () => {
    if (!current.length) return;
    const first = current[0]!;
    batches.push({
      idempotency_key: current.map((range) => range.idempotency_key).join(","), speaker_key: first.speaker_key,
      speaker_name: first.speaker_name, attribution: first.attribution, start_ms: first.start_ms,
      end_ms: current.at(-1)!.end_ms, ranges: current,
    });
    current = [];
  };
  for (const range of ranges) {
    const first = current[0];
    const compatible = !!first && first.speaker_key === range.speaker_key && first.speaker_name === range.speaker_name
      && sameAttribution(first, range) && first.codec === range.codec && first.sample_rate === range.sample_rate
      && first.channels === range.channels && current.at(-1)!.end_ms === range.start_ms
      && range.end_ms - first.start_ms <= MAX_MS;
    if (current.length && !compatible) flush();
    current.push(range);
    if (range.end_ms - current[0]!.start_ms >= TARGET_MS) flush();
  }
  flush();
  return batches;
}

function silentPcm(bytes: Uint8Array): boolean {
  if (!bytes.byteLength) return true;
  const view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / PCM_FLOAT_BYTES);
  let energy = 0;
  for (const value of view) energy += value * value;
  return 20 * Math.log10(Math.sqrt(energy / view.length) || 0) < -60;
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
    const total = batch.ranges.reduce((sum, range) => sum + range.byte_count, 0);
    if (!Number.isSafeInteger(total)) invalid("Attributed batch exceeds memory ceiling");
    // One bounded destination, and one range at a time. Do not retain a Promise.all of range
    // downloads or construct a second whole-batch copy.
    const pcm = new Uint8Array(total);
    let offset = 0;
    for (const range of batch.ranges) {
      const bytes = await read(range);
      if (bytes.byteLength !== range.byte_count || createHash("sha256").update(bytes).digest("hex") !== range.sha256) {
        invalid("Attributed audio integrity check failed");
      }
      pcm.set(bytes, offset);
      offset += bytes.byteLength;
    }
    const response = silentPcm(pcm) ? { text: "" } : await textOnly(pcm, batch);
    if (response.text.trim()) raw.push({
      start: batch.start_ms / 1000, end: batch.end_ms / 1000, text: response.text,
      speaker: batch.speaker_name, speakerKey: batch.speaker_key,
      attribution: batch.attribution.source === "glow-bound" && batch.attribution.confidence > 0 ? "identified" as const : "provisional" as const,
      language: response.language ?? null,
    });
  }
  // A fully silent manifest is a successful, explicitly resolved transcript; it must not make a
  // caller pay Tinfoil or turn a completed meeting into an unbounded retry loop.
  return normalizeSegments(raw, language);
}
