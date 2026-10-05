import { normalizeSegments, type NormalizedTranscript, type SpeakerAttribution } from "../../domain/transcript.ts";
import { hallucinated } from "../../domain/hallucination.ts";
import type { AttributedBatch, AttributedManifest, AttributedRange } from "./attributed.ts";

/**
 * Turn-level assembly for attributed batches (TC-740).
 *
 * A batch splices one speaker stream's ranges into a single request. When the provider returns
 * segment timestamps, each segment is mapped back through the batch timeline to the meeting clock,
 * so speakers interleave in published order instead of arriving as 2-minute per-stream blocks.
 */

const PCM_FLOAT_BYTES = 4;
/** Silence inserted between non-contiguous ranges so the model sees a pause instead of a splice. */
const MAX_PAD_SEC = 0.8, MIN_PAD_SEC = 0.05;
/** Consecutive same-speaker pieces closer than this merge into one published turn. */
const TURN_GAP_SEC = 1.5, MAX_TURN_SEC = 90;
/** Unresolved audio borrows the name of the bound speaker on the same channel this close in time. */
export const UNRESOLVED_NEIGHBOUR_MS = 3_000;
const MAX_PIECES = 4_000, MAX_PIECE_TEXT = 8_000;

export interface TimelineEntry { range: AttributedRange; samples: number; padBefore: number; audioStart: number; audioEnd: number }

/** Deterministic layout of the audio actually sent for a batch: ranges in order, short pauses between gaps. */
export function batchTimeline(batch: AttributedBatch): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let cursor = 0;
  for (const [index, range] of batch.ranges.entries()) {
    const previous = batch.ranges[index - 1];
    const gap = previous ? (range.start_ms - previous.end_ms) / 1000 : 0;
    const padBefore = gap >= MIN_PAD_SEC ? Math.min(gap, MAX_PAD_SEC) : 0;
    const samples = Math.floor(range.byte_count / PCM_FLOAT_BYTES);
    const audioStart = cursor + padBefore, audioEnd = audioStart + samples / range.sample_rate;
    entries.push({ range, samples, padBefore, audioStart, audioEnd });
    cursor = audioEnd;
  }
  return entries;
}

/** Splices the batch PCM (f32le, concatenated in range order) with the timeline's pauses. */
export function paddedBatchPcm(batch: AttributedBatch, pcm: Float32Array): Float32Array {
  const timeline = batchTimeline(batch);
  const rate = batch.ranges[0]?.sample_rate ?? 16_000;
  const total = timeline.reduce((sum, entry) => sum + Math.round(entry.padBefore * rate) + entry.samples, 0);
  const out = new Float32Array(total);
  let read = 0, write = 0;
  for (const entry of timeline) {
    write += Math.round(entry.padBefore * rate);
    out.set(pcm.subarray(read, read + entry.samples), write);
    read += entry.samples; write += entry.samples;
  }
  return out;
}

/** Maps an offset in the sent audio to meeting seconds; offsets inside a pause snap to the next range. */
export function meetingSeconds(timeline: TimelineEntry[], offset: number): { at: number; entry: TimelineEntry } {
  let entry = timeline[0]!;
  for (const candidate of timeline) {
    if (offset < candidate.audioStart) { if (offset >= candidate.audioStart - candidate.padBefore) entry = candidate; break; }
    entry = candidate;
    if (offset < candidate.audioEnd) break;
  }
  const within = Math.min(Math.max(offset - entry.audioStart, 0), entry.audioEnd - entry.audioStart);
  return { at: entry.range.start_ms / 1000 + within, entry };
}

export interface TimedPiece { start: number; end: number; text: string; avg_logprob?: number; no_speech_prob?: number; compression_ratio?: number }
export interface AttributedResult { text: string; language?: string | null; segments?: TimedPiece[]; model?: string }

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
/** Provider output is untrusted: only a bounded, well-formed segment list is used for timing. */
export function validPieces(result: { segments?: unknown }): TimedPiece[] | null {
  const pieces = result.segments;
  if (!Array.isArray(pieces) || !pieces.length || pieces.length > MAX_PIECES) return null;
  for (const piece of pieces) {
    if (!piece || typeof piece !== "object" || !finite(piece.start) || !finite(piece.end) || piece.start < 0 || piece.end < piece.start
        || typeof piece.text !== "string" || piece.text.length > MAX_PIECE_TEXT) return null;
    for (const key of ["avg_logprob", "no_speech_prob", "compression_ratio"] as const) if (piece[key] !== undefined && piece[key] !== null && !finite(piece[key])) return null;
  }
  return pieces as TimedPiece[];
}

type Named = { name: string; source: "glow-bound" | "provisional" };
const isNamed = (range: AttributedRange) => range.attribution.source !== "unresolved" && !!range.speaker_name.trim();

/**
 * Unresolved ranges carry real speech whose speaker glow was missed. The bound speaker on the same
 * channel within a few seconds is almost always the same voice; such names publish as provisional.
 */
export function inferUnresolvedSpeakers(manifest: AttributedManifest, windowMs = UNRESOLVED_NEIGHBOUR_MS): Map<number, Named> {
  const byChannel = new Map<number, AttributedRange[]>();
  for (const range of manifest.ranges) if (isNamed(range)) {
    const list = byChannel.get(range.channel) ?? []; list.push(range); byChannel.set(range.channel, list);
  }
  for (const list of byChannel.values()) list.sort((a, b) => a.start_ms - b.start_ms);
  const inferred = new Map<number, Named>();
  for (const range of manifest.ranges) {
    if (range.attribution.source !== "unresolved") continue;
    const bound = byChannel.get(range.channel); if (!bound?.length) continue;
    // Binary search for the first bound range starting at or after this one, then scan outwards
    // while candidates can still be inside the window.
    let lo = 0, hi = bound.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (bound[mid]!.start_ms < range.start_ms) lo = mid + 1; else hi = mid; }
    let best: AttributedRange | undefined, bestDistance = Infinity;
    const consider = (candidate: AttributedRange) => {
      const distance = Math.max(0, candidate.start_ms - range.end_ms, range.start_ms - candidate.end_ms);
      if (distance < bestDistance || (distance === bestDistance && best && candidate.audio_duration_ms > best.audio_duration_ms)) { best = candidate; bestDistance = distance; }
    };
    for (let i = lo; i < bound.length && bound[i]!.start_ms - range.end_ms <= windowMs; i++) consider(bound[i]!);
    for (let i = lo - 1; i >= 0 && i >= lo - 64; i--) { consider(bound[i]!); if (range.start_ms - bound[i]!.end_ms > windowMs * 4) break; }
    if (best && bestDistance <= windowMs) inferred.set(range.sequence, { name: best.speaker_name, source: "provisional" });
  }
  return inferred;
}

type RawPiece = { start: number; end: number; text: string; speaker: string; speakerKey: string; attribution: SpeakerAttribution; language: string | null };

/** One published identity per display name: the capture channel is not a person. */
const nameKey = (name: string) => `name:${name.normalize("NFC").trim().toLowerCase()}`;

function speakerFor(batch: AttributedBatch, range: AttributedRange | undefined, inferred: Map<number, Named>): Pick<RawPiece, "speaker" | "speakerKey" | "attribution"> {
  if (batch.attribution.source === "unresolved") {
    const guess = range ? inferred.get(range.sequence) : undefined;
    // The provider's speaker_key can collide with a named participant's key, so unresolved
    // ranges keep their own namespace unless a neighbouring bound range names them.
    return guess ? { speaker: guess.name, speakerKey: nameKey(guess.name), attribution: "provisional" }
      : { speaker: "Unknown", speakerKey: `unresolved:${batch.speaker_key}`, attribution: "unknown" };
  }
  return { speaker: batch.speaker_name, speakerKey: nameKey(batch.speaker_name),
    attribution: batch.attribution.source === "glow-bound" && batch.attribution.confidence > 0 ? "identified" : "provisional" };
}

export interface AssemblyStats { pieces: number; dropped_hallucinations: number; timed_batches: number; untimed_batches: number }

/** Builds raw segments for completed batches. Untimed results keep the legacy whole-batch segment. */
export function attributedPieces(manifest: AttributedManifest, completed: Array<{ spec: AttributedBatch; result: AttributedResult }>, inferred = inferUnresolvedSpeakers(manifest)): { raw: RawPiece[]; stats: AssemblyStats } {
  const raw: RawPiece[] = [];
  const stats: AssemblyStats = { pieces: 0, dropped_hallucinations: 0, timed_batches: 0, untimed_batches: 0 };
  for (const { spec, result } of completed) {
    const language = typeof result.language === "string" ? result.language : null;
    const pieces = validPieces(result);
    if (!pieces) {
      stats.untimed_batches++;
      if (hallucinated(result.text)) { stats.dropped_hallucinations++; continue; }
      raw.push({ start: spec.start_ms / 1000, end: spec.end_ms / 1000, text: result.text, ...speakerFor(spec, spec.ranges[0], inferred), language });
      continue;
    }
    stats.timed_batches++;
    const timeline = batchTimeline(spec);
    for (const piece of pieces) {
      if (!piece.text.trim()) continue;
      if (hallucinated(piece.text, piece)) { stats.dropped_hallucinations++; continue; }
      const start = meetingSeconds(timeline, piece.start), end = meetingSeconds(timeline, Math.max(piece.start, piece.end - 1e-3));
      const mid = meetingSeconds(timeline, (piece.start + piece.end) / 2);
      raw.push({ start: start.at, end: Math.max(start.at, end.at), text: piece.text.trim(), ...speakerFor(spec, mid.entry.range, inferred), language });
    }
  }
  stats.pieces = raw.length;
  return { raw, stats };
}

/** Sorts pieces on the meeting clock and merges a speaker's consecutive pieces into turns. */
export function mergeTurns(raw: RawPiece[]): RawPiece[] {
  const sorted = [...raw].sort((a, b) => a.start - b.start || a.end - b.end);
  const turns: RawPiece[] = [];
  for (const piece of sorted) {
    const last = turns.at(-1);
    if (last && last.speakerKey === piece.speakerKey && last.attribution === piece.attribution
        && piece.start - last.end <= TURN_GAP_SEC && piece.end - last.start <= MAX_TURN_SEC) {
      last.end = Math.max(last.end, piece.end); last.text = `${last.text} ${piece.text}`;
    } else turns.push({ ...piece });
  }
  return turns;
}

export function assembleAttributedTranscript(manifest: AttributedManifest, completed: Array<{ spec: AttributedBatch; result: AttributedResult }>, language: string | null): { transcript: NormalizedTranscript; stats: AssemblyStats; unknown: boolean } {
  const { raw, stats } = attributedPieces(manifest, completed);
  const transcript = normalizeSegments(mergeTurns(raw), language);
  return { transcript, stats, unknown: transcript.segments.some((segment) => segment.attribution === "unknown") };
}
