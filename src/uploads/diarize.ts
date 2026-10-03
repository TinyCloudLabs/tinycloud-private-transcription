import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { wavHeader } from "../providers/transcription/audio.ts";
import { PCM_RATE } from "./audio.ts";
import type { BatchConfig } from "./config.ts";
import { splitLong, VAD, type Region } from "./vad.ts";

/**
 * Speaker diarization for `diarize: true` jobs: sherpa-onnx (pyannote segmentation-3.0 + a speaker-embedding model,
 * fast clustering) over the 16 kHz mono PCM, turned into speaker turns sized for one provider request each. Model,
 * threshold and sizing come from docs/diarization-benchmark.md.
 */
export const DIARIZATION = {
  /** Clustering distance threshold for the shipped embedding model (NeMo TitaNet-S); larger means fewer speakers. */
  clusterThreshold: 1.0,
  /** Result ids are speaker_0 … speaker_31. */
  maxSpeakers: 32,
  /** Same-speaker turns closer than this are one turn (the VAD's merge gap). */
  mergeGapMs: VAD.mergeGapMs,
  /** Shorter turns are folded into an adjacent turn (the VAD's minimum region). */
  minTurnMs: VAD.minMs,
  /** Padding into the silence around a turn, never into a neighbouring turn. */
  padMs: VAD.padMs,
  /** onnxruntime threads per stage, as benchmarked: all of a tdx.large's 4 vCPUs, never more. */
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

/**
 * The diarizer of this process, or null (capabilities then report `diarization: false`) unless it is enabled and the
 * install under `dir` is complete: `diarize` (the sherpa-onnx-offline-speaker-diarization launcher, see Dockerfile),
 * `models/segmentation.onnx` and `models/embedding.onnx`.
 */
export function diarizerFromConfig(config: BatchConfig["diarization"]): Diarizer | null {
  if (!config.enabled) return null;
  const files = {
    command: join(config.dir, "diarize"),
    segmentation: join(config.dir, "models", "segmentation.onnx"),
    embedding: join(config.dir, "models", "embedding.onnx"),
  };
  return Object.values(files).every((path) => existsSync(path)) ? new SherpaDiarizer(files) : null;
}

export class SherpaDiarizer implements Diarizer {
  constructor(private readonly files: { command: string; segmentation: string; embedding: string }) {}

  async diarize(pcmPath: string, signal: AbortSignal): Promise<SpeakerSegment[]> {
    // The CLI reads only a seekable WAV file, so one is written beside the PCM for the duration of the run.
    const wav = `${pcmPath}.wav`;
    try {
      await writeFile(wav, wavHeader(Bun.file(pcmPath).size, PCM_RATE), { mode: 0o600 });
      await pipeline(createReadStream(pcmPath), createWriteStream(wav, { flags: "a" }));
      const segments = await this.run(wav, signal, null);
      // An over-split clustering would need ids past speaker_31: cluster again into exactly the maximum instead.
      if (new Set(segments.map((segment) => segment.speaker)).size <= DIARIZATION.maxSpeakers) return segments;
      return await this.run(wav, signal, DIARIZATION.maxSpeakers);
    } finally {
      await rm(wav, { force: true });
    }
  }

  private async run(wav: string, signal: AbortSignal, clusters: number | null): Promise<SpeakerSegment[]> {
    if (signal.aborted) throw new Error("diarization aborted");
    const threads = String(Math.min(availableParallelism(), DIARIZATION.maxThreads));
    const proc = Bun.spawn([
      this.files.command,
      `--segmentation.pyannote-model=${this.files.segmentation}`,
      `--embedding.model=${this.files.embedding}`,
      `--segmentation.num-threads=${threads}`,
      `--embedding.num-threads=${threads}`,
      clusters === null ? `--clustering.cluster-threshold=${DIARIZATION.clusterThreshold}` : `--clustering.num-clusters=${clusters}`,
      wav,
    ], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const kill = () => proc.kill();
    signal.addEventListener("abort", kill, { once: true });
    try {
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (signal.aborted) throw new Error("diarization aborted");
      if (code !== 0) throw new Error(`diarizer exited ${code}`);
      return parseSegments(stdout);
    } finally {
      signal.removeEventListener("abort", kill);
    }
  }
}

/** The CLI's `<start s> -- <end s> speaker_<n>` lines; the configuration echo and anything else is ignored. */
export function parseSegments(stdout: string): SpeakerSegment[] {
  const segments: SpeakerSegment[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^(\d+(?:\.\d+)?) -- (\d+(?:\.\d+)?) speaker_(\d+)$/.exec(line.trim());
    if (match) segments.push({ startMs: Math.round(Number(match[1]) * 1000), endMs: Math.round(Number(match[2]) * 1000), speaker: Number(match[3]) });
  }
  return segments;
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
