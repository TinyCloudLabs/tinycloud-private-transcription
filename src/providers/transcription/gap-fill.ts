import type { SpeakerAttribution, TranscriptGap } from "../../domain/transcript.ts";
import { hallucinated } from "../../domain/hallucination.ts";
import type { AttributedManifest, AttributedRange } from "./attributed.ts";
import { inferUnresolvedSpeakers, nameKey, pieceEvidence, validPieces, type RawPiece, type TimedPiece } from "./attributed-assembly.ts";
import type { Pcm16 } from "./audio.ts";
import { safeTinfoilLanguage } from "./tinfoil.ts";

/**
 * Recording gap fill (TC-758).
 *
 * Captured speech the attributed path could not transcribe — a batch whose retries are exhausted,
 * or a range whose upload the producer reported failed — is re-read from Vexa's retained mixed
 * recording for its time span and published under that span's speaker as provisional text marked
 * `source: "recording"`. Whatever is still untranscribed is listed as a gap, never dropped silently.
 *
 * Everything here is deterministic over the immutable manifest and the stored result, so
 * publication re-derives the same spans, windows, pieces and gaps.
 *
 * Recording clock. The manifest clock is `first_admitted_capture_epoch_ms`: the epoch of the first
 * per-speaker frame the bot admitted, and Google Meet capture drops near-silent frames, so it is the
 * first audible remote speech. The mixed recording (MediaRecorder over the page's audio elements)
 * starts when the bot's capture pipeline starts, right after admission, i.e. at roughly Vexa's
 * `start_time`. Vexa exposes no exact recording start epoch (a media file's `first_chunk_at` is an
 * upload time, one 15 s timeslice late), so the offset is estimated: the prior is
 * `clock_origin_ms − start_time`, refined by correlating the manifest's ranges (which exist only
 * where someone spoke) with the recording's voiced 100 ms frames. Recording seconds =
 * meeting seconds + offset. Without a confident correlation or a usable prior nothing is sent
 * and every span stays a listed gap rather than risk publishing the wrong moment's words.
 */

/** One speaker's untranscribed ranges closer than this merge into one span. */
export const GAP_MERGE_MS = 1_500;
/** Audio cut around each window so edge words are not clipped; small against alignment error. */
export const GAP_PAD_MS = 250;
/** Unpadded window bound: padded windows stay under Tinfoil's 30 s re-chunking (TIMED_WINDOW_SEC). */
export const GAP_WINDOW_MS = 29_000;
const FRAME_MS = 100;
/** Share of the manifest's speech frames that must land on recording speech to trust a correlation. */
export const ALIGN_MIN_SCORE = 0.6;
const ALIGN_MIN_FRAMES = 30, ALIGN_PRIOR_SEARCH_MS = 30_000, ALIGN_BLIND_SEARCH_MS = 600_000, ALIGN_LEAD_MS = 5_000;
/** A prior outside this band is not a recording offset (e.g. a test or legacy zero clock origin). */
const PRIOR_MIN_MS = -60_000, PRIOR_MAX_MS = 6 * 60 * 60_000;
const SILENT_DBFS = -60, MAX_WINDOWS = 2_000, MAX_TEXT = 8_000;

export interface GapSpan { start_ms: number; end_ms: number; speaker_name: string; speaker_key: string; attribution: "provisional" | "unknown"; sequences: number[] }
export interface GapSpec { kind: "gap_fill"; spans: GapSpan[] }
export interface GapWindow { span: number; start_ms: number; end_ms: number }
export type GapWindowStatus = "text" | "empty" | "silent" | "missing";
export interface GapWindowResult extends GapWindow { status: GapWindowStatus; cut_start_ms?: number; text?: string; language?: string; segments?: TimedPiece[]; energy_dbfs?: number }
export interface GapFillResult { text: string; language?: string | null; model?: string; offset_ms: number; alignment: "correlated" | "prior"; score: number | null; windows: GapWindowResult[] }

/** Named ranges keep their speaker; unresolved ones take the same-channel inference or Unknown. */
function speakerOf(range: AttributedRange, inferred: ReturnType<typeof inferUnresolvedSpeakers>): Pick<GapSpan, "speaker_name" | "speaker_key" | "attribution"> {
  if (range.attribution.source !== "unresolved" && range.speaker_name.trim()) return { speaker_name: range.speaker_name, speaker_key: nameKey(range.speaker_name), attribution: "provisional" };
  const guess = inferred.get(range.sequence);
  return guess ? { speaker_name: guess.name, speaker_key: nameKey(guess.name), attribution: "provisional" }
    : { speaker_name: "Unknown", speaker_key: `unresolved:${range.speaker_key}`, attribution: "unknown" };
}

/** Deterministic spans for the given untranscribed range sequences. */
export function gapSpec(manifest: AttributedManifest, sequences: Iterable<number>): GapSpec {
  const wanted = new Set(sequences), inferred = inferUnresolvedSpeakers(manifest);
  const ranges = manifest.ranges.filter((range) => wanted.has(range.sequence) && range.end_ms > range.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms || a.sequence - b.sequence);
  const open = new Map<string, GapSpan>(), spans: GapSpan[] = [];
  for (const range of ranges) {
    const speaker = speakerOf(range, inferred);
    const current = open.get(speaker.speaker_key);
    if (current && range.start_ms - current.end_ms <= GAP_MERGE_MS) {
      current.end_ms = Math.max(current.end_ms, range.end_ms); current.sequences.push(range.sequence);
    } else {
      const span = { start_ms: range.start_ms, end_ms: range.end_ms, ...speaker, sequences: [range.sequence] };
      open.set(speaker.speaker_key, span); spans.push(span);
    }
  }
  spans.sort((a, b) => a.start_ms - b.start_ms || (a.speaker_key < b.speaker_key ? -1 : a.speaker_key > b.speaker_key ? 1 : 0));
  return { kind: "gap_fill", spans };
}

/** Each span split into near-equal windows of at most GAP_WINDOW_MS (unpadded, meeting clock). */
export function gapWindows(spec: GapSpec): GapWindow[] {
  const windows: GapWindow[] = [];
  for (const [index, span] of spec.spans.entries()) {
    const length = span.end_ms - span.start_ms, count = Math.max(1, Math.ceil(length / GAP_WINDOW_MS));
    for (let i = 0; i < count; i++) windows.push({ span: index, start_ms: span.start_ms + Math.round(length * i / count), end_ms: span.start_ms + Math.round(length * (i + 1) / count) });
  }
  return windows;
}

/** Voiced 100 ms frames of the recording: RMS ≥ max(−50 dBFS, 10th percentile + 12 dB). */
export function voicedFrames(pcm: Pcm16): Uint8Array {
  const size = Math.round(pcm.sampleRate * FRAME_MS / 1000), count = Math.floor(pcm.samples.length / size);
  const levels = new Float64Array(count);
  for (let frame = 0; frame < count; frame++) {
    let sum = 0;
    for (let i = frame * size; i < (frame + 1) * size; i++) { const value = pcm.samples[i]! / 32768; sum += value * value; }
    levels[frame] = sum > 0 ? 10 * Math.log10(sum / size) : -120;
  }
  const sorted = [...levels].sort((a, b) => a - b);
  const threshold = Math.max(-50, (sorted[Math.floor(sorted.length * 0.1)] ?? -120) + 12);
  return Uint8Array.from(levels, (level) => level >= threshold ? 1 : 0);
}

/** `clock_origin_ms − start_time` when both are known and plausible; otherwise null. */
export function priorOffsetMs(clockOriginMs: number, providerStartedAt: string | null | undefined): number | null {
  const started = providerStartedAt ? Date.parse(providerStartedAt) : NaN;
  const prior = clockOriginMs - started;
  return Number.isFinite(prior) && prior >= PRIOR_MIN_MS && prior <= PRIOR_MAX_MS ? prior : null;
}

/**
 * Recording offset (ms) such that recording time = meeting time + offset. The score is the share
 * of manifest speech frames that land on voiced recording frames; ties prefer the offset nearest
 * the prior (or zero), so a constant score cannot drift the alignment.
 */
export function alignRecording(manifest: AttributedManifest, voiced: Uint8Array, priorMs: number | null): { offset_ms: number; alignment: "correlated" | "prior"; score: number | null } | null {
  const frames = new Set<number>();
  for (const range of manifest.ranges) for (let f = Math.floor(range.start_ms / FRAME_MS); f < Math.ceil(range.end_ms / FRAME_MS); f++) frames.add(f);
  const speech = [...frames];
  const centre = priorMs === null ? 0 : Math.round(priorMs / FRAME_MS);
  const [lo, hi] = priorMs === null ? [-ALIGN_LEAD_MS / FRAME_MS, ALIGN_BLIND_SEARCH_MS / FRAME_MS] : [centre - ALIGN_PRIOR_SEARCH_MS / FRAME_MS, centre + ALIGN_PRIOR_SEARCH_MS / FRAME_MS];
  let best: { k: number; score: number } | null = null;
  if (speech.length >= ALIGN_MIN_FRAMES && voiced.length) {
    for (let k = lo; k <= hi; k++) {
      let hits = 0;
      for (const f of speech) if (voiced[f + k] === 1) hits++;
      const score = hits / speech.length;
      if (!best || score > best.score || (score === best.score && Math.abs(k - centre) < Math.abs(best.k - centre))) best = { k, score };
    }
  }
  if (best && best.score >= ALIGN_MIN_SCORE) return { offset_ms: best.k * FRAME_MS, alignment: "correlated", score: Math.round(best.score * 1000) / 1000 };
  return priorMs === null ? null : { offset_ms: Math.round(priorMs), alignment: "prior", score: best ? Math.round(best.score * 1000) / 1000 : null };
}

/** Padded recording cut for a window, in recording seconds; null when it lies outside the recording. */
export function recordingCut(window: GapWindow, offsetMs: number, durationSec: number): { from: number; to: number; cutStartMs: number } | null {
  const from = Math.max(0, (window.start_ms - GAP_PAD_MS + offsetMs) / 1000), to = Math.min(durationSec, (window.end_ms + GAP_PAD_MS + offsetMs) / 1000);
  if (to - from < 0.2) return null;
  return { from, to, cutStartMs: Math.round(from * 1000 - offsetMs) };
}

export const silentWindow = (energyDbfs: number) => energyDbfs < SILENT_DBFS;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
/** Untrusted stored result: shape must match the spec's windows exactly or publication rejects. */
export function validGapResult(spec: GapSpec, value: unknown): GapFillResult | null {
  const result = value as GapFillResult;
  const expected = gapWindows(spec);
  if (!result || typeof result !== "object" || !finite(result.offset_ms) || !["correlated", "prior"].includes(result.alignment)
      || !Array.isArray(result.windows) || result.windows.length !== expected.length || expected.length > MAX_WINDOWS) return null;
  for (const [index, window] of result.windows.entries()) {
    const want = expected[index]!;
    if (!window || window.span !== want.span || window.start_ms !== want.start_ms || window.end_ms !== want.end_ms
        || !["text", "empty", "silent", "missing"].includes(window.status)) return null;
    if (window.status === "text" && (typeof window.text !== "string" || !window.text.trim() || window.text.length > MAX_TEXT || !finite(window.cut_start_ms)
        || (window.energy_dbfs !== undefined && !finite(window.energy_dbfs)) || (window.language !== undefined && !safeTinfoilLanguage(window.language)))) return null;
  }
  return result;
}

const overlap = (a: [number, number], b: [number, number]) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
function union(intervals: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end); else out.push([start, end]);
  }
  return out;
}
const subtract = (from: [number, number], cover: Array<[number, number]>): Array<[number, number]> => {
  let rest: Array<[number, number]> = [from];
  for (const [start, end] of cover) rest = rest.flatMap(([a, b]): Array<[number, number]> => end <= a || start >= b ? [[a, b]] : [...(start > a ? [[a, start] as [number, number]] : []), ...(end < b ? [[end, b] as [number, number]] : [])]);
  return rest;
};

/**
 * Publishable pieces from a gap fill, and the captured speech still untranscribed. A window counts
 * as covered only when the recording yielded text for it; silent, missing (outside the recording),
 * empty, unaligned or exhausted windows leave their ranges listed as gaps.
 */
export function gapOutcome(manifest: AttributedManifest, spec: GapSpec, result: GapFillResult | null): { pieces: RawPiece[]; gaps: TranscriptGap[]; recording_ms: number; gap_ms: number; dropped_hallucinations: number } {
  const bySequence = new Map(manifest.ranges.map((range) => [range.sequence, range]));
  const windows = result?.windows ?? gapWindows(spec).map((window) => ({ ...window, status: "missing" as const }));
  const pieces: RawPiece[] = [];
  let dropped = 0;
  const covered = spec.spans.map((): Array<[number, number]> => []);
  for (const window of windows) {
    if (window.status !== "text") continue;
    const span = spec.spans[window.span]!;
    covered[window.span]!.push([window.start_ms, window.end_ms]);
    const speaker = { speaker: span.speaker_name, speakerKey: span.speaker_key, attribution: span.attribution as SpeakerAttribution, language: window.language ?? null, origin: "recording" as const };
    const lo = window.start_ms / 1000, hi = window.end_ms / 1000;
    const timed = validPieces(window);
    if (!timed) {
      if (hallucinated(window.text!, { untimed: true, audioSec: hi - lo, ...(finite(window.energy_dbfs) ? { energy_dbfs: window.energy_dbfs } : {}) })) { dropped++; continue; }
      pieces.push({ start: lo, end: hi, text: window.text!.trim(), ...speaker });
      continue;
    }
    for (const piece of timed) {
      if (!piece.text.trim()) continue;
      if (hallucinated(piece.text, pieceEvidence(piece))) { dropped++; continue; }
      // Offsets are into the padded cut; the padding belongs to neighbouring speech, so clamp to the window.
      const start = Math.min(hi, Math.max(lo, window.cut_start_ms! / 1000 + piece.start)), end = Math.min(hi, Math.max(start, window.cut_start_ms! / 1000 + piece.end));
      pieces.push({ start, end, text: piece.text.trim(), ...speaker });
    }
  }
  const open: TranscriptGap[] = [];
  let recording = 0, gap = 0;
  for (const [index, span] of spec.spans.entries()) {
    const cover = union(covered[index]!);
    const captured = union(span.sequences.map((sequence) => bySequence.get(sequence)).filter((range) => !!range).map((range) => [range!.start_ms, range!.end_ms] as [number, number]));
    for (const interval of captured) {
      recording += cover.reduce((sum, c) => sum + overlap(interval, c), 0);
      for (const [start, end] of subtract(interval, cover)) { gap += end - start; open.push({ start: start / 1000, end: end / 1000, speaker_name: span.speaker_name }); }
    }
  }
  open.sort((a, b) => a.start - b.start || a.end - b.end);
  return { pieces, gaps: open, recording_ms: Math.round(recording), gap_ms: Math.round(gap), dropped_hallucinations: dropped };
}
