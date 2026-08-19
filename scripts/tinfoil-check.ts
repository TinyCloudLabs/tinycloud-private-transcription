/**
 * Live Tinfoil probe (confidential inference): sends fixtures/alice.wav through
 * TinfoilTranscriptionProvider exactly as the worker would (no Vexa segments → speaker null) and
 * prints text / duration / language. One Tinfoil call (~11 s of audio).
 *
 *   TRANSCRIPTION_PROVIDER=tinfoil bun run scripts/tinfoil-check.ts   # reads .env
 * Expect: text contains "brown fox". Exit 1 otherwise. Never prints the key.
 */
import { config } from "../src/config.ts";
import { TinfoilTranscriptionProvider } from "../src/providers/transcription/tinfoil.ts";

const file = process.argv[2] ?? "fixtures/alice.wav";
if (!config.tinfoil.apiKey) {
  console.error("TINFOIL_API_KEY is not set");
  process.exit(2);
}
const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
console.log(`tinfoil-check: ${file} (${bytes.length} bytes) → ${config.tinfoil.baseUrl} model=${config.tinfoil.model}`);
const provider = new TinfoilTranscriptionProvider(config.tinfoil);
const t0 = Date.now();
const out = await provider.transcribe({
  meetingId: "mtg_tinfoil_check",
  language: "en",
  vexaSegments: [],
  fetchAudio: async () => ({ bytes, filename: "alice.wav", contentType: "audio/wav" }),
});
console.log(JSON.stringify({ ms: Date.now() - t0, language: out.language, duration_seconds: out.duration_seconds, segments: out.segments.length, text: out.text }, null, 2));
if (!/brown fox/i.test(out.text)) {
  console.error("FAIL: 'brown fox' not found in transcript");
  process.exit(1);
}
console.log("OK: 'brown fox' found");
