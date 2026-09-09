import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeToPcm, pcmToWav, PCM_RATE, type Pcm16 } from "../../src/providers/transcription/audio.ts";

function toneSamples() {
  return Int16Array.from({ length: 6 * PCM_RATE }, (_, i) =>
    Math.round(8000 * Math.sin(2 * Math.PI * (i < 3 * PCM_RATE ? 440 : 880) * i / PCM_RATE)));
}

function rms(pcm: Pcm16, start: number, end: number) {
  const view = pcm.samples.subarray(Math.round(start * pcm.sampleRate), Math.round(end * pcm.sampleRate));
  return Math.sqrt(view.reduce((total, sample) => total + sample ** 2, 0) / view.length);
}

function frequency(pcm: Pcm16, start: number, end: number) {
  const from = Math.round(start * pcm.sampleRate);
  const to = Math.round(end * pcm.sampleRate);
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if (pcm.samples[i - 1]! <= 0 && pcm.samples[i]! > 0) crossings++;
  return crossings / (end - start);
}

test("PCM decoding leaves an ordinary WAV sample-exact", async () => {
  const samples = toneSamples();
  const decoded = await decodeToPcm(pcmToWav(samples, PCM_RATE));
  expect(decoded.durationSec).toBe(6);
  expect(Buffer.from(decoded.samples.buffer).equals(Buffer.from(samples.buffer))).toBe(true);
});

for (const origin of [0, 12_345]) {
  test(`Opus decoding preserves a timestamp gap and later speaker audio (container origin ${origin}s)`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ptx-clock-test-"));
    try {
      const input = join(dir, "input.wav");
      const encoded = join(dir, "gap.webm");
      await Bun.write(input, pcmToWav(toneSamples(), PCM_RATE));
      // Remove packets, not time: second 2-3 is absent, and the 880 Hz speaker begins at 3s.
      const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", input, "-af", `aselect=not(between(t\\,2\\,3)),asetpts=PTS+${origin}/TB`,
        "-c:a", "libopus", encoded], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      const [error, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      if (code) throw new Error(error);
      const pcm = await decodeToPcm(new Uint8Array(await Bun.file(encoded).arrayBuffer()));
      expect(Math.abs(pcm.durationSec - 6)).toBeLessThan(0.03);
      expect(rms(pcm, 2.2, 2.8)).toBe(0);
      expect(Math.abs(frequency(pcm, 0.5, 1.5) - 440)).toBeLessThan(4);
      expect(Math.abs(frequency(pcm, 3.5, 4.5) - 880)).toBeLessThan(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
