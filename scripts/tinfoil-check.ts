/**
 * Live Tinfoil probe (confidential inference). Never prints the key.
 *
 *   TRANSCRIPTION_PROVIDER=tinfoil bun run scripts/tinfoil-check.ts                 # whole file: fixtures/alice.wav, ONE call (~11 s)
 *   TRANSCRIPTION_PROVIDER=tinfoil bun run scripts/tinfoil-check.ts --two-speakers  # per-turn: alice.wav ++ bob.wav with a
 *                                                                                    #   fake Vexa speaker timeline → TWO calls (~7 s + ~6 s)
 *   ... scripts/tinfoil-check.ts path/to/file.wav                                    # whole file, one call
 * Expect: text contains "brown fox" (and "Bob" in --two-speakers). Exit 1 otherwise.
 */
import { config } from "../src/config.ts";
import { decodeToPcm, pcmToWav, PCM_RATE } from "../src/providers/transcription/audio.ts";
import { TinfoilTranscriptionProvider } from "../src/providers/transcription/tinfoil.ts";
import { logger } from "../src/log.ts";

if (!config.tinfoil.apiKey) {
  console.error("TINFOIL_API_KEY is not set");
  process.exit(2);
}
const twoSpeakers = process.argv.includes("--two-speakers");
const file = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "fixtures/alice.wav";

let bytes: Uint8Array;
let vexaSegments: { start: number; end: number; text: string; language: string; speaker: string; completed: boolean }[] = [];
if (twoSpeakers) {
  const a = await decodeToPcm(new Uint8Array(await Bun.file("fixtures/alice.wav").arrayBuffer()));
  const b = await decodeToPcm(new Uint8Array(await Bun.file("fixtures/bob.wav").arrayBuffer()));
  const joined = new Int16Array(a.samples.length + b.samples.length);
  joined.set(a.samples, 0);
  joined.set(b.samples, a.samples.length);
  bytes = pcmToWav(joined, PCM_RATE);
  const o = a.durationSec;
  vexaSegments = [
    { start: 1.5, end: 6.0, text: "The quick brown fox jumps over the lazy dog.", language: "en", speaker: "Alice", completed: true },
    { start: 6.5, end: 8.1, text: "Hello from Alice.", language: "en", speaker: "Alice", completed: true },
    { start: o + 1.5, end: o + 3.25, text: "Good morning everyone, this is Bob.", language: "en", speaker: "Bob", completed: true },
    { start: o + 3.75, end: o + 7.35, text: "The meeting starts now.", language: "en", speaker: "Bob", completed: true },
  ];
} else {
  bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
}
console.log(`tinfoil-check: ${twoSpeakers ? "alice.wav ++ bob.wav (per-turn)" : file} (${bytes.length} bytes) → ${config.tinfoil.baseUrl} model=${config.tinfoil.model}`);
const provider = new TinfoilTranscriptionProvider({ ...config.tinfoil, segmentation: twoSpeakers ? "turns" : "whole", log: logger });
const t0 = Date.now();
const out = await provider.transcribe({
  meetingId: "mtg_tinfoil_check",
  language: "en",
  vexaSegments,
  fetchAudio: async () => ({ bytes, filename: "check.wav", contentType: "audio/wav" }),
});
console.log(JSON.stringify({ ms: Date.now() - t0, calls: provider.calls, stats: provider.lastStats, language: out.language, duration_seconds: out.duration_seconds, speakers: out.speakers, segments: out.segments, text: out.text }, null, 2));
const ok = /brown fox/i.test(out.text) && (!twoSpeakers || /Bob/i.test(out.text));
if (!ok) {
  console.error("FAIL: expected phrases not found in transcript");
  process.exit(1);
}
console.log(`OK (${provider.calls} Tinfoil call(s))`);
