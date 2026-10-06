import type { SpeakerAttribution, TranscriptGap } from "../../domain/transcript.ts";
import { hallucinationReason } from "../../domain/hallucination.ts";
import type { AttributedManifest, AttributedRange } from "./attributed.ts";
import { inferUnresolvedSpeakers, nameKey, pieceEvidence, validPieces, type GapPart, type RawPiece, type TimedPiece } from "./attributed-assembly.ts";
import { safeTinfoilLanguage } from "./tinfoil.ts";

/**
 * Recording gap fill (TC-758).
 *
 * Captured speech the attributed path could not transcribe — ranges of an exhausted batch, ranges
 * whose upload the producer reported failed, and parts of completed batches that yielded no kept
 * text — is re-read from Vexa's retained mixed recording and published under the speaker of that
 * speech as `source: "recording"`. Whatever is still untranscribed is listed as a gap.
 *
 * Two durable steps, each a ledger row beside the batches:
 * 1. align (unpaid): stream the recording once into 100 ms levels, verify an offset to the meeting
 *    clock, and classify every window as voiced, silent or outside the recording;
 * 2. chunks (paid): voiced windows in groups of GAP_CHUNK_WINDOWS, each group its own row with its
 *    own retries, so a long outage never rides on one all-or-nothing attempt. Each window is cut
 *    from the recording file on its own; the meeting is never decoded whole.
 * Everything here is deterministic over the immutable manifest and stored results, so publication
 * re-derives the same spans, windows, chunks, pieces and gaps.
 *
 * Recording clock. The manifest clock is `first_admitted_capture_epoch_ms`: the epoch of the first
 * per-speaker frame the bot admitted, and Google Meet capture drops near-silent frames, so it is the
 * first audible remote speech. The mixed recording (MediaRecorder over the page's audio elements)
 * starts when the bot's capture pipeline starts, right after admission, i.e. at roughly Vexa's
 * `start_time`. Vexa exposes no exact recording start epoch (a media file's `first_chunk_at` is an
 * upload time, one 15 s timeslice late). `clock_origin_ms − start_time` therefore only centres the
 * search: the offset is accepted only when the manifest's ranges (which exist only where someone
 * spoke) land on voiced recording frames with score ≥ ALIGN_MIN_SCORE and clearly better than any
 * offset more than a second away. Otherwise nothing is sent and every span stays a listed gap:
 * publishing another moment's words would be worse than reporting the gap.
 */

/** One speaker's untranscribed parts closer than this merge into one span. */
export const GAP_MERGE_MS = 1_500;
/** Audio cut around each window so edge words are not clipped. */
export const GAP_PAD_MS = 250;
/** Unpadded window bound: padded windows stay under Tinfoil's 30 s re-chunking (TIMED_WINDOW_SEC). */
export const GAP_WINDOW_MS = 29_000;
/** Voiced windows per paid gap-fill row: bounds what one failed attempt can throw away. */
export const GAP_CHUNK_WINDOWS = 4;
const FRAME_MS = 100;
/** Share of the manifest's speech frames that must land on recording speech. */
export const ALIGN_MIN_SCORE = 0.6;
/** The best offset must beat every offset more than ALIGN_DISTINCT_MS away by this much. */
export const ALIGN_MIN_MARGIN = 0.05;
const ALIGN_DISTINCT_MS = 1_000, ALIGN_MIN_FRAMES = 30, ALIGN_PRIOR_SEARCH_MS = 30_000, ALIGN_BLIND_SEARCH_MS = 600_000, ALIGN_LEAD_MS = 5_000;
/** A prior outside this band is not a recording offset (e.g. a test or legacy zero clock origin). */
const PRIOR_MIN_MS = -60_000, PRIOR_MAX_MS = 6 * 60 * 60_000;
const SILENT_DB = -60, MAX_WINDOWS = 20_000;
/** Text bounds, enforced when a result is accepted and again at publication. */
export const MAX_WINDOW_TEXT = 8_000;

export interface GapSpan { start_ms: number; end_ms: number; speaker_name: string; speaker_key: string; attribution: "provisional" | "unknown"; parts: GapPart[] }
export interface GapSpec { kind: "gap_fill"; spans: GapSpan[] }
export interface GapWindow { span: number; start_ms: number; end_ms: number }
export type AlignWindowStatus = "voiced" | "silent" | "missing";
/** Voiced windows carry the planned 100 ms levels (dB, rounded) of their cut, checked again at cut time. */
export interface GapAlignResult { offset_ms: number; score: number; duration_ms: number; windows: Array<{ status: AlignWindowStatus; energy_db?: number; levels?: number[] }> }
export interface GapChunkWindow extends GapWindow { index: number; from: number; to: number; cut_start_ms: number; levels: number[] }
export interface GapChunkSpec { kind: "gap_chunk"; windows: GapChunkWindow[] }
/** `mismatch`: the cut's audio did not match the aligned plan, so it was never sent (listed as a gap). */
export interface GapWindowText { index: number; status: "text" | "empty" | "mismatch"; text?: string; language?: string; segments?: TimedPiece[]; energy_dbfs?: number }
export interface GapChunkResult { model?: string; fallback?: boolean; windows: GapWindowText[] }

/** Named ranges keep their speaker; unresolved ones take the same-channel inference or Unknown. */
function speakerOf(range: AttributedRange, inferred: ReturnType<typeof inferUnresolvedSpeakers>): Pick<GapSpan, "speaker_name" | "speaker_key" | "attribution"> {
  if (range.attribution.source !== "unresolved" && range.speaker_name.trim()) return { speaker_name: range.speaker_name, speaker_key: nameKey(range.speaker_name), attribution: "provisional" };
  const guess = inferred.get(range.sequence);
  return guess ? { speaker_name: guess.name, speaker_key: nameKey(guess.name), attribution: "provisional" }
    : { speaker_name: "Unknown", speaker_key: `unresolved:${range.speaker_key}`, attribution: "unknown" };
}

/** Deterministic spans over the untranscribed parts, merged per speaker. */
export function gapSpec(manifest: AttributedManifest, parts: GapPart[]): GapSpec {
  const bySequence = new Map(manifest.ranges.map((range) => [range.sequence, range])), inferred = inferUnresolvedSpeakers(manifest);
  const sorted = parts.filter((part) => bySequence.has(part.sequence) && part.end_ms > part.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms || a.sequence - b.sequence || a.end_ms - b.end_ms);
  const open = new Map<string, GapSpan>(), spans: GapSpan[] = [];
  for (const part of sorted) {
    const speaker = speakerOf(bySequence.get(part.sequence)!, inferred);
    const current = open.get(speaker.speaker_key);
    const copy = { sequence: part.sequence, start_ms: part.start_ms, end_ms: part.end_ms };
    if (current && part.start_ms - current.end_ms <= GAP_MERGE_MS) { current.end_ms = Math.max(current.end_ms, part.end_ms); current.parts.push(copy); }
    else { const span = { start_ms: part.start_ms, end_ms: part.end_ms, ...speaker, parts: [copy] }; open.set(speaker.speaker_key, span); spans.push(span); }
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

/** 100 ms RMS levels (dB) of PCM held in memory; `recordingLevels` streams the same from a file. */
export function frameLevels(samples: Int16Array, sampleRate: number): Float64Array {
  const size = Math.round(sampleRate * FRAME_MS / 1000), count = Math.floor(samples.length / size), levels = new Float64Array(count);
  for (let frame = 0; frame < count; frame++) {
    let sum = 0;
    for (let i = frame * size; i < (frame + 1) * size; i++) { const value = samples[i]! / 32768; sum += value * value; }
    levels[frame] = sum > 0 ? Math.max(-120, 10 * Math.log10(sum / size)) : -120;
  }
  return levels;
}

/** Voiced 100 ms frames: level ≥ max(−50 dB, 10th percentile + 12 dB). */
export function voicedFrames(levels: Float64Array): Uint8Array {
  const sorted = Float64Array.from(levels).sort();
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
 * Verified recording offset (ms), recording time = meeting time + offset, or null. The score is
 * the share of manifest speech frames that land on voiced recording frames; the prior only
 * centres the search. Too little speech, a weak best score, or a runner-up offset more than a
 * second away within ALIGN_MIN_MARGIN (periodic or continuous audio) is unverified.
 */
export function alignRecording(manifest: AttributedManifest, voiced: Uint8Array, priorMs: number | null): { offset_ms: number; score: number } | null {
  const frames = new Set<number>();
  for (const range of manifest.ranges) for (let f = Math.floor(range.start_ms / FRAME_MS); f < Math.ceil(range.end_ms / FRAME_MS); f++) frames.add(f);
  const speech = [...frames];
  if (speech.length < ALIGN_MIN_FRAMES || !voiced.length) return null;
  const centre = priorMs === null ? 0 : Math.round(priorMs / FRAME_MS);
  const [lo, hi] = priorMs === null ? [-ALIGN_LEAD_MS / FRAME_MS, ALIGN_BLIND_SEARCH_MS / FRAME_MS] : [centre - ALIGN_PRIOR_SEARCH_MS / FRAME_MS, centre + ALIGN_PRIOR_SEARCH_MS / FRAME_MS];
  const scores = new Float64Array(hi - lo + 1);
  let best = -1;
  for (let k = lo; k <= hi; k++) {
    let hits = 0;
    for (const f of speech) if (voiced[f + k] === 1) hits++;
    const score = hits / speech.length, i = k - lo;
    scores[i] = score;
    if (best < 0 || score > scores[best]! || (score === scores[best]! && Math.abs(k - centre) < Math.abs(best + lo - centre))) best = i;
  }
  const top = scores[best]!;
  if (top < ALIGN_MIN_SCORE) return null;
  const distinct = ALIGN_DISTINCT_MS / FRAME_MS;
  for (let i = 0; i < scores.length; i++) if (Math.abs(i - best) > distinct && scores[i]! > top - ALIGN_MIN_MARGIN) return null;
  return { offset_ms: (best + lo) * FRAME_MS, score: Math.round(top * 1000) / 1000 };
}

/**
 * Padded recording cut for a window, in recording seconds, widened to whole 100 ms level frames so
 * its planned and measured envelopes compare frame for frame; null when outside the recording.
 */
export function recordingCut(window: GapWindow, offsetMs: number, durationSec: number): { from: number; to: number; cutStartMs: number } | null {
  const lastFrame = Math.floor(durationSec * 1000 / FRAME_MS);
  const first = Math.max(0, Math.floor((window.start_ms - GAP_PAD_MS + offsetMs) / FRAME_MS)), last = Math.min(lastFrame, Math.ceil((window.end_ms + GAP_PAD_MS + offsetMs) / FRAME_MS));
  if (last - first < 2) return null;
  return { from: first * FRAME_MS / 1000, to: last * FRAME_MS / 1000, cutStartMs: first * FRAME_MS - offsetMs };
}

/** Mean power (dB) of the 100 ms levels covering [from, to) recording seconds. */
function cutLevel(levels: Float64Array, from: number, to: number): number {
  let sum = 0, count = 0;
  for (let f = Math.floor(from * 1000 / FRAME_MS); f < Math.ceil(to * 1000 / FRAME_MS) && f < levels.length; f++) { sum += 10 ** (levels[f]! / 10); count++; }
  return count && sum > 0 ? Math.round(10 * Math.log10(sum / count) * 10) / 10 : -120;
}

/** The align step's result: every window classified against the recording at a verified offset. */
export function planAlignment(spec: GapSpec, levels: Float64Array, durationSec: number, alignment: { offset_ms: number; score: number }): GapAlignResult {
  const windows = gapWindows(spec).map((window) => {
    const cut = recordingCut(window, alignment.offset_ms, durationSec);
    if (!cut) return { status: "missing" as const };
    const energy_db = cutLevel(levels, cut.from, cut.to);
    if (energy_db < SILENT_DB) return { status: "silent" as const, energy_db };
    const first = Math.round(cut.from * 1000 / FRAME_MS), last = Math.round(cut.to * 1000 / FRAME_MS);
    return { status: "voiced" as const, energy_db, levels: Array.from(levels.subarray(first, last), (level) => Math.round(level)) };
  });
  return { ...alignment, duration_ms: Math.round(durationSec * 1000), windows };
}

/** Planned frames compared; measured below this floor counts as the floor (both near silence). */
const ENVELOPE_FLOOR_DB = -80, ENVELOPE_MAX_DIFF_DB = 6, ENVELOPE_MIN_R = 0.5, ENVELOPE_FLAT_STD_DB = 3, ENVELOPE_MIN_COVER = 0.9;
/**
 * Whether a cut's measured 100 ms envelope is the moment alignment planned (TC-758): the mean
 * absolute level difference must be small and, where the plan has structure, the shapes must
 * correlate. The same decode on the same clock agrees within about a decibel; audio from another
 * moment (a shifted clock, a changed file) does not, and is never sent.
 */
export function envelopeMatch(planned: number[], measured: ArrayLike<number>): { match: boolean; diff_db: number; r: number | null } {
  const n = Math.min(planned.length, measured.length);
  if (!n || n < planned.length * ENVELOPE_MIN_COVER) return { match: false, diff_db: Infinity, r: null };
  const a = Array.from({ length: n }, (_, i) => Math.max(ENVELOPE_FLOOR_DB, planned[i]!)), b = Array.from({ length: n }, (_, i) => Math.max(ENVELOPE_FLOOR_DB, measured[i]!));
  const diff = a.reduce((sum, value, i) => sum + Math.abs(value - b[i]!), 0) / n;
  const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length, ma = mean(a), mb = mean(b);
  const sa = Math.sqrt(mean(a.map((x) => (x - ma) ** 2))), sb = Math.sqrt(mean(b.map((x) => (x - mb) ** 2)));
  const r = sa > 0 && sb > 0 ? mean(a.map((x, i) => (x - ma) * (b[i]! - mb))) / (sa * sb) : null;
  const shaped = sa >= ENVELOPE_FLAT_STD_DB;
  return { match: diff <= ENVELOPE_MAX_DIFF_DB && (!shaped || (r !== null && r >= ENVELOPE_MIN_R)), diff_db: Math.round(diff * 10) / 10, r: r === null ? null : Math.round(r * 1000) / 1000 };
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
/** Untrusted stored align result; only a verified alignment over exactly the spec's windows is usable. */
export function validAlignResult(spec: GapSpec, value: unknown): GapAlignResult | null {
  const result = value as GapAlignResult, expected = gapWindows(spec).length;
  if (!result || typeof result !== "object" || !finite(result.offset_ms) || !finite(result.score) || result.score < ALIGN_MIN_SCORE || !finite(result.duration_ms) || result.duration_ms <= 0
      || !Array.isArray(result.windows) || result.windows.length !== expected || expected > MAX_WINDOWS
      || result.windows.some((window) => !window || !["voiced", "silent", "missing"].includes(window.status)
        || (window.status === "voiced" && (!Array.isArray(window.levels) || window.levels.length > 400 || !window.levels.every(finite))))) return null;
  return result;
}

/** Voiced windows, cut at the verified offset, grouped into bounded paid rows. */
export function gapChunks(spec: GapSpec, align: GapAlignResult): GapChunkSpec[] {
  const voiced: GapChunkWindow[] = [];
  for (const [index, window] of gapWindows(spec).entries()) {
    if (align.windows[index]?.status !== "voiced") continue;
    const cut = recordingCut(window, align.offset_ms, align.duration_ms / 1000);
    if (cut) voiced.push({ index, ...window, from: cut.from, to: cut.to, cut_start_ms: cut.cutStartMs, levels: align.windows[index]!.levels ?? [] });
  }
  const chunks: GapChunkSpec[] = [];
  for (let i = 0; i < voiced.length; i += GAP_CHUNK_WINDOWS) chunks.push({ kind: "gap_chunk", windows: voiced.slice(i, i + GAP_CHUNK_WINDOWS) });
  return chunks;
}

type Kept = { start: number; end: number; text: string; language: string | null };
/**
 * What one recording window yielded, on the meeting clock: kept text, and the parts of the window
 * that held possible speech but no kept text (an empty answer, text dropped as not-speech over
 * non-silent audio, or text without usable pieces). Silent-audio drops are not speech and not gaps.
 */
export function windowCoverage(window: GapChunkWindow, result: GapWindowText | undefined): { kept: Kept[]; uncovered: Array<[number, number]> } {
  const whole: Array<[number, number]> = [[window.start_ms, window.end_ms]];
  if (!result || result.status !== "text" || typeof result.text !== "string" || !result.text.trim()) return { kept: [], uncovered: whole };
  const language = result.language ?? null, lo = window.start_ms / 1000, hi = window.end_ms / 1000;
  const timed = validPieces(result);
  if (!timed) {
    const reason = hallucinationReason(result.text, { untimed: true, audioSec: hi - lo, ...(finite(result.energy_dbfs) ? { energy_dbfs: result.energy_dbfs } : {}) });
    if (reason) return { kept: [], uncovered: reason === "silent" ? [] : whole };
    return { kept: [{ start: lo, end: hi, text: result.text.trim(), language }], uncovered: [] };
  }
  const kept: Kept[] = [], uncovered: Array<[number, number]> = [];
  let speech = false;
  for (const piece of timed) {
    if (!piece.text.trim()) continue;
    speech = true;
    // Offsets are into the padded cut; the padding belongs to neighbouring speech, so clamp to the window.
    const start = Math.min(hi, Math.max(lo, window.cut_start_ms / 1000 + piece.start)), end = Math.min(hi, Math.max(start, window.cut_start_ms / 1000 + piece.end));
    const reason = hallucinationReason(piece.text, pieceEvidence(piece));
    if (reason) { if (reason !== "silent") uncovered.push([Math.round(start * 1000), Math.round(Math.max(end, Math.min(hi, start + 0.2)) * 1000)]); continue; }
    kept.push({ start, end, text: piece.text.trim(), language });
  }
  return speech ? { kept, uncovered } : { kept: [], uncovered: whole };
}

/**
 * Accepts one provider answer for a window at processing time with the same bounds publication
 * enforces (TC-758): over-long or malformed text, an unsafe language, or nothing kept after the
 * not-speech filter makes the window `empty`, which feeds the retry and, failing that, a listed gap.
 */
export function acceptWindowText(window: GapChunkWindow, response: { text: string; language?: string; segments?: TimedPiece[]; energy_dbfs?: number }): GapWindowText {
  const text = typeof response.text === "string" ? response.text.trim() : "";
  const empty: GapWindowText = { index: window.index, status: "empty", ...(finite(response.energy_dbfs) ? { energy_dbfs: response.energy_dbfs } : {}) };
  if (!text || text.length > MAX_WINDOW_TEXT) return empty;
  const segments = response.segments ? validPieces(response) : null;
  const language = safeTinfoilLanguage(response.language);
  const candidate: GapWindowText = { index: window.index, status: "text", text, ...(language ? { language } : {}), ...(segments ? { segments } : {}),
    ...(finite(response.energy_dbfs) ? { energy_dbfs: response.energy_dbfs } : {}) };
  return windowCoverage(window, candidate).kept.length ? candidate : empty;
}

/** Untrusted stored chunk result: exactly the chunk's windows, within the acceptance bounds. */
export function validChunkResult(chunk: GapChunkSpec, value: unknown): GapChunkResult | null {
  const result = value as GapChunkResult;
  if (!result || typeof result !== "object" || !Array.isArray(result.windows) || result.windows.length !== chunk.windows.length) return null;
  for (const [i, window] of result.windows.entries()) {
    if (!window || window.index !== chunk.windows[i]!.index || !["text", "empty", "mismatch"].includes(window.status)) return null;
    if (window.status === "text" && (typeof window.text !== "string" || !window.text.trim() || window.text.length > MAX_WINDOW_TEXT
        || (window.language !== undefined && !safeTinfoilLanguage(window.language)) || (window.energy_dbfs !== undefined && !finite(window.energy_dbfs)))) return null;
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
 * Publishable recording pieces and the captured speech still untranscribed. A window counts as
 * covered only where the recording yielded kept text for it (or the text was dropped over silent
 * audio); silent, missing, empty, unaligned, unverified or exhausted windows leave their parts
 * listed as gaps. `texts` holds verified chunk results by window index.
 */
export function gapOutcome(spec: GapSpec, chunks: GapChunkSpec[], texts: Map<number, GapWindowText>): { pieces: RawPiece[]; gaps: TranscriptGap[]; recording_ms: number; gap_ms: number } {
  const pieces: RawPiece[] = [];
  const covered = spec.spans.map((): Array<[number, number]> => []);
  for (const chunk of chunks) for (const window of chunk.windows) {
    const span = spec.spans[window.span]!;
    const { kept, uncovered } = windowCoverage(window, texts.get(window.index));
    if (!kept.length && uncovered.length) continue;
    covered[window.span]!.push(...subtract([window.start_ms, window.end_ms], union(uncovered)));
    for (const piece of kept) pieces.push({ ...piece, speaker: span.speaker_name, speakerKey: span.speaker_key, attribution: span.attribution as SpeakerAttribution, origin: "recording" });
  }
  const gaps: TranscriptGap[] = [];
  let recording = 0, gap = 0;
  for (const [index, span] of spec.spans.entries()) {
    const cover = union(covered[index]!);
    for (const interval of union(span.parts.map((part) => [part.start_ms, part.end_ms] as [number, number]))) {
      recording += cover.reduce((sum, c) => sum + overlap(interval, c), 0);
      for (const [start, end] of subtract(interval, cover)) { gap += end - start; gaps.push({ start: start / 1000, end: end / 1000, speaker_name: span.speaker_name }); }
    }
  }
  gaps.sort((a, b) => a.start - b.start || a.end - b.end);
  return { pieces, gaps, recording_ms: Math.round(recording), gap_ms: Math.round(gap) };
}
