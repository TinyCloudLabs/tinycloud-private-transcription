// Manual pre-deploy coverage replay. Public AMI CC-BY-4.0, https://groups.inf.ed.ac.uk/ami/download/.
// Usage: DATABASE_URL=<isolated local tc1093 database> bun --no-env-file test/support/diarized-replay.ts AUDIO_ROOT MODEL_ROOT FFMPEG_DIR OUTPUT_DIR
// Runs the real HTTP API, durable worker, native shipped diarizer and HTTP provider client. The loopback provider
// captures actual WAV bytes and returns deterministic text; this proves dispatch coverage, not ASR word accuracy.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createBatchApp } from "../../src/roles/batch.ts";
import { transcriptionRegions } from "../../src/db/schema.ts";
import { readPcmRange } from "../../src/uploads/audio.ts";
import { speakerTurns, sherpaWindowRunner, WindowedDiarizer, type SpeakerSegment } from "../../src/uploads/diarize.ts";
import { aboveFloorFrames, detectSpeech, droppedAboveFloorFrames, frameEnergies, type Region } from "../../src/uploads/vad.ts";
import { BatchTinfoilClient } from "../../src/uploads/provider.ts";
import { pcmToWav } from "../../src/providers/transcription/audio.ts";
import { startBatchWorker } from "../../src/uploads/worker.ts";
import { jobDir, workDirName } from "../../src/uploads/storage.ts";
import { sha256, startBatchHarness, TENANT_A } from "../integration/batch-harness.ts";

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "expected JSON object");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  assert(typeof value === "string", "expected JSON string");
  return value;
}
function number(value: unknown): number {
  assert(typeof value === "number" && Number.isFinite(value), "expected finite JSON number");
  return value;
}
function boolean(value: unknown): boolean {
  assert(typeof value === "boolean", "expected JSON boolean");
  return value;
}
function status(value: unknown) {
  const body = object(value);
  return { status: string(body.status), error: body.error };
}
function parsedResult(value: unknown) {
  const body = object(value), stats = object(body.stats);
  return { duration_seconds: number(body.duration_seconds), stats: {
    tinfoil_calls: number(stats.tinfoil_calls), tinfoil_audio_seconds: number(stats.tinfoil_audio_seconds),
    voiced_seconds: number(stats.voiced_seconds), dropped_above_floor_pct: number(stats.dropped_above_floor_pct),
    vad_mode: string(stats.vad_mode), vad_fallback: boolean(stats.vad_fallback),
    speech_peak_s: number(stats.speech_peak_s), noise_floor_dbfs: number(stats.noise_floor_dbfs),
    median_dbfs: number(stats.median_dbfs), p99_dbfs: number(stats.p99_dbfs),
    dropped_above_noise_pct: number(stats.dropped_above_noise_pct),
  } };
}

const [audioRoot, modelRoot, ffmpegDir, outputDir] = Bun.argv.slice(2);
assert(audioRoot && modelRoot && ffmpegDir && outputDir, "four resource/output paths required");
const database = new URL(process.env.DATABASE_URL ?? "");
assert(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) && database.pathname.includes("tc1093"), "requires an isolated local tc1093 test database (harness truncates it)");
await mkdir(outputDir, { recursive: true });
const ffmpeg = join(ffmpegDir, "ffmpeg"), ffprobe = join(ffmpegDir, "ffprobe");
const farfield = join(audioRoot, "item5-conversation.wav"), nearfield = join(audioRoot, "item5-nearfield-mixheadset.wav");
assert.equal(sha256(new Uint8Array(await Bun.file(farfield).arrayBuffer())), "3b34ee0e141b61ff3e6fc0bef63f72b6e64e20640c1dd61ebe994a0f558806a3");
assert.equal(sha256(new Uint8Array(await Bun.file(nearfield).arrayBuffer())), "1969fc66580a70b58c5b24de4e1bf5d8552d3bb2bc2ece00683bc98921d94598");
async function cut(input: string, output: string) {
  const process = Bun.spawn([ffmpeg, "-v", "error", "-nostdin", "-y", "-i", input, "-t", "40", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output], { stdout: "ignore", stderr: "pipe" });
  const [error, code] = await Promise.all([new Response(process.stderr).text(), process.exited]);
  assert.equal(code, 0, error);
}
const short = join(outputDir, "short-es2004a-270-310.wav"), normal = join(outputDir, "normal-es2004a-270-310.wav");
await cut(farfield, short); await cut(nearfield, normal);
const narrationSource = join(import.meta.dir, "../../fixtures/librivox-art-of-war-30s.flac");
assert.equal(sha256(new Uint8Array(await Bun.file(narrationSource).arrayBuffer())), "b1ea4a1f3c90cdd533538de8ff9723709b6c0cd53f5b74c4e4fc417ea28e8df5");
// Public-domain narration provenance: THIRD_PARTY.md, LibriVox Art of War 0:30-1:00.
const narration = join(outputDir, "normal-librivox.wav");
await cut(narrationSource, narration);
const captured = new Map<string, Uint8Array>();
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const file = (await request.formData()).get("file");
  assert(file instanceof File);
  assert(!captured.has(file.name), "duplicate provider dispatch");
  captured.set(file.name, new Uint8Array(await file.arrayBuffer()));
  return Response.json({ text: "Local coverage replay", language: "en" });
} });
const h = await startBatchHarness({ config: { ffmpegPath: ffmpeg, ffprobePath: ffprobe } });
h.ctx.provider = new BatchTinfoilClient({ ...h.ctx.config.tinfoil, baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: "local-smoke" });
const native = new WindowedDiarizer(sherpaWindowRunner({ command: join(modelRoot, "diarize-window"),
  segmentation: join(modelRoot, "sherpa-onnx-pyannote-segmentation-3-0/model.onnx"), embedding: join(modelRoot, "embedding.onnx"), onnxruntime: join(modelRoot, "onnxruntime.config") }));
let modelSegments: SpeakerSegment[] = [];
h.ctx.diarizer = { async diarize(path, signal) { modelSegments = await native.diarize(path, signal); return modelSegments; } };
const app = createBatchApp(h.ctx);
const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
const worker = startBatchWorker(h.ctx, { sweep: false });
const reports: unknown[] = [];
function contains(regions: readonly Region[], original: readonly Region[]) {
  for (const region of original) {
    let end = region.startMs;
    for (const next of regions) if (next.startMs <= end && next.endMs > end) end = next.endMs;
    assert(end >= region.endMs, `uncovered interval ${region.startMs}-${region.endMs}`);
  }
}
async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${h.keys.transcriptions}`); headers.set("X-Tenant-Ref", TENANT_A);
  return fetch(`http://127.0.0.1:${api.port}${path}`, { ...init, headers });
}
try {
  for (const scenario of [{ name: "short", path: short, diarize: true }, { name: "long", path: farfield, diarize: true },
    { name: "normal-diarized", path: narration, diarize: true }, { name: "normal-note", path: normal, diarize: false },
    { name: "primary-recovery", path: normal, diarize: true }]) {
    captured.clear(); modelSegments = [];
    const bytes = new Uint8Array(await Bun.file(scenario.path).arrayBuffer());
    const workerPcm = join(outputDir, `${scenario.name}.worker.pcm`);
    h.faults.on("worker.after_rename", async (id) => {
      assert(id);
      const row = await h.row(id);
      await Bun.write(workerPcm, Bun.file(join(jobDir(h.uploadDir, id), workDirName(row.generation), "ch0.pcm")));
    });
    const created = await request("/v1/transcriptions", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `tc1093:${crypto.randomUUID()}` },
      body: JSON.stringify({ content_type: "audio/wav", byte_size: bytes.byteLength, sha256: sha256(bytes), language: "en", diarize: scenario.diarize, channel_mode: "mixed" }) });
    assert.equal(created.status, 201);
    const acceptedBody = object(await created.json());
    const accepted = { id: string(acceptedBody.id), upload: { capability: string(object(acceptedBody.upload).capability) } };
    const uploaded = await fetch(`http://127.0.0.1:${api.port}/uploads/${accepted.id}`, { method: "PUT",
      headers: { Authorization: `Bearer ${accepted.upload.capability}`, "Content-Type": "audio/wav", "Content-Length": String(bytes.byteLength) }, body: bytes });
    assert.equal(uploaded.status, 201);
    let state: { status: string; error: unknown } = { status: "queued", error: null };
    for (let i = 0; i < 10_000; i++) {
      state = status(await (await request(`/v1/transcriptions/${accepted.id}`)).json());
      if (state.status === "completed" || state.status === "failed") break;
      await Bun.sleep(30);
    }
    assert.equal(state.status, "completed", JSON.stringify(state.error)); assert.equal(state.error, null);
    // Validate actual worker PCM; a second 48 kHz resample differed by one PCM unit in local replay.
    const pcmHash = sha256(new Uint8Array(await Bun.file(workerPcm).arrayBuffer()));
    const energies = await frameEnergies(workerPcm), selected = detectSpeech(energies);
    const rawResult: unknown = await (await request(`/v1/transcriptions/${accepted.id}/result`)).json();
    const result = parsedResult(rawResult);
    const saved = (await h.ctx.db.select().from(transcriptionRegions).where(eq(transcriptionRegions.transcriptionId, accepted.id))).sort((a, b) => a.startMs-b.startMs);
    assert.equal(saved.length, captured.size); assert.equal(saved.length, result.stats.tinfoil_calls);
    for (const [i, region] of saved.entries()) {
      assert(region.endMs > region.startMs && region.endMs-region.startMs <= 30_000);
      if (i) assert(region.startMs >= saved[i-1]!.endMs, "duplicated audio");
      const expected = pcmToWav(await readPcmRange(workerPcm, region.startMs, region.endMs), 16_000);
      assert.equal(sha256(captured.get(`${accepted.id}-${region.ordinal}.wav`)!), sha256(expected), `dispatched WAV ${region.ordinal} differs from selected PCM`);
    }
    const original = scenario.diarize ? speakerTurns(modelSegments, energies) : selected.regions;
    if (scenario.diarize) {
      for (const speaker of new Set(modelSegments.map((s) => s.speaker))) contains(saved.filter((r) => r.speaker === speaker), original.filter((r) => "speaker" in r && r.speaker === speaker));
    }
    if (scenario.name === "short") {
      assert(selected.fallback && selected.stats.speech_peak_s < 1); contains(saved, selected.regions);
      assert.equal(result.stats.vad_mode, "fallback"); assert.equal(result.stats.vad_fallback, true); assert.equal(result.stats.dropped_above_floor_pct, 0);
    } else if (scenario.name === "long") {
      contains(saved, selected.regions); assert.equal(result.stats.vad_mode, "quiet"); assert.equal(result.stats.vad_fallback, false);
      assert(result.stats.tinfoil_audio_seconds/result.duration_seconds >= .97); assert.equal(result.stats.dropped_above_floor_pct, 0);
    } else if (scenario.name === "primary-recovery") {
      contains(saved, selected.regions);
      assert.equal(result.stats.vad_mode, "primary"); assert.equal(result.stats.vad_fallback, false);
      assert(result.stats.dropped_above_floor_pct <= 10);
    } else {
      assert.equal(result.stats.vad_mode, "primary"); assert.equal(result.stats.vad_fallback, false);
      assert.deepEqual(saved.map(({ startMs, endMs, speaker }) => scenario.diarize ? { startMs, endMs, speaker } : { startMs, endMs }), original);
    }
    const aboveFloor = aboveFloorFrames(energies), originalDropped = droppedAboveFloorFrames(energies, original);
    const report = { scenario: scenario.name, input_sha256: sha256(bytes), pcm_sha256: pcmHash, job_id: accepted.id, status: state.status, error: state.error,
      baseline_speaker_turn_seconds: original.reduce((n, r) => n+(r.endMs-r.startMs)/1000, 0), baseline_dropped_above_floor_pct: aboveFloor ? originalDropped/aboveFloor*100 : 0,
      duration_seconds: result.duration_seconds, sent_pct: result.stats.tinfoil_audio_seconds/result.duration_seconds*100,
      model_segments: modelSegments.length, regions: saved.length, provider_wavs_verified: captured.size, stats: result.stats };
    reports.push(report); console.log(JSON.stringify(report));
    await Bun.write(join(outputDir, `${scenario.name}-result.json`), JSON.stringify({ report, result: rawResult, modelSegments, regions: saved }, null, 2));
  }
  await Bun.write(join(outputDir, "evidence.json"), JSON.stringify({ public_source: "AMI ES2004a Array1-01/Mix-Headset, 270-990 s, CC-BY-4.0", provider: "loopback WAV capture; deterministic text, NOT ASR quality proof", reports }, null, 2));
} finally {
  await worker.stop(); api.stop(true); provider.stop(true); await h.stop();
}
