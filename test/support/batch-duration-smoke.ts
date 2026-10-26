// Manual TC-922 replay against an OWN ephemeral local Postgres, never a production database.
// DATABASE_URL=postgres://.../tc922... bun --no-env-file test/support/batch-duration-smoke.ts OUTPUT_DIR
// Starts the production HTTP API entrypoint, a durable worker and a loopback mock provider; no paid calls.
import assert from "node:assert/strict";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { audio, sha256, startBatchHarness, TENANT_A } from "../integration/batch-harness.ts";
import { BatchTinfoilClient } from "../../src/uploads/provider.ts";
import { startBatchWorker } from "../../src/uploads/worker.ts";

const database = new URL(process.env.DATABASE_URL ?? "");
assert(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) && database.pathname.includes("tc922"), "requires an isolated local tc922 database (harness truncates it)");
assert(Bun.argv[2], "OUTPUT_DIR is required");
const output = resolve(Bun.argv[2]!);
await mkdir(output, { recursive: true });
const decoded: number[][] = [];
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const form = await request.formData();
  const file = form.get("file");
  assert(file instanceof File);
  assert.equal(form.get("model"), "whisper-large-v3-turbo");
  const wav = new Uint8Array(await file.arrayBuffer());
  decoded.push([wav.byteLength, file.size]);
  return Response.json({ text: `local smoke ${decoded.length}`, language: "en" });
} });
const h = await startBatchHarness();
const compose = Bun.YAML.parse(await Bun.file(new URL("../../infra/dstack-batch/app-compose.yaml", import.meta.url)).text()) as {
  services: { api: { environment: Record<string, string> } };
};
const shipped = compose.services.api.environment;
h.ctx.provider = new BatchTinfoilClient({ ...h.ctx.config.tinfoil, baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: "local-smoke" });
const decoder = join(h.uploadDir, "ffmpeg");
const decoderArgs = join(output, "decoder-args.jsonl");
await writeFile(decoderArgs, "");
const probe = join(h.uploadDir, "ffprobe");
const metadata = join(h.uploadDir, "probe-metadata.json");
await writeFile(decoder, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(decoderArgs)}, JSON.stringify(Bun.argv.slice(2))+'\\n');\nconst p=Bun.spawnSync(['ffmpeg',...Bun.argv.slice(2)],{stdin:'ignore',stdout:'inherit',stderr:'inherit'});process.exit(p.exitCode);\n`, { mode: 0o755 });
await writeFile(probe, `#!${process.execPath}\nimport { existsSync, readFileSync } from 'node:fs';\nif(existsSync(${JSON.stringify(metadata)})){process.stdout.write(readFileSync(${JSON.stringify(metadata)}));}else{const p=Bun.spawnSync(['ffprobe',...Bun.argv.slice(2)],{stdin:'ignore',stdout:'inherit',stderr:'inherit'});process.exit(p.exitCode);}\n`, { mode: 0o755 });
h.ctx.config.ffmpegPath = decoder;
const portReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = portReservation.port!;
portReservation.stop(true);
const apiLog = Bun.file(join(output, "api.log"));
const api = Bun.spawn([process.execPath, "--no-env-file", "src/api/server.ts"], {
  cwd: resolve(import.meta.dir, "../.."),
  env: {
    PATH: process.env.PATH!, PTX_ROLE: "batch", PORT: String(port), AUTO_MIGRATE: "false",
    DATABASE_URL: database.href, BATCH_UPLOAD_DIR: h.uploadDir, BATCH_DISK_HIGH_WATER_PERCENT: "99",
    BATCH_TINFOIL_API_KEY: "local-smoke", BATCH_TINFOIL_BASE_URL: `http://127.0.0.1:${provider.port}`, FFPROBE_PATH: probe,
    BATCH_MAX_RESERVED_BYTES: shipped.BATCH_MAX_RESERVED_BYTES,
    BATCH_TENANT_DAILY_BYTES: shipped.BATCH_TENANT_DAILY_BYTES,
  },
  stdout: apiLog, stderr: apiLog,
});
const worker = startBatchWorker(h.ctx, { sweep: false });
const report: Record<string, unknown> = { mode: "local HTTP, mock provider; short real audio, synthetic long metadata", port, providerPort: provider.port };
async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${h.keys.transcriptions}`);
  if (!headers.has("X-Tenant-Ref")) headers.set("X-Tenant-Ref", TENANT_A);
  return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
}
async function create(size: number, digest: string, tenant = TENANT_A) {
  return request("/v1/transcriptions", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), "X-Tenant-Ref": tenant },
    body: JSON.stringify({ content_type: "audio/mpeg", byte_size: size, sha256: digest, language: "en" }) });
}
async function upload(job: any, body: Blob | Uint8Array, size: number) {
  return fetch(`http://127.0.0.1:${port}/uploads/${job.id}`, { method: "PUT", headers: { Authorization: `Bearer ${job.upload.capability}`, "Content-Type": "audio/mpeg", "Content-Length": String(size) }, body, signal: AbortSignal.timeout(60_000) });
}
async function completed(id: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const row = await h.row(id);
    if (["completed", "failed"].includes(row.status)) {
      assert.equal(row.status, "completed", row.errorCode ?? "failed");
      const result = await (await request(`/v1/transcriptions/${id}/result`)).json() as any;
      assert.equal(result.stats.tinfoil_calls, 2);
      assert.deepEqual(result.segments.map((s: any) => [s.speaker_id, s.start, s.end]), [["channel_0", 0.25, 2.75], ["channel_1", 3.25, 5.75]]);
      return result;
    }
    await Bun.sleep(100);
  }
  throw new Error("local worker timeout");
}
const paddedPath = join(output, "byte-cap.mp3");
let createdPadded = false;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    ready = await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(1_000) }).then(r => r.ok, () => false);
    if (ready) break;
    await Bun.sleep(100);
  }
  assert(ready, "production API failed to start; see api.log");
  const capabilities = await (await request("/v1/transcriptions/capabilities")).json() as any;
  assert.equal(capabilities.max_duration_seconds, 10_800);
  assert.equal(capabilities.accepted_max_duration_seconds, 11_101);
  assert.equal(capabilities.max_bytes, 186_496_800);
  assert(!("duration_grace_seconds" in capabilities));
  report.capabilities = capabilities;

  const bytes = await audio("stereo");
  const nominal = await create(bytes.byteLength, sha256(bytes));
  assert.equal(nominal.status, 201);
  const note = await nominal.json() as any;
  assert.equal((await upload(note, bytes, bytes.byteLength)).status, 201);
  report.ordinary = await completed(note.id);

  // Legal ID3v2 padding: full real HTTP byte cap through Bun, without a long encode/decode or a 186 MB heap buffer.
  const cap = 186_496_800;
  const padding = cap - bytes.byteLength - 10;
  const file = await open(paddedPath, "wx");
  createdPadded = true;
  try {
    await file.truncate(cap);
    await file.write(new Uint8Array([73, 68, 51, 4, 0, 0, (padding >> 21) & 127, (padding >> 14) & 127, (padding >> 7) & 127, padding & 127]), 0, 10, 0);
    await file.write(bytes, 0, bytes.byteLength, padding + 10);
  } finally { await file.close(); }
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(paddedPath).stream()) hash.update(chunk);
  const digest = hash.digest("hex");
  const over = await create(cap + 1, digest);
  assert.equal(over.status, 413);
  assert.equal(((await over.json()) as any).error.code, "recording_too_large");
  const at = await create(cap, digest);
  assert.equal(at.status, 201);
  const large = await at.json() as any;
  assert.equal((await upload(large, Bun.file(paddedPath), cap)).status, 201);
  report.fullByteCap = { bytes: cap, sha256: digest, create: 201, put: 201, overCreate: 413, result: await completed(large.id) };

  for (const raw of ["11101.000000", "11101.0000625", "11100.029388"]) {
    await writeFile(metadata, JSON.stringify({ streams: [{ codec_type: "audio", channels: 2 }], format: { format_name: "mp3", duration: raw } }));
    const created = await create(bytes.byteLength, sha256(bytes));
    assert.equal(created.status, 201);
    const job = await created.json() as any;
    const callsBefore = decoded.length;
    const response = await upload(job, bytes, bytes.byteLength);
    const status = response.status;
    if (raw === "11101.0000625") {
      assert.equal(status, 422);
      assert.equal(((await response.json()) as any).error.job_error.code, "recording_too_long");
      assert.equal((await h.row(job.id)).deletionState, "files_deleted");
      assert.equal(decoded.length, callsBefore);
      report[raw] = { put: status, providerCalls: 0 };
    } else {
      assert.equal(status, 201);
      report[raw] = { put: status, result: await completed(job.id) };
    }
  }
  // Consume the shipped API environment, rather than merely comparing its literals with defaults.
  const reserved: { id: string; tenant: string }[] = [];
  for (let index = 1; index <= 10; index++) {
    const tenant = index.toString(16).padStart(64, "0");
    const response = await create(cap, digest, tenant);
    assert.equal(response.status, 201);
    reserved.push({ id: ((await response.json()) as any).id, tenant });
  }
  const busy = await create(1, digest, "c".repeat(64));
  assert.equal(busy.status, 429);
  assert.equal(((await busy.json()) as any).error.code, "service_busy");
  for (const job of reserved) assert.equal((await request(`/v1/transcriptions/${job.id}/cancel`, { method: "POST", headers: { "X-Tenant-Ref": job.tenant } })).status, 200);
  const dailyTenant = "d".repeat(64);
  for (let index = 0; index < 3; index++) {
    const response = await create(cap, digest, dailyTenant);
    assert.equal(response.status, 201);
    const job = await response.json() as any;
    assert.equal((await request(`/v1/transcriptions/${job.id}/cancel`, { method: "POST", headers: { "X-Tenant-Ref": dailyTenant } })).status, 200);
  }
  const quota = await create(1, digest, dailyTenant);
  assert.equal(quota.status, 429);
  assert.equal(((await quota.json()) as any).error.code, "quota_exceeded");
  report.shippedBudgets = { tenFullCapReservations: 201, nextCreate: 429, threeFullCapDailyCreates: 201, nextByte: 429 };
  const args = (await readFile(decoderArgs, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
  assert.equal(args.length, 8);
  assert(args.every(argv => argv[argv.indexOf("-fs") + 1] === "355232000"));
  assert.equal(decoded.length, 8);
  report.decoderCaps = args.map(argv => argv[argv.indexOf("-fs") + 1]);
  report.providerCalls = decoded.length;
  report.status = "passed";
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: "passed", report: join(output, "report.json"), providerCalls: decoded.length }));
} finally {
  await worker.stop();
  api.kill();
  await api.exited;
  provider.stop(true);
  await h.stop();
  if (createdPadded) await rm(paddedPath, { force: true });
}
