import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { PCM_BYTES_PER_SECOND, PCM_RATE } from "./audio.ts";
import type { BatchConfig } from "./config.ts";
import { splitLong, VAD, type Region } from "./vad.ts";

/**
 * Speaker diarization for `diarize: true` jobs: sherpa-onnx (pyannote segmentation-3.0 + NeMo TitaNet-S embeddings,
 * fast clustering) over overlapping windows of the 16 kHz mono PCM, one process per window, so memory does not grow
 * with the recording. Local speakers of each window are linked to global speakers by the overlap with the previous
 * window and by their voice embeddings, then turned into speaker turns sized for one provider request each. Model,
 * thresholds, window sizing and measurements: docs/diarization-benchmark.md.
 */
export const DIARIZATION = {
  /** sherpa-onnx clustering distance threshold within a window (TitaNet-S); larger means fewer speakers. */
  clusterThreshold: 1.0,
  /** Result ids are speaker_0 … speaker_31. */
  maxSpeakers: 32,
  /** Longest window handed to one diarizer process. */
  windowMs: 600_000,
  /** Audio shared by consecutive windows: diarized twice, attributed once (each window keeps up to the middle). */
  overlapMs: 60_000,
  /** A local speaker joins the most similar global speaker at or above this cosine similarity of voice embeddings. */
  linkSimilarity: 0.6,
  /**
   * Each global speaker takes one local speaker per window, except at or above this similarity: a window's clustering
   * often splits one voice in two, and both halves then belong to the same global speaker.
   */
  sameVoiceSimilarity: 0.8,
  /**
   * Overlap evidence: a local speaker who talks at the same time as a global speaker for at least anchorMs of the
   * overlap with the previous window (the same voice diarized by both windows) adds anchorBonus × the share of its
   * overlap speech they have in common to that pair's similarity.
   */
  anchorBonus: 0.1,
  anchorMs: 2_000,
  /** After the last window, global speakers never seen in the same window merge at or above this similarity. */
  mergeSimilarity: 0.7,
  /** Same-speaker turns closer than this are one turn (the VAD's merge gap). */
  mergeGapMs: VAD.mergeGapMs,
  /** Shorter turns are folded into an adjacent turn (the VAD's minimum region). */
  minTurnMs: VAD.minMs,
  /** Padding into the silence around a turn, never into a neighbouring turn. */
  padMs: VAD.padMs,
  /** onnxruntime threads per stage: the CPUs available to the worker, at most 4. */
  maxThreads: 4,
};

/** One diarizer segment; segments of different speakers may overlap. */
export interface SpeakerSegment {
  startMs: number;
  endMs: number;
  speaker: number;
}

export interface Turn extends Region {
  speaker: number;
}

export interface Diarizer {
  /** Speaker segments of a 16 kHz mono s16le PCM file. `signal` kills the diarizer process. */
  diarize(pcmPath: string, signal: AbortSignal): Promise<SpeakerSegment[]>;
}

/** A window of the recording; it attributes speech in [ownStartMs, ownEndMs) and only diarizes the rest for linking. */
export interface Window {
  startMs: number;
  endMs: number;
  ownStartMs: number;
  ownEndMs: number;
}

/** A window's speakers: segments in recording time with window-local speaker ids, and each id's voice embedding. */
export interface WindowDiarization {
  segments: SpeakerSegment[];
  /** `embedding` is null when the speaker had no speech long enough to embed (then `seconds` is 0). */
  speakers: { speaker: number; seconds: number; embedding: Float32Array | null }[];
}

export type WindowRunner = (pcmPath: string, window: Window, signal: AbortSignal) => Promise<WindowDiarization>;

/**
 * Windows of at most `windowMs` covering [0, totalMs), consecutive ones sharing `overlapMs`, all the same length (so the
 * last one is never a short tail). Each window owns its span up to the middle of each overlap.
 */
export function planWindows(totalMs: number, windowMs = DIARIZATION.windowMs, overlapMs = DIARIZATION.overlapMs): Window[] {
  if (totalMs <= 0) return [];
  if (totalMs <= windowMs) return [{ startMs: 0, endMs: totalMs, ownStartMs: 0, ownEndMs: totalMs }];
  const count = Math.ceil((totalMs - overlapMs) / (windowMs - overlapMs));
  const step = (totalMs - overlapMs) / count;
  const windows: Window[] = [];
  for (let i = 0; i < count; i++) {
    const startMs = Math.round(i * step);
    const endMs = i === count - 1 ? totalMs : Math.round(i * step + step + overlapMs);
    windows.push({
      startMs,
      endMs,
      ownStartMs: i === 0 ? 0 : startMs + Math.round(overlapMs / 2),
      ownEndMs: i === count - 1 ? totalMs : Math.round((i + 1) * step) + Math.round(overlapMs / 2),
    });
  }
  return windows;
}

export type LinkLimits = Pick<typeof DIARIZATION, "linkSimilarity" | "sameVoiceSimilarity" | "anchorBonus" | "anchorMs" | "mergeSimilarity" | "maxSpeakers">;

interface GlobalSpeaker {
  /** Sum of local embeddings weighted by embedded seconds; its direction is the centroid. */
  sum: Float64Array | null;
  seconds: number;
  /** Speaking time of its segments. */
  speechMs: number;
  /** Windows it was heard in. Two speakers heard in one window were told apart there, so the merge pass keeps them apart. */
  windows: Set<number>;
  /** Union-find parent after the merge pass. */
  parent: number;
}

/**
 * Links each window's local speakers to global speakers, in window order:
 * 1. evidence for local speaker l and global speaker g: the cosine similarity of l's embedding to g's centroid, and the
 *    time l and g speak together in the overlap with the previous window (the same audio, diarized by both windows);
 * 2. the pair's score is the similarity plus anchorBonus × the share of l's overlap speech it shares with g (when
 *    >= anchorMs); l joins the g of its best score >= linkSimilarity, best pairs first, each local speaker once and
 *    each global speaker once per window unless the score is >= sameVoiceSimilarity. A local without an embedding
 *    joins the g it shares at least half its overlap speech with. Otherwise l becomes a new global speaker;
 * 3. g's centroid takes in l's embedding, weighted by embedded seconds;
 * after the last window (`finish`), global speakers never heard in the same window are merged while their centroids
 * are >= mergeSimilarity apart, most similar first; then, past maxSpeakers, the speaker with the least speech joins
 * its most similar speaker (excess speakers are small clusters; the main voices stay apart).
 */
export class SpeakerLinker {
  constructor(private readonly limits: LinkLimits = DIARIZATION) {}

  private readonly speakers: GlobalSpeaker[] = [];
  /** Every window's segments with global speaker ids, before the merge pass. */
  private readonly placed: { window: Window; segments: SpeakerSegment[] }[] = [];

  /** Adds the next window; returns its local → global speaker map. */
  add(window: Window, result: WindowDiarization): Map<number, number> {
    const index = this.placed.length;
    const previous = this.placed.at(-1);
    const locals = [...new Set([...result.segments.map((s) => s.speaker), ...result.speakers.map((s) => s.speaker)])].sort((a, b) => a - b);
    const embedding = new Map(result.speakers.map((s) => [s.speaker, s]));

    // Overlap evidence: shared speaking time of (local, global) in [window.startMs, previous.endMs).
    const shared = new Map<string, number>();
    const talk = new Map<number, number>();
    if (previous) {
      const from = window.startMs;
      const to = Math.min(previous.window.endMs, window.endMs);
      const before = previous.segments.filter((s) => s.endMs > from && s.startMs < to);
      for (const local of result.segments) {
        const a = Math.max(local.startMs, from);
        const b = Math.min(local.endMs, to);
        if (b <= a) continue;
        talk.set(local.speaker, (talk.get(local.speaker) ?? 0) + b - a);
        for (const other of before) {
          const both = Math.min(b, other.endMs) - Math.max(a, other.startMs);
          if (both > 0) shared.set(`${local.speaker}:${other.speaker}`, (shared.get(`${local.speaker}:${other.speaker}`) ?? 0) + both);
        }
      }
    }

    const candidates: { local: number; global: number; score: number }[] = [];
    for (const local of locals) {
      const vector = embedding.get(local)?.embedding ?? null;
      for (let global = 0; global < this.speakers.length; global++) {
        const together = shared.get(`${local}:${global}`) ?? 0;
        const share = together >= this.limits.anchorMs ? Math.min(1, together / talk.get(local)!) : 0;
        const sum = this.speakers[global]!.sum;
        if (vector && sum) {
          const score = cosine(vector, sum) + this.limits.anchorBonus * share;
          if (score >= this.limits.linkSimilarity) candidates.push({ local, global, score });
        } else if (share >= 0.5) {
          candidates.push({ local, global, score: -2 }); // no voice evidence: the overlap alone, after every cosine
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score);

    const map = new Map<number, number>();
    const taken = new Set<number>();
    for (const c of candidates) {
      if (map.has(c.local) || (taken.has(c.global) && c.score < this.limits.sameVoiceSimilarity)) continue;
      map.set(c.local, c.global);
      taken.add(c.global);
    }
    for (const local of locals) {
      if (!map.has(local)) {
        map.set(local, this.speakers.length);
        this.speakers.push({ sum: null, seconds: 0, speechMs: 0, windows: new Set(), parent: this.speakers.length });
      }
      const global = this.speakers[map.get(local)!]!;
      global.windows.add(index);
      const info = embedding.get(local);
      if (info?.embedding && info.seconds > 0) {
        global.sum ??= new Float64Array(info.embedding.length);
        for (let d = 0; d < info.embedding.length; d++) global.sum[d]! += info.embedding[d]! * info.seconds;
        global.seconds += info.seconds;
      }
    }
    for (const segment of result.segments) this.speakers[map.get(segment.speaker)!]!.speechMs += segment.endMs - segment.startMs;
    this.placed.push({ window, segments: result.segments.map((s) => ({ ...s, speaker: map.get(s.speaker)! })) });
    return map;
  }

  /** The merge passes, then every window's segments cut to the span it owns, with final global speaker ids. */
  finish(): SpeakerSegment[] {
    const root = (i: number): number => {
      while (this.speakers[i]!.parent !== i) i = this.speakers[i]!.parent;
      return i;
    };
    const roots = () => this.speakers.map((_, i) => i).filter((i) => root(i) === i);
    const similarity = (a: number, b: number) => {
      const [x, y] = [this.speakers[a]!.sum, this.speakers[b]!.sum];
      return x && y ? cosine(x, y) : -2;
    };
    const join = (into: number, from: number) => {
      const [a, b] = [this.speakers[into]!, this.speakers[from]!];
      if (b.sum) {
        a.sum ??= new Float64Array(b.sum.length);
        for (let d = 0; d < b.sum.length; d++) a.sum[d]! += b.sum[d]!;
      }
      a.seconds += b.seconds;
      a.speechMs += b.speechMs;
      for (const w of b.windows) a.windows.add(w);
      b.parent = into;
    };

    for (;;) {
      let best: { a: number; b: number; similarity: number } | null = null;
      const r = roots();
      for (let x = 0; x < r.length; x++) {
        for (let y = x + 1; y < r.length; y++) {
          const [a, b] = [r[x]!, r[y]!];
          if ([...this.speakers[a]!.windows].some((w) => this.speakers[b]!.windows.has(w))) continue;
          const value = similarity(a, b);
          if (value >= this.limits.mergeSimilarity && (!best || value > best.similarity)) best = { a, b, similarity: value };
        }
      }
      if (!best) break;
      join(best.a, best.b);
    }
    for (let r = roots(); r.length > this.limits.maxSpeakers; r = roots()) {
      const smallest = r.reduce((a, b) => (this.speakers[b]!.speechMs < this.speakers[a]!.speechMs ? b : a));
      const others = r.filter((i) => i !== smallest);
      join(others.reduce((a, b) => (similarity(smallest, b) > similarity(smallest, a) ? b : a)), smallest);
    }

    const out: SpeakerSegment[] = [];
    for (const { window, segments } of this.placed) {
      for (const s of segments) {
        const startMs = Math.max(s.startMs, window.ownStartMs);
        const endMs = Math.min(s.endMs, window.ownEndMs);
        if (endMs > startMs) out.push({ startMs, endMs, speaker: root(s.speaker) });
      }
    }
    return out.sort((a, b) => a.startMs - b.startMs || a.speaker - b.speaker);
  }
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : -1;
}

/** Diarizes a recording window by window, one at a time, and links the windows' speakers (see SpeakerLinker). */
export class WindowedDiarizer implements Diarizer {
  constructor(private readonly runWindow: WindowRunner) {}

  async diarize(pcmPath: string, signal: AbortSignal): Promise<SpeakerSegment[]> {
    const totalMs = Math.floor((Bun.file(pcmPath).size * 1000) / PCM_BYTES_PER_SECOND);
    const linker = new SpeakerLinker();
    for (const window of planWindows(totalMs)) {
      if (signal.aborted) throw new Error("diarization aborted");
      linker.add(window, await this.runWindow(pcmPath, window, signal));
    }
    return linker.finish();
  }
}

/**
 * The diarizer of this process, or null (capabilities then report `diarization: false`) unless it is enabled and the
 * install under `dir` is complete: `diarize` (the src/uploads/diarize-window.c launcher, see Dockerfile),
 * `models/segmentation.onnx`, `models/embedding.onnx` and `models/onnxruntime.config`.
 */
export function diarizerFromConfig(config: BatchConfig["diarization"]): Diarizer | null {
  if (!config.enabled) return null;
  const files = {
    command: join(config.dir, "diarize"),
    segmentation: join(config.dir, "models", "segmentation.onnx"),
    embedding: join(config.dir, "models", "embedding.onnx"),
    onnxruntime: join(config.dir, "models", "onnxruntime.config"),
  };
  return Object.values(files).every((path) => existsSync(path)) ? new WindowedDiarizer(sherpaWindowRunner(files)) : null;
}

/** Runs src/uploads/diarize-window.c on one window: a fresh process per window, so all of its memory is released. */
export function sherpaWindowRunner(files: { command: string; segmentation: string; embedding: string; onnxruntime: string }): WindowRunner {
  return async (pcmPath, window, signal) => {
    if (signal.aborted) throw new Error("diarization aborted");
    const startSample = Math.round((window.startMs * PCM_RATE) / 1000);
    const samples = Math.round((window.endMs * PCM_RATE) / 1000) - startSample;
    const proc = Bun.spawn([
      files.command, files.segmentation, files.embedding, files.onnxruntime, String(DIARIZATION.clusterThreshold),
      String(Math.min(availableParallelism(), DIARIZATION.maxThreads)), pcmPath, String(startSample), String(samples),
    ], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const kill = () => proc.kill();
    signal.addEventListener("abort", kill, { once: true });
    try {
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (signal.aborted) throw new Error("diarization aborted");
      if (code !== 0) throw new Error(`diarizer exited ${code}`);
      return parseWindowOutput(stdout, window.startMs);
    } finally {
      signal.removeEventListener("abort", kill);
    }
  };
}

/** diarize-window's `segment <start s> <end s> <id>` and `speaker <id> <seconds> <values…>` lines, in recording time. */
export function parseWindowOutput(stdout: string, offsetMs: number): WindowDiarization {
  const result: WindowDiarization = { segments: [], speakers: [] };
  for (const line of stdout.split("\n")) {
    const [kind, ...fields] = line.trim().split(" ");
    if (kind === "segment" && fields.length === 3) {
      result.segments.push({ startMs: offsetMs + Math.round(Number(fields[0]) * 1000), endMs: offsetMs + Math.round(Number(fields[1]) * 1000), speaker: Number(fields[2]) });
    } else if (kind === "speaker" && fields.length >= 2) {
      const values = fields.slice(2).map(Number);
      result.speakers.push({ speaker: Number(fields[0]), seconds: Number(fields[1]), embedding: values.length > 0 ? Float32Array.from(values) : null });
    }
  }
  const valid = (n: number) => Number.isFinite(n) && n >= 0;
  if (result.segments.some((s) => !valid(s.startMs) || !valid(s.endMs) || !Number.isInteger(s.speaker) || s.speaker < 0)
    || result.speakers.some((s) => !Number.isInteger(s.speaker) || !valid(s.seconds) || (s.embedding && s.embedding.some((v) => !Number.isFinite(v))))) {
    throw new Error("unreadable diarizer output");
  }
  return result;
}

/**
 * Speaker turns from diarizer segments, in time order and never overlapping (no audio is sent twice):
 * 1. every VAD frame inside some segment gets one speaker. The current speaker keeps the frame while still talking,
 *    so overlaps and interjections stay with the turn they interrupt; otherwise the earliest-starting segment wins.
 *    Frames outside every segment are not speech and are never sent;
 * 2. runs of one speaker less than 1 s apart are one turn;
 * 3. turns shorter than 0.4 s are folded into the nearer adjacent turn less than 1 s away (an isolated short turn is
 *    kept), and same-speaker neighbours are merged again;
 * 4. turns are padded by up to 0.25 s, never past the midpoint of the gap to a neighbour;
 * 5. turns longer than 30 s are cut at their quietest frame, as VAD regions are.
 */
export function speakerTurns(segments: readonly SpeakerSegment[], energies: Float64Array): Turn[] {
  const frameMs = VAD.frameMs;
  const totalMs = energies.length * frameMs;
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs || a.speaker - b.speaker);

  let turns: Turn[] = [];
  const active: SpeakerSegment[] = [];
  let next = 0;
  let current = -1;
  for (let frame = 0; frame < energies.length; frame++) {
    const center = frame * frameMs + frameMs / 2;
    while (next < sorted.length && sorted[next]!.startMs <= center) active.push(sorted[next++]!);
    for (let i = active.length - 1; i >= 0; i--) if (active[i]!.endMs <= center) active.splice(i, 1);
    if (active.length === 0) continue;
    if (!active.some((segment) => segment.speaker === current)) current = active[0]!.speaker;
    const startMs = frame * frameMs;
    const last = turns.at(-1);
    if (last && last.speaker === current && startMs - last.endMs < DIARIZATION.mergeGapMs) last.endMs = startMs + frameMs;
    else turns.push({ startMs, endMs: startMs + frameMs, speaker: current });
  }

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    if (turn.endMs - turn.startMs >= DIARIZATION.minTurnMs) continue;
    const gapBefore = i > 0 ? turn.startMs - turns[i - 1]!.endMs : Infinity;
    const gapAfter = i + 1 < turns.length ? turns[i + 1]!.startMs - turn.endMs : Infinity;
    if (Math.min(gapBefore, gapAfter) >= DIARIZATION.mergeGapMs) continue;
    if (gapBefore <= gapAfter) turns[i - 1]!.endMs = turn.endMs;
    else turns[i + 1]!.startMs = turn.startMs;
    turns.splice(i, 1);
    turns = mergeSameSpeaker(turns);
    i = -1; // the fold and the merge changed this turn's neighbours: rescan
  }

  return turns
    .map((turn, i) => ({
      speaker: turn.speaker,
      startMs: Math.max(turn.startMs - DIARIZATION.padMs, i > 0 ? Math.floor((turns[i - 1]!.endMs + turn.startMs) / 2) : 0),
      endMs: Math.min(turn.endMs + DIARIZATION.padMs, i + 1 < turns.length ? Math.floor((turn.endMs + turns[i + 1]!.startMs) / 2) : totalMs),
    }))
    .flatMap((turn) => splitLong(turn, energies).map((region) => ({ ...region, speaker: turn.speaker })));
}

function mergeSameSpeaker(turns: Turn[]): Turn[] {
  const merged: Turn[] = [];
  for (const turn of turns) {
    const last = merged.at(-1);
    if (last && last.speaker === turn.speaker && turn.startMs - last.endMs < DIARIZATION.mergeGapMs) last.endMs = Math.max(last.endMs, turn.endMs);
    else merged.push(turn);
  }
  return merged;
}
