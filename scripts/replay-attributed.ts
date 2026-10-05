#!/usr/bin/env bun
/**
 * Operator replay of one Vexa meeting's retained attributed audio through a Tinfoil model (TC-745).
 * Read-only against Vexa and the ptx DB; writes the raw per-batch results as JSON to stdout.
 *
 *   bun scripts/replay-attributed.ts <vexaMeetingId> <model> [concurrency] > results.json
 */
import { TinfoilTranscriptionProvider } from "../src/providers/transcription/tinfoil.ts";
import { replayAttributedBatches } from "../src/eval/replay.ts";

const [idArg, model, concurrencyArg] = process.argv.slice(2);
const vexaMeetingId = Number(idArg);
if (!Number.isSafeInteger(vexaMeetingId) || !model) { console.error("usage: replay-attributed.ts <vexaMeetingId> <model> [concurrency]"); process.exit(1); }
const base = process.env.VEXA_BASE_URL!;
const key = process.env.VEXA_API_KEY || (await Bun.file("/run/vexa/api-key").text()).trim();
// Replays are background operator work: back off on rate limits instead of competing with live meetings.
const retrying = async <T>(fn: () => Promise<T>, retryable: (error: unknown) => boolean): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (error) {
      if (attempt >= 6 || !retryable(error)) throw error;
      await Bun.sleep(1_000 * 2 ** attempt);
    }
  }
};
const vexa = (path: string) => retrying(async () => {
  const res = await fetch(`${base}${path}`, { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`vexa ${res.status}`);
  return res;
}, (error) => /vexa (429|5\d\d)/.test(String(error)));
const manifest = await (await vexa(`/meetings/${vexaMeetingId}/attributed-audio`)).json();
const provider = new TinfoilTranscriptionProvider({ baseUrl: process.env.TINFOIL_BASE_URL!, apiKey: process.env.TINFOIL_API_KEY!, model, timeoutMs: 120_000 });
const started = Date.now();
const batches = await replayAttributedBatches({
  manifest, vexaMeetingId, concurrency: Number(concurrencyArg ?? 3),
  fetchRange: async (range) => new Uint8Array(await (await vexa(range.path!)).arrayBuffer()),
  transcribe: (pcm, batch) => retrying(() => provider.transcribeAttributedPcm(pcm, batch, "en", model), (error) => /unavailable|timed out/i.test(String(error))),
  onBatch: (batch, done, total) => { if (done % 20 === 0 || done === total) console.error(`${done}/${total} ${batch.status} ${batch.ms}ms`); },
});
console.error(`model=${model} batches=${batches.length} calls=${provider.calls} seconds=${Math.round((Date.now() - started) / 1000)}`);
console.log(JSON.stringify({ vexaMeetingId, model, calls: provider.calls, manifest, batches: batches.map(({ spec: _spec, ...rest }) => rest) }));
