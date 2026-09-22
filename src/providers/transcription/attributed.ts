import { createHash } from "node:crypto";
import { ApiError } from "../../domain/errors.ts";
import { normalizeSegments, type NormalizedTranscript } from "../../domain/transcript.ts";

/** Exact attributed-audio.v1 producer shape (Vexa PR #10). */
export interface AttributedRange {
  version: 1; meeting_id: string; sequence: number; idempotency_key: string;
  speaker_key: string; speaker_name: string; channel: number; turn_generation: number;
  attribution: { source: "glow-bound" | "provisional" | "unresolved"; confidence: number };
  clock_origin_ms: number; start_ms: number; end_ms: number; audio_duration_ms: number;
  codec: "pcm_f32le"; sample_rate: number; channels: 1; byte_count: number; sha256: string;
  state: "sealed" | "uploaded" | "failed"; path?: string;
}
export interface AttributedManifest {
  version: 1; meeting_id: string; clock_origin: "first_admitted_capture_epoch_ms";
  clock_origin_ms: number; state: "open" | "closed"; ranges: AttributedRange[];
}
export interface AttributedCapability { requested_version: 1; supported_version: 1; status: "supported"; }
export interface AttributedBatch {
  idempotency_key: string; speaker_key: string; speaker_name: string;
  attribution: AttributedRange["attribution"]; start_ms: number; end_ms: number; ranges: AttributedRange[];
}

const TARGET_MS = 90_000, MAX_MS = 120_000, PCM_FLOAT_BYTES = 4, CLOCK_JITTER_MS = 250;
const invalid = (message: string): never => { throw new ApiError("transcription_failed", message); };
const relativePath = (path: string | undefined, meetingId: number, sequence: number) => path === `/meetings/${meetingId}/attributed-audio/ranges/${sequence}`;
const unknown = (value: string) => !value.trim() || /^unknown$/i.test(value.trim());
const sameAttribution = (a: AttributedRange, b: AttributedRange) => a.attribution.source === b.attribution.source && a.attribution.confidence === b.attribution.confidence;

/** The server validates fractional sample durations within one f32 sample, not rounded milliseconds. */
function validateRange(manifest: AttributedManifest, range: AttributedRange, index: number, vexaMeetingId: number): void {
  const duration = range.end_ms - range.start_ms;
  const expectedBytes = range.audio_duration_ms * range.sample_rate * PCM_FLOAT_BYTES / 1000;
  const allowedClockSkew = CLOCK_JITTER_MS + 1000 / range.sample_rate;
  const failedPathIsValid = range.path === undefined || relativePath(range.path, vexaMeetingId, range.sequence);
  if (
    range.version !== 1 || range.meeting_id !== manifest.meeting_id || range.sequence !== index
    || typeof range.idempotency_key !== "string" || !range.idempotency_key || typeof range.speaker_key !== "string" || unknown(range.speaker_key)
    || typeof range.speaker_name !== "string" || !Number.isSafeInteger(range.channel) || range.channel < 0 || !Number.isSafeInteger(range.turn_generation) || range.turn_generation < 1
    || !Number.isFinite(range.clock_origin_ms) || range.clock_origin_ms !== manifest.clock_origin_ms
    || !Number.isFinite(range.start_ms) || !Number.isFinite(range.end_ms) || range.start_ms < 0 || duration < 0 || duration >= MAX_MS
    || !Number.isFinite(range.audio_duration_ms) || range.audio_duration_ms < 0 || Math.abs(duration - range.audio_duration_ms) > allowedClockSkew
    || range.codec !== "pcm_f32le" || range.channels !== 1 || !Number.isInteger(range.sample_rate) || range.sample_rate < 1
    || !Number.isSafeInteger(range.byte_count) || range.byte_count < 0 || range.byte_count % PCM_FLOAT_BYTES !== 0 || Math.abs(expectedBytes - range.byte_count) > PCM_FLOAT_BYTES
    || !/^[a-f0-9]{64}$/i.test(range.sha256) || !["uploaded", "failed"].includes(range.state)
    || !range.attribution || !Number.isFinite(range.attribution.confidence) || range.attribution.confidence < 0 || range.attribution.confidence > 1
    || !["glow-bound", "provisional", "unresolved"].includes(range.attribution.source)
    || (range.attribution.source === "unresolved" ? range.speaker_name !== "" : unknown(range.speaker_name))
    || (range.state === "uploaded" ? !relativePath(range.path, vexaMeetingId, range.sequence) : !failedPathIsValid)
  ) invalid("Attributed audio manifest contains invalid producer evidence");
}

/** Keep each speaker's stream independent while retaining the producer sequence in each batch. */
export function attributedBatches(manifest: AttributedManifest, vexaMeetingId: number): AttributedBatch[] {
  if (manifest.version !== 1 || manifest.state !== "closed" || !manifest.meeting_id || manifest.clock_origin !== "first_admitted_capture_epoch_ms"
      || !Number.isFinite(manifest.clock_origin_ms) || manifest.clock_origin_ms < 0 || !Array.isArray(manifest.ranges)) {
    invalid("Attributed audio manifest is not a closed v1 manifest for this Vexa meeting");
  }
  manifest.ranges.forEach((range, index) => validateRange(manifest, range, index, vexaMeetingId));
  type Pending = { ranges: AttributedRange[]; audioMs: number };
  const active = new Map<string, Pending>(), done: AttributedBatch[] = [];
  const flush = (key: string) => {
    const current = active.get(key); if (!current?.ranges.length) return;
    const first = current.ranges[0]!, last = current.ranges.at(-1)!;
    done.push({ idempotency_key: current.ranges.map((r) => r.idempotency_key).join(","), speaker_key: first.speaker_key, speaker_name: first.speaker_name,
      attribution: first.attribution, start_ms: first.start_ms, end_ms: last.end_ms, ranges: current.ranges });
    active.delete(key);
  };
  for (const range of manifest.ranges) {
    if (range.state !== "uploaded" || range.attribution.source === "unresolved") continue;
    const key = [range.speaker_key, range.speaker_name, range.attribution.source, range.attribution.confidence, range.codec, range.sample_rate, range.channel].join("\u0000");
    let current = active.get(key);
    if (current) {
      const last = current.ranges.at(-1)!;
      if (range.start_ms < last.start_ms || !sameAttribution(last, range) || range.end_ms - current.ranges[0]!.start_ms >= MAX_MS || current.audioMs + range.audio_duration_ms >= MAX_MS) { flush(key); current = undefined; }
    }
    if (!current) { current = { ranges: [], audioMs: 0 }; active.set(key, current); }
    current.ranges.push(range); current.audioMs += range.audio_duration_ms;
    if (current.audioMs >= TARGET_MS) flush(key);
  }
  for (const key of [...active.keys()]) flush(key);
  return done.sort((a, b) => a.ranges[0]!.sequence - b.ranges[0]!.sequence);
}

function silentPcm(bytes: Uint8Array): boolean {
  if (!bytes.byteLength) return true;
  const view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / PCM_FLOAT_BYTES);
  let energy = 0; for (const value of view) energy += value * value;
  return 20 * Math.log10(Math.sqrt(energy / view.length) || 0) < -60;
}

export async function readAttributedBatch(batch: AttributedBatch, read: (range: AttributedRange) => Promise<Uint8Array>): Promise<{ pcm: Uint8Array; silent: boolean }> {
  const total = batch.ranges.reduce((sum, range) => sum + range.byte_count, 0);
  if (!Number.isSafeInteger(total)) invalid("Attributed batch exceeds memory ceiling");
  const pcm = new Uint8Array(total); let offset = 0;
  for (const range of batch.ranges) {
    const bytes = await read(range);
    if (bytes.byteLength !== range.byte_count || createHash("sha256").update(bytes).digest("hex") !== range.sha256) invalid("Attributed audio integrity check failed");
    pcm.set(bytes, offset); offset += bytes.byteLength;
  }
  return { pcm, silent: silentPcm(pcm) };
}

export async function transcribeAttributedManifest(manifest: AttributedManifest, read: (range: AttributedRange) => Promise<Uint8Array>, textOnly: (pcm: Uint8Array, batch: AttributedBatch) => Promise<{ text: string; language?: string }>, language: string | null, vexaMeetingId: number): Promise<NormalizedTranscript> {
  const raw = [];
  for (const batch of attributedBatches(manifest, vexaMeetingId)) {
    const prepared = await readAttributedBatch(batch, read), response = prepared.silent ? { text: "" } : await textOnly(prepared.pcm, batch);
    if (response.text.trim()) raw.push({ start: batch.start_ms / 1000, end: batch.end_ms / 1000, text: response.text, speaker: batch.speaker_name, speakerKey: batch.speaker_key,
      attribution: batch.attribution.source === "glow-bound" && batch.attribution.confidence > 0 ? "identified" as const : "provisional" as const, language: response.language ?? null });
  }
  return normalizeSegments(raw, language);
}
