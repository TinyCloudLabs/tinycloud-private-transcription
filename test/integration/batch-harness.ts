import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createApiKey } from "../../src/api/auth.ts";
import { config as baseConfig } from "../../src/config.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { transcriptions, transcriptionWorkers } from "../../src/db/schema.ts";
import { silentLogger, type Logger } from "../../src/log.ts";
import { createBatchApp, createBatchContext, type BatchContext } from "../../src/roles/batch.ts";
import { batchConfigFromEnv, type BatchConfig } from "../../src/uploads/config.ts";
import { SimulatedCrash, type FaultPoint, type Faults } from "../../src/uploads/faults.ts";
import { BatchTinfoilClient } from "../../src/uploads/provider.ts";
import { ensureStorageRoot } from "../../src/uploads/storage.ts";
import { claimNext, processClaim, recordWorkerHeartbeat } from "../../src/uploads/worker.ts";

export type ApiResponse = Omit<Response, "json"> & { json(): Promise<any> };
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export const TENANT_A = "a".repeat(64);
export const TENANT_B = "b".repeat(64);
export const tenant = (n: number) => n.toString(16).padStart(64, "0");
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A scripted Tinfoil. `handler` decides each response; every call and the peak concurrency are recorded. */
export class MockTinfoil {
  calls: { filename: string; at: number }[] = [];
  active = 0;
  maxActive = 0;
  handler: (call: number, filename: string) => Promise<Response> | Response = (call) => Response.json({ text: `words ${call}`, language: "en" });
  readonly fetch = (async (_url: string, init: RequestInit) => {
    const file = (init.body as FormData).get("file") as File;
    this.calls.push({ filename: file.name, at: Date.now() });
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await this.handler(this.calls.length, file.name);
    } finally {
      this.active--;
    }
  }) as unknown as typeof fetch;
}

/** Per-test fault script: a handler per point. Returning "crash" simulates process death at that point. */
export class ScriptedFaults implements Faults {
  handlers = new Map<FaultPoint, (id?: string) => Promise<void | "crash" | "error"> | void | "crash" | "error">();
  hits: FaultPoint[] = [];
  on(point: FaultPoint, handler: (id?: string) => Promise<void | "crash" | "error"> | void | "crash" | "error") {
    this.handlers.set(point, handler);
    return this;
  }
  once(point: FaultPoint, action: "crash" | "error" | ((id?: string) => Promise<void> | void)) {
    let fired = false;
    return this.on(point, async (id) => {
      if (fired) return;
      fired = true;
      if (typeof action === "function") return action(id);
      return action;
    });
  }
  clear() {
    this.handlers.clear();
    this.hits = [];
  }
  async hit(point: FaultPoint, info?: { id?: string }) {
    this.hits.push(point);
    const handler = this.handlers.get(point);
    if (!handler) return;
    const action = await handler(info?.id);
    if (action === "crash") throw new SimulatedCrash(point);
    if (action === "error") throw new Error(`injected fault at ${point}`);
  }
}

export interface BatchHarness {
  ctx: BatchContext;
  tinfoil: MockTinfoil;
  faults: ScriptedFaults;
  keys: { transcriptions: string; admin: string; meetings: string };
  uploadDir: string;
  api(path: string, init?: { method?: string; json?: unknown; key?: string | null; tenant?: string | null; headers?: Record<string, string> }): Promise<ApiResponse>;
  create(bytes: Uint8Array, opts?: { tenant?: string; key?: string; contentType?: string; body?: Record<string, unknown> }): Promise<ApiResponse>;
  put(id: string, capability: string, bytes: Uint8Array | ReadableStream<Uint8Array>, opts?: { contentType?: string; contentLength?: number }): Promise<ApiResponse>;
  /** Create + PUT; returns the job id. */
  submit(bytes: Uint8Array, opts?: { tenant?: string; contentType?: string }): Promise<string>;
  /** One worker iteration: claim the next job and run it to a terminal state (or fence loss). */
  work(ctx?: BatchContext): Promise<boolean>;
  row(id: string): Promise<typeof transcriptions.$inferSelect>;
  withContext(overrides: Partial<BatchContext>): BatchContext;
  stop(): Promise<void>;
}

export function testBatchConfig(uploadDir: string, overrides: DeepPartial<BatchConfig> = {}): BatchConfig {
  const base = batchConfigFromEnv();
  return {
    ...base,
    databaseUrl: baseConfig.databaseUrl,
    uploadDir,
    tinfoil: { ...base.tinfoil, apiKey: "test", baseUrl: "https://tinfoil.test", ...overrides.tinfoil },
    // The high-water gate is exercised explicitly; default it high so a fullish dev disk does not mask other tests.
    limits: { ...base.limits, diskHighWaterPercent: 99, ...overrides.limits },
    upload: { ...base.upload, ...overrides.upload },
    worker: { ...base.worker, notSentBackoffMs: 1, retryAfterDefaultSeconds: 0, claimRenewSeconds: 0.05, ...overrides.worker },
    retention: { ...base.retention, ...overrides.retention },
  } as BatchConfig;
}

export async function startBatchHarness(opts: { config?: DeepPartial<BatchConfig>; log?: Logger; provider?: null } = {}): Promise<BatchHarness> {
  const uploadDir = await mkdtemp(join(tmpdir(), "ptx-batch-test-"));
  const config = testBatchConfig(uploadDir, opts.config);
  const db = await runMigrations(config.databaseUrl);
  await db.execute(sql`truncate table transcriptions, transcription_tenant_usage, transcription_workers, api_keys, projects cascade`);
  await db.execute(sql`update transcription_admission set mode = 'open' where id = 1`);
  await db.execute(sql`update provider_dispatch_slots set attempt_id = null, transcription_id = null, owner_id = null, claimed_at = null where id = 1`);
  await ensureStorageRoot(uploadDir);
  const tinfoil = new MockTinfoil();
  const faults = new ScriptedFaults();
  const provider = opts.provider === null ? null : new BatchTinfoilClient({ ...config.tinfoil, fetch: tinfoil.fetch });
  const ctx = createBatchContext({ config, db, log: opts.log ?? silentLogger, provider, faults, workerId: `test-worker:${crypto.randomUUID()}` });
  await recordWorkerHeartbeat(ctx);
  const keys = {
    transcriptions: (await createApiKey({ db } as never, "tinychat", ["transcriptions:*"])).key,
    admin: (await createApiKey({ db } as never, "ops", ["admin:*"])).key,
    meetings: (await createApiKey({ db } as never, "tinychat", ["meetings:*"])).key,
  };
  const app = createBatchApp(ctx);

  const api: BatchHarness["api"] = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    const key = init.key === undefined ? keys.transcriptions : init.key;
    if (key) headers.set("Authorization", `Bearer ${key}`);
    const t = init.tenant === undefined ? TENANT_A : init.tenant;
    if (t) headers.set("X-Tenant-Ref", t);
    if (init.json !== undefined) headers.set("Content-Type", "application/json");
    return (await app.request(path, { method: init.method ?? "GET", headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined })) as unknown as ApiResponse;
  };
  const create: BatchHarness["create"] = (bytes, o = {}) => api("/v1/transcriptions", {
    method: "POST",
    tenant: o.tenant ?? TENANT_A,
    key: o.key,
    headers: { "Idempotency-Key": `tc:${crypto.randomUUID()}` },
    json: { content_type: o.contentType ?? "audio/mpeg", byte_size: bytes.byteLength, sha256: sha256(bytes), language: "en", ...o.body },
  });
  const put: BatchHarness["put"] = async (id, capability, bytes, o = {}) => {
    const length = o.contentLength ?? (bytes instanceof Uint8Array ? bytes.byteLength : undefined);
    const headers = new Headers({ Authorization: `Bearer ${capability}`, "Content-Type": o.contentType ?? "audio/mpeg" });
    if (length !== undefined) headers.set("Content-Length", String(length));
    return (await app.request(`/uploads/${id}`, { method: "PUT", headers, body: bytes as unknown as RequestInit["body"], ...(bytes instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit)) as unknown as ApiResponse;
  };
  const submit: BatchHarness["submit"] = async (bytes, o = {}) => {
    const created = await create(bytes, o);
    if (created.status !== 201) throw new Error(`create failed: ${created.status} ${JSON.stringify(await created.json())}`);
    const body = await created.json();
    const uploaded = await put(body.id, body.upload.capability, bytes, { contentType: o.contentType });
    if (uploaded.status !== 201) throw new Error(`upload failed: ${uploaded.status} ${JSON.stringify(await uploaded.json())}`);
    return body.id;
  };
  const work: BatchHarness["work"] = async (c = ctx) => {
    const claim = await claimNext(c);
    if (!claim) return false;
    await processClaim(c, claim);
    return true;
  };
  const row: BatchHarness["row"] = async (id) => (await db.select().from(transcriptions).where(eq(transcriptions.id, id)))[0]!;
  return {
    ctx,
    tinfoil,
    faults,
    keys,
    uploadDir,
    api,
    create,
    put,
    submit,
    work,
    row,
    withContext: (overrides) => ({ ...ctx, ...overrides }),
    async stop() {
      await db.delete(transcriptionWorkers);
      await db.$client.close();
      await rm(uploadDir, { recursive: true, force: true });
    },
  };
}

const fixtureCache = new Map<string, Uint8Array>();

type Fixture = "stereo" | "mono_wav" | "silent_wav" | "three_channel_wav" | "over_cap_mp3" | "stereo_dense"
  | "stereo_m4a" | "stereo_webm" | "stereo_webm_no_duration" | "stereo_webm_offset" | "stereo_flac" | "stereo_mp4_with_video";

// ch0 speaks 0.5–2.5 s, ch1 speaks 3.5–5.5 s; 7 s stereo. Re-encoded per container below. Inputs and graph only:
// `-map` is an output option, so it has to follow any further input.
const STEREO = ["-f", "lavfi", "-i", "sine=f=440:d=2", "-f", "lavfi", "-i", "sine=f=660:d=2", "-filter_complex",
  "[0]adelay=500,apad=whole_dur=7[a];[1]adelay=3500,apad=whole_dur=7[b];[a][b]amerge=inputs=2[out]"];

/** Deterministic audio made with ffmpeg (no host TTS). Tones stand in for speech: the VAD is energy-based. */
export async function audio(kind: Fixture): Promise<Uint8Array> {
  const cached = fixtureCache.get(kind);
  if (cached) return cached;
  const dir = await mkdtemp(join(tmpdir(), "ptx-batch-fixture-"));
  const ext = kind.endsWith("wav") ? "wav" : kind === "stereo_m4a" ? "m4a" : kind.startsWith("stereo_webm") ? "webm"
    : kind === "stereo_flac" ? "flac" : kind === "stereo_mp4_with_video" ? "mp4" : "mp3";
  const out = join(dir, `out.${ext}`);
  const args: Record<Fixture, string[]> = {
    stereo: [...STEREO, "-map", "[out]", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k"],
    stereo_m4a: [...STEREO, "-map", "[out]", "-ar", "44100", "-c:a", "aac", "-b:a", "64k"],
    stereo_webm: [...STEREO, "-map", "[out]", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k"],
    // What browser MediaRecorder writes: no Duration element and no Cues, so ffprobe reports duration N/A.
    stereo_webm_no_duration: [...STEREO, "-map", "[out]", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "-live", "1"],
    // No duration either, and timestamps that start at 100 s: the length is 7 s, not 107 s.
    stereo_webm_offset: [...STEREO, "-map", "[out]", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "-output_ts_offset", "100", "-live", "1"],
    stereo_flac: [...STEREO, "-map", "[out]", "-ar", "16000", "-c:a", "flac"],
    // A video track next to the audio (screen recordings, phone videos) is ignored.
    stereo_mp4_with_video: [...STEREO, "-f", "lavfi", "-i", "color=c=black:s=64x64:r=5:d=7", "-map", "[out]", "-map", "2:v", "-c:v", "mpeg4",
      "-ar", "44100", "-c:a", "aac", "-b:a", "64k"],
    // Four alternating turns per channel: 8 regions.
    stereo_dense: ["-f", "lavfi", "-i", "sine=f=440:d=16", "-f", "lavfi", "-i", "sine=f=660:d=16", "-filter_complex",
      "[0]volume='if(lt(mod(t,4),1.5),1,0)':eval=frame,apad=whole_dur=16[a];[1]volume='if(between(mod(t,4),2,3.5),1,0)':eval=frame,apad=whole_dur=16[b];[a][b]amerge=inputs=2[out]",
      "-map", "[out]", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k"],
    mono_wav: ["-f", "lavfi", "-i", "sine=f=440:d=1", "-af", "apad=whole_dur=2", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"],
    silent_wav: ["-f", "lavfi", "-i", "anullsrc=r=16000:cl=stereo", "-t", "3", "-c:a", "pcm_s16le"],
    three_channel_wav: ["-f", "lavfi", "-i", "sine=f=440:d=1", "-ac", "3", "-ar", "16000", "-c:a", "pcm_s16le"],
    over_cap_mp3: ["-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "7201", "-c:a", "libmp3lame", "-b:a", "8k"],
  };
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args[kind], out], { stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`fixture ${kind} failed: ${stderr}`);
  const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
  await rm(dir, { recursive: true, force: true });
  fixtureCache.set(kind, bytes);
  return bytes;
}

/** A body that yields `chunks` pieces of `bytes`, waiting `delayMs` before each. */
export function trickle(bytes: Uint8Array, chunks: number, delayMs: number, opts: { stopAfter?: number; errorAfter?: number } = {}): ReadableStream<Uint8Array> {
  const size = Math.ceil(bytes.byteLength / chunks);
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (opts.errorAfter !== undefined && index >= opts.errorAfter) return controller.error(new Error("client went away"));
      if (opts.stopAfter !== undefined && index >= opts.stopAfter) return controller.close();
      if (index * size >= bytes.byteLength) return controller.close();
      await Bun.sleep(delayMs);
      controller.enqueue(bytes.slice(index * size, (index + 1) * size));
      index++;
    },
  });
}

export async function exists(path: string) {
  return (await import("node:fs/promises")).lstat(path).then(() => true, () => false);
}

/**
 * A hostile WebM written byte by byte: no Duration and no Cues, and every block is a fixed-size lace of 256 one-byte
 * Opus packets (2.5 ms CELT TOC, empty frame). Only the first packet of a lace has a timestamp, so the packet scan sees
 * `blocks × 256` packets that claim almost no time. Small on disk, millions of packets at scale.
 */
export function laceBombWebm(blocks: number): Uint8Array {
  const size = (n: number) => [0x01, ...[48, 40, 32, 24, 16, 8, 0].map((shift) => Number((BigInt(n) >> BigInt(shift)) & 0xffn))];
  const el = (id: number[], body: number[]) => [...id, ...size(body.length), ...body];
  const uint = (id: number[], value: number) => el(id, [value >> 24 & 0xff, value >> 16 & 0xff, value >> 8 & 0xff, value & 0xff]);
  const text = (id: number[], value: string) => el(id, [...new TextEncoder().encode(value)]);
  const float = (id: number[], value: number) => el(id, [...new Uint8Array(new Float64Array([value]).buffer).reverse()]);
  const opusHead = [...new TextEncoder().encode("OpusHead"), 1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0];
  const header = el([0x1a, 0x45, 0xdf, 0xa3], [
    ...uint([0x42, 0x86], 1), ...uint([0x42, 0xf7], 1), ...uint([0x42, 0xf2], 4), ...uint([0x42, 0xf3], 8),
    ...text([0x42, 0x82], "webm"), ...uint([0x42, 0x87], 4), ...uint([0x42, 0x85], 2),
  ]);
  const info = el([0x15, 0x49, 0xa9, 0x66], [...uint([0x2a, 0xd7, 0xb1], 1_000_000), ...text([0x4d, 0x80], "t"), ...text([0x57, 0x41], "t")]);
  const tracks = el([0x16, 0x54, 0xae, 0x6b], el([0xae], [
    ...uint([0xd7], 1), ...uint([0x73, 0xc5], 1), ...uint([0x83], 2), ...text([0x86], "A_OPUS"), ...el([0x63, 0xa2], opusHead),
    ...el([0xe1], [...float([0xb5], 48_000), ...uint([0x9f], 1)]),
  ]));
  const block = (timecode: number) => el([0xa3], [0x81, timecode >> 8 & 0xff, timecode & 0xff, 0x84, 255, ...new Array<number>(256).fill(0x80)]);
  const clusters: number[] = [];
  for (let first = 0; first < blocks; first += 100) {
    const body = [...uint([0xe7], first)];
    for (let index = first; index < Math.min(blocks, first + 100); index++) body.push(...block(index - first));
    clusters.push(...el([0x1f, 0x43, 0xb6, 0x75], body));
  }
  return new Uint8Array([...header, ...el([0x18, 0x53, 0x80, 0x67], [...info, ...tracks, ...clusters])]);
}
