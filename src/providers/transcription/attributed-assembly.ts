import { normalizeSegments, type NormalizedTranscript, type SpeakerAttribution } from "../../domain/transcript.ts";
import { hallucinated, hallucinationReason } from "../../domain/hallucination.ts";
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

/** `energy_dbfs` is the RMS of the captured audio around the piece, measured before sending (TC-758). */
export interface TimedPiece { start: number; end: number; text: string; avg_logprob?: number; no_speech_prob?: number; compression_ratio?: number; energy_dbfs?: number }
/**
 * One request window of a batch, in sent-audio seconds (TC-758): `text` returned words, `empty`
 * returned none for voiced audio, `silent` was never sent. Present only on results produced since
 * TC-758; it is what lets publication find voiced audio that yielded no text.
 */
export interface ResultWindow { from: number; to: number; status: "text" | "empty" | "silent" }
/** `fallback` marks text from the fallback model, published with `source: "fallback"` for audit. */
export interface AttributedResult { text: string; language?: string | null; segments?: TimedPiece[]; model?: string; energy_dbfs?: number; windows?: ResultWindow[]; fallback?: boolean }
/** Part of one range (meeting clock) whose captured audio no attempt turned into kept text. */
export interface GapPart { sequence: number; start_ms: number; end_ms: number }

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const optionalFinite = (value: unknown) => value === undefined || value === null || finite(value);
/**
 * Provider output is untrusted: only a bounded list of well-formed pieces is used for timing.
 * Malformed pieces (e.g. a trailing segment Whisper places past the audio end) are dropped one by
 * one rather than discarding the batch's timing; deterministic, so publication re-derives the same.
 */
export function validPieces(result: { segments?: unknown }): TimedPiece[] | null {
  const pieces = result.segments;
  if (!Array.isArray(pieces) || !pieces.length || pieces.length > MAX_PIECES) return null;
  const valid = pieces.filter((piece): piece is TimedPiece => !!piece && typeof piece === "object"
    && finite(piece.start) && finite(piece.end) && piece.start >= 0 && piece.end >= piece.start
    && typeof piece.text === "string" && piece.text.length <= MAX_PIECE_TEXT
    && optionalFinite(piece.avg_logprob) && optionalFinite(piece.no_speech_prob) && optionalFinite(piece.compression_ratio) && optionalFinite(piece.energy_dbfs));
  return valid.length ? valid : null;
}

const MAX_WINDOWS = 64;
/** The result's window record, or null for pre-TC-758 results (and anything malformed). */
export function resultWindows(result: { windows?: unknown }): ResultWindow[] | null {
  const windows = result.windows;
  if (!Array.isArray(windows) || !windows.length || windows.length > MAX_WINDOWS) return null;
  return windows.every((w) => !!w && typeof w === "object" && finite(w.from) && finite(w.to) && w.to >= w.from && ["text", "empty", "silent"].includes(w.status)) ? windows as ResultWindow[] : null;
}

/** Sent-audio intervals mapped onto the ranges they carried (inserted pauses map to nothing), merged per range. */
export function audioToParts(timeline: TimelineEntry[], intervals: Array<[number, number]>): GapPart[] {
  const byRange = new Map<number, Array<[number, number]>>();
  for (const [from, to] of intervals) for (const entry of timeline) {
    const a = Math.max(from, entry.audioStart), b = Math.min(to, entry.audioEnd);
    if (b <= a) continue;
    const start = Math.round(entry.range.start_ms + (a - entry.audioStart) * 1000), end = Math.min(entry.range.end_ms, Math.round(entry.range.start_ms + (b - entry.audioStart) * 1000));
    if (end > start) { const list = byRange.get(entry.range.sequence) ?? []; list.push([start, end]); byRange.set(entry.range.sequence, list); }
  }
  const parts: GapPart[] = [];
  for (const [sequence, list] of byRange) {
    list.sort((x, y) => x[0] - y[0]);
    let current: [number, number] | null = null;
    for (const [a, b] of list) {
      if (current && a <= current[1]) current[1] = Math.max(current[1], b);
      else { if (current) parts.push({ sequence, start_ms: current[0], end_ms: current[1] }); current = [a, b]; }
    }
    if (current) parts.push({ sequence, start_ms: current[0], end_ms: current[1] });
  }
  return parts.sort((x, y) => x.start_ms - y.start_ms || x.sequence - y.sequence);
}
export const partsMs = (parts: GapPart[]) => parts.reduce((sum, part) => sum + part.end_ms - part.start_ms, 0);
/** A dropped piece with a degenerate timestamp still marks some audio as untranscribed. */
const MIN_DROPPED_SEC = 0.2;

/** Whisper's per-piece evidence for the hallucination filter; energy only where it was measured. */
export const pieceEvidence = (piece: TimedPiece) => ({ avg_logprob: piece.avg_logprob ?? undefined, no_speech_prob: piece.no_speech_prob ?? undefined,
  compression_ratio: piece.compression_ratio ?? undefined, ...(piece.energy_dbfs != null ? { energy_dbfs: piece.energy_dbfs } : {}), untimed: false, audioSec: piece.end - piece.start });

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

/**
 * `origin` marks text that did not come from the primary model on the speaker's own stream (TC-758):
 * `recording` was re-read from the retained mixed recording, `fallback` came from the fallback model.
 */
export type RawPiece = { start: number; end: number; text: string; speaker: string; speakerKey: string; attribution: SpeakerAttribution; language: string | null; origin?: "recording" | "fallback" };

/** One published identity per display name: the capture channel is not a person. */
export const nameKey = (name: string) => `name:${name.normalize("NFC").trim().toLowerCase()}`;

/**
 * `ranges` are the ranges the text came from: one for a timed piece, the whole batch for untimed
 * text. Unresolved text takes an inferred name only when every one of those ranges agrees (M2).
 */
function speakerFor(batch: AttributedBatch, ranges: AttributedRange[], inferred: Map<number, Named>): Pick<RawPiece, "speaker" | "speakerKey" | "attribution"> {
  if (batch.attribution.source === "unresolved") {
    const names = new Set(ranges.map((range) => inferred.get(range.sequence)?.name));
    const guess = names.size === 1 ? inferred.get(ranges[0]!.sequence) : undefined;
    // The provider's speaker_key can collide with a named participant's key, so unresolved
    // ranges keep their own namespace unless a neighbouring bound range names them.
    return guess ? { speaker: guess.name, speakerKey: nameKey(guess.name), attribution: "provisional" }
      : { speaker: "Unknown", speakerKey: `unresolved:${batch.speaker_key}`, attribution: "unknown" };
  }
  return { speaker: batch.speaker_name, speakerKey: nameKey(batch.speaker_name),
    attribution: batch.attribution.source === "glow-bound" && batch.attribution.confidence > 0 ? "identified" : "provisional" };
}

export interface AssemblyStats { pieces: number; dropped_hallucinations: number; timed_batches: number; untimed_batches: number }

/**
 * Builds raw segments for completed batches. Untimed results keep the legacy whole-batch segment.
 * For results that record their windows (TC-758) it also returns the captured audio that yielded
 * no kept text — voiced windows answered empty, text dropped as not-speech over non-silent audio,
 * text windows without usable pieces — as `untranscribed` parts, and silent windows' audio as
 * `silent_ms`. Pre-TC-758 results contribute neither, so they assemble exactly as before.
 */
export function attributedPieces(manifest: AttributedManifest, completed: Array<{ spec: AttributedBatch; result: AttributedResult }>, inferred = inferUnresolvedSpeakers(manifest)): { raw: RawPiece[]; stats: AssemblyStats; untranscribed: GapPart[]; silent_ms: number; batches: Array<{ untranscribed: GapPart[]; kept: number }> } {
  const raw: RawPiece[] = [];
  const stats: AssemblyStats = { pieces: 0, dropped_hallucinations: 0, timed_batches: 0, untimed_batches: 0 };
  const untranscribed: GapPart[] = [], batches: Array<{ untranscribed: GapPart[]; kept: number }> = [];
  let silentMs = 0;
  for (const { spec, result } of completed) {
    const language = typeof result.language === "string" ? result.language : null;
    const origin = result.fallback === true ? { origin: "fallback" as const } : {};
    const windows = resultWindows(result), timeline = batchTimeline(spec), total = timeline.at(-1)?.audioEnd ?? 0;
    const uncovered: Array<[number, number]> = [], silent: Array<[number, number]> = [];
    const before = raw.length;
    const pieces = validPieces(result);
    if (!pieces) {
      stats.untimed_batches++;
      const audioSec = spec.ranges.reduce((sum, range) => sum + range.audio_duration_ms, 0) / 1000;
      const energy = typeof result.energy_dbfs === "number" && Number.isFinite(result.energy_dbfs) ? { energy_dbfs: result.energy_dbfs } : {};
      const reason = hallucinationReason(result.text, { untimed: true, audioSec, ...energy });
      if (reason) {
        stats.dropped_hallucinations++;
        if (windows) (reason === "silent" ? silent : uncovered).push([0, total]);
      } else raw.push({ start: spec.start_ms / 1000, end: spec.end_ms / 1000, text: result.text, ...speakerFor(spec, spec.ranges, inferred), language, ...origin });
      if (windows && !reason) for (const window of windows) if (window.status !== "text") (window.status === "silent" ? silent : uncovered).push([window.from, window.to]);
    } else {
      stats.timed_batches++;
      const touched = new Set<number>();
      for (const piece of pieces) {
        if (!piece.text.trim()) continue;
        const index = windows?.findIndex((window) => piece.start >= window.from && piece.start < window.to) ?? -1;
        if (index >= 0) touched.add(index);
        const reason = hallucinationReason(piece.text, pieceEvidence(piece));
        if (reason) {
          stats.dropped_hallucinations++;
          if (windows) (reason === "silent" ? silent : uncovered).push([piece.start, Math.max(piece.end, piece.start + MIN_DROPPED_SEC)]);
          continue;
        }
        const start = meetingSeconds(timeline, piece.start), end = meetingSeconds(timeline, Math.max(piece.start, piece.end - 1e-3));
        const mid = meetingSeconds(timeline, (piece.start + piece.end) / 2);
        raw.push({ start: start.at, end: Math.max(start.at, end.at), text: piece.text.trim(), ...speakerFor(spec, [mid.entry.range], inferred), language, ...origin });
      }
      if (windows) for (const [index, window] of windows.entries()) {
        if (window.status === "silent") silent.push([window.from, window.to]);
        else if (window.status === "empty" || !touched.has(index)) uncovered.push([window.from, window.to]);
      }
    }
    const lost = audioToParts(timeline, uncovered);
    silentMs += partsMs(audioToParts(timeline, silent));
    untranscribed.push(...lost);
    batches.push({ untranscribed: lost, kept: raw.length - before });
  }
  stats.pieces = raw.length;
  return { raw, stats, untranscribed, silent_ms: silentMs, batches };
}

/** Sorts pieces on the meeting clock and merges a speaker's consecutive pieces into turns. */
export function mergeTurns(raw: RawPiece[]): RawPiece[] {
  const sorted = [...raw].sort((a, b) => a.start - b.start || a.end - b.end);
  const turns: RawPiece[] = [];
  for (const piece of sorted) {
    const last = turns.at(-1);
    if (last && last.speakerKey === piece.speakerKey && last.attribution === piece.attribution && last.origin === piece.origin
        && piece.start - last.end <= TURN_GAP_SEC && piece.end - last.start <= MAX_TURN_SEC) {
      last.end = Math.max(last.end, piece.end); last.text = `${last.text} ${piece.text}`;
    } else turns.push({ ...piece });
  }
  return turns;
}

/** `recovered` are pieces re-read from the retained recording for spans the attributed path could not transcribe (TC-758). */
export function assembleAttributedTranscript(manifest: AttributedManifest, completed: Array<{ spec: AttributedBatch; result: AttributedResult }>, language: string | null, recovered: RawPiece[] = []): { transcript: NormalizedTranscript; stats: AssemblyStats; unknown: boolean } {
  const { raw, stats } = attributedPieces(manifest, completed);
  return { ...assembleRawPieces([...raw, ...recovered], language), stats };
}

/** Turns on the meeting clock from already-assessed pieces (attributed and recording-filled). */
export function assembleRawPieces(raw: RawPiece[], language: string | null): { transcript: NormalizedTranscript; unknown: boolean } {
  const transcript = normalizeSegments(mergeTurns(raw), language);
  return { transcript, unknown: transcript.segments.some((segment) => segment.attribution === "unknown") };
}
