import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeChannelToPcm, PCM_RATE } from "../../src/uploads/audio.ts";
import { frameEnergies, regionsFromEnergies, VAD, type Region } from "../../src/uploads/vad.ts";

/**
 * TC-1045: real narration (LibriVox, public domain) whose quietest frames sit near a steady −34 dBFS noise floor. The
 * VAD once set its threshold 12 dB above the 10th-percentile level, which on such audio kept only the loudest syllables:
 * ~29% of the recording reached the model, in every format whose codec keeps the noise floor.
 */
const NARRATION = join(import.meta.dir, "../../fixtures/librivox-art-of-war-30s.flac");
/** The upload formats ptx-batch accepts, encoded the way recorders and apps typically write them. */
const FORMATS: Record<string, string[]> = {
  "audio/mpeg": ["-ar", "44100", "-c:a", "libmp3lame", "-b:a", "64k", "x.mp3"],
  "audio/wav": ["-ar", "48000", "-c:a", "pcm_s16le", "x.wav"],
  "audio/ogg": ["-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "x.ogg"],
  "audio/mp4": ["-ar", "44100", "-c:a", "aac", "-b:a", "64k", "x.m4a"],
  "audio/webm": ["-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "x.webm"],
  "audio/flac": ["-c:a", "flac", "x.flac"],
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ptx-vad-coverage-"));
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

async function ffmpeg(args: string[]) {
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`ffmpeg failed: ${stderr}`);
}

/** The worker's own decode: 16 kHz mono s16le on disk. */
async function decode(input: string): Promise<string> {
  const pcm = join(dir, `${input.split("/").at(-1)}.pcm`);
  await decodeChannelToPcm(input, pcm, null, 7_200, new AbortController().signal);
  return pcm;
}

async function writePcm(name: string, samples: Int16Array): Promise<string> {
  const path = join(dir, name);
  await Bun.write(path, samples);
  return path;
}

/** Share of the 100 ms frames in [fromMs, toMs) whose centre lies inside some region. */
function coverage(regions: Region[], fromMs: number, toMs: number): number {
  let covered = 0, total = 0;
  for (let start = fromMs; start + VAD.frameMs <= toMs; start += VAD.frameMs) {
    const centre = start + VAD.frameMs / 2;
    total++;
    if (regions.some((r) => r.startMs <= centre && centre < r.endMs)) covered++;
  }
  return covered / total;
}

const regionsOf = async (pcm: string) => regionsFromEnergies(await frameEnergies(pcm));

/** Deterministic white noise at `dbfs` RMS (uniform samples: RMS = amplitude / √3). */
function noise(seconds: number, dbfs: number): Int16Array {
  const amplitude = 10 ** (dbfs / 20) * Math.sqrt(3) * 32_768;
  let seed = 1;
  return Int16Array.from({ length: seconds * PCM_RATE }, () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return Math.round((seed / 2 ** 31 * 2 - 1) * amplitude);
  });
}

describe("VAD coverage of real speech (TC-1045)", () => {
  test("continuous narration is kept whole, and every accepted format sends the same share of it", async () => {
    const shares: Record<string, number> = {};
    for (const [type, args] of Object.entries(FORMATS)) {
      const encoded = join(dir, `${type.replace("/", "-")}-${args.at(-1)!}`);
      await ffmpeg(["-i", NARRATION, "-ac", "1", ...args.slice(0, -1), encoded]);
      const pcm = await decode(encoded);
      const ms = Math.floor(Bun.file(pcm).size / (PCM_RATE * 2) * 10) * 100;
      shares[type] = Math.round(coverage(await regionsOf(pcm), 0, ms) * 1000) / 1000;
    }
    expect(Object.entries(shares).filter(([, share]) => share < 0.9)).toEqual([]);
    const values = Object.values(shares);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(0.02);
  }, 60_000);

  test("real pauses are still skipped: 1.5 s of silence every 8 s of narration is never sent", async () => {
    const speech = new Int16Array(await Bun.file(await decode(NARRATION)).arrayBuffer());
    const pieceSamples = 8 * PCM_RATE, gapSamples = 1.5 * PCM_RATE;
    const pieces = Math.ceil(speech.length / pieceSamples);
    const paused = new Int16Array(speech.length + (pieces - 1) * gapSamples);
    const gaps: [number, number][] = [];
    for (let i = 0; i < pieces; i++) {
      const at = i * (pieceSamples + gapSamples);
      paused.set(speech.subarray(i * pieceSamples, (i + 1) * pieceSamples), at);
      if (i < pieces - 1) gaps.push([(at + pieceSamples) / 16, (at + pieceSamples + gapSamples) / 16]);
    }
    const regions = await regionsOf(await writePcm("paused.pcm", paused));
    // Regions are padded 0.25 s into silence; the rest of every pause stays unsent.
    for (const [from, to] of gaps) expect({ gap: from, sent: coverage(regions, from + VAD.padMs, to - VAD.padMs) }).toEqual({ gap: from, sent: 0 });
    let speechFrames = 0, speechCovered = 0;
    const edges = [0, ...gaps.flat(), paused.length / 16];
    for (let i = 0; i < edges.length; i += 2) {
      const frames = Math.floor((edges[i + 1]! - edges[i]!) / VAD.frameMs);
      speechFrames += frames;
      speechCovered += coverage(regions, edges[i]!, edges[i + 1]!) * frames;
    }
    expect(speechCovered / speechFrames).toBeGreaterThanOrEqual(0.9);
  }, 30_000);

  test("30 s of −60 dBFS background before the narration is not sent", async () => {
    const speech = new Int16Array(await Bun.file(await decode(NARRATION)).arrayBuffer());
    const quiet = noise(30, -60);
    const joined = new Int16Array(quiet.length + speech.length);
    joined.set(quiet);
    joined.set(speech, quiet.length);
    const regions = await regionsOf(await writePcm("noise-then-speech.pcm", joined));
    expect(coverage(regions, 0, 30_000 - VAD.padMs)).toBe(0);
    expect(coverage(regions, 30_000, joined.length / 16)).toBeGreaterThanOrEqual(0.9);
  }, 30_000);
});
