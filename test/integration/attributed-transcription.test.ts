import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { ATTEMPT_DEADLINE_MS, TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { PCM_RATE, pcmToWav } from "../../src/providers/transcription/audio.ts";
import { attributedAttempts, attributedBatches, attributedTranscriptionRuns, attributedWorkerReadiness } from "../../src/db/schema.ts";
import { attributedWorkerReady, processAttributedBatch, reconcileAttributedRuns, recordAttributedWorkerReadiness } from "../../src/services/attributed-transcription.ts";
import { runTranscriptEval, setReferenceTranscript, transcriptEvalReport, transcriptEvalText } from "../../src/services/transcript-eval.ts";
import { silentLogger } from "../../src/log.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
const pcm = new Uint8Array(new Float32Array(Array(16_000).fill(.1)).buffer);
const sha256 = createHash("sha256").update(pcm).digest("hex");

/**
 * Mock Tinfoil. Tests that need failures install `respond` for their own meeting's requests and
 * reset it; the default answers every request with the same words. A thrown error is a transport
 * failure the worker cannot classify (TC-758 retries it as an uncertain attempt).
 */
type TinfoilRequest = { filename: string; model: string; firstSample: number };
let respond: ((request: TinfoilRequest) => Response | Promise<Response>) | null = null;
const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = [];
const words = (text: string) => new Response(JSON.stringify({ text, language: "en" }));

beforeAll(async () => {
  const fetchMock = (async (_url: string, init: RequestInit) => {
    const form = init.body as FormData, file = form.get("file") as File;
    const bytes = await file.arrayBuffer();
    const request = { filename: file.name, model: String(form.get("model")), firstSample: bytes.byteLength > 45 ? new Int16Array(bytes, 44, 1)[0]! : 0 };
    return respond ? respond(request) : words("sealed words");
  }) as unknown as typeof fetch;
  const tinfoil = new TinfoilTranscriptionProvider({ baseUrl: "http://tinfoil.invalid", apiKey: "test", model: "test", attributedFallbackModel: "fallback-model", fetch: fetchMock });
  const log = { ...silentLogger, warn: (msg: string, data?: Record<string, unknown>) => { warnings.push({ msg, data }); } };
  h = await startHarness({ attributedTranscriptionEnabled: true, enabledPlatforms: ["google_meet"], transcriptRecovery: tinfoil, log });
});
afterAll(async () => h.stop());
afterEach(() => { respond = null; });

test("only closed authenticated attributed ranges become canonical", async () => {
  const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.google.com/abc-defg-hij" } });
  const { id } = await created.json();
  const native = "abc-defg-hij";
  const bot = await h.waitFor(async () => h.vexa.meetings.get(`google_meet/${native}`) ?? null);
  expect(bot.transcribe_enabled).toBe(false);
  const post = h.vexa.requests.find((request) => request.method === "POST" && request.path === "/bots");
  expect(post?.body).toMatchObject({ attributed_audio_enabled: true, transcribe_enabled: false, recording_enabled: true });
  const path = `/meetings/${bot.id}/attributed-audio/ranges/0`;
  await h.vexa.control("google_meet", native, {
    status: "completed", completion_reason: "stopped",
    // Deliberately include native text: it must not be canonical.
    segments: [{ start: 0, end: 1, text: "diagnostic only", language: "en", speaker: "Unknown", completed: true }],
    attributed_audio_capability: { requested_version: 1, supported_version: 1, status: "supported" },
    attributed_audio_manifest: { version: 1, meeting_id: String(bot.id), state: "closed", clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, ranges: [{ version: 1, meeting_id: String(bot.id), sequence: 0, idempotency_key: "r0", speaker_key: "alice", speaker_name: "Alice", attribution: { source: "glow-bound", confidence: .9 }, clock_origin_ms: 0, start_ms: 0, end_ms: 1000, audio_duration_ms: 1000, channel: 0, turn_generation: 1, codec: "pcm_f32le", sample_rate: 16000, channels: 1, byte_count: pcm.byteLength, sha256, state: "uploaded", path }] },
    attributed_audio_base64: { [path]: Buffer.from(pcm).toString("base64") },
  });
  await h.waitFor(async () => {
    const body = await (await h.api(`/v1/meetings/${id}`)).json(); return body.status === "completed" ? body : null;
  });
  const transcript = await (await h.api(`/v1/meetings/${id}/transcript`)).json();
  expect(transcript).toMatchObject({ provider: "tinfoil-attributed", text: "Alice: sealed words" });
  expect(transcript.text).not.toContain("diagnostic only");
  expect(h.vexa.requests.map((request) => request.path).some((path) => path.startsWith("/recordings"))).toBe(false);
});

test("internal eval re-transcribes retained audio beside the canonical transcript and scores both (TC-745)", async () => {
  const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.google.com/eva-lmee-tin" } });
  const { id } = await created.json();
  const native = "eva-lmee-tin";
  const bot = await h.waitFor(async () => h.vexa.meetings.get(`google_meet/${native}`) ?? null);
  const path = `/meetings/${bot.id}/attributed-audio/ranges/0`;
  await h.vexa.control("google_meet", native, {
    status: "completed", completion_reason: "stopped",
    attributed_audio_capability: { requested_version: 1, supported_version: 1, status: "supported" },
    attributed_audio_manifest: { version: 1, meeting_id: String(bot.id), state: "closed", clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, ranges: [{ version: 1, meeting_id: String(bot.id), sequence: 0, idempotency_key: "r0", speaker_key: "alice", speaker_name: "Alice", attribution: { source: "glow-bound", confidence: .9 }, clock_origin_ms: 0, start_ms: 0, end_ms: 1000, audio_duration_ms: 1000, channel: 0, turn_generation: 1, codec: "pcm_f32le", sample_rate: 16000, channels: 1, byte_count: pcm.byteLength, sha256, state: "uploaded", path }] },
    attributed_audio_base64: { [path]: Buffer.from(pcm).toString("base64") },
  });
  await h.waitFor(async () => { const body = await (await h.api(`/v1/meetings/${id}`)).json(); return body.status === "completed" ? body : null; });
  const canonical = await (await h.api(`/v1/meetings/${id}/transcript`)).text();
  const [evalId] = await runTranscriptEval(h.ctx, id, ["other-model"]);
  expect(await setReferenceTranscript(h.ctx, id, "gemini", "00:00:00\n\nAlice: sealed words\n")).toBe(1);
  const report = await transcriptEvalReport(h.ctx, id);
  expect(report.reference).toBe("gemini (1 turns)");
  expect(report.rows.map((row) => [row.source.split(" ")[0], row.status, row.metrics.wer])).toEqual([["published:tinfoil-attributed", "completed", 0], ["tinfoil:other-model", "completed", 0]]);
  expect(await transcriptEvalText(h.ctx, id, evalId)).toBe("[00:00:00] Alice: sealed words");
  // The canonical transcript is untouched.
  expect(await (await h.api(`/v1/meetings/${id}/transcript`)).text()).toBe(canonical);
});

test("attributed readiness is a stale-safe PostgreSQL worker heartbeat", async () => {
  const healthy = await (await h.api("/health")).json();
  expect(healthy.checks.attributed_transcription).toMatchObject({ enabled: true, ready: true });
  await h.ctx.db.update(attributedWorkerReadiness).set({ observedAt: new Date(Date.now() - 16_000) })
    .where(eq(attributedWorkerReadiness.id, h.ctx.attributedWorkerId));
  const stale = await (await h.api("/health")).json();
  expect(stale).toMatchObject({ status: "degraded", checks: { attributed_transcription: { enabled: true, ready: false } } });
});

test("startup unreadiness heals after a successful configured reconciliation", async () => {
  const worker = { ...h.ctx, attributedWorkerId: `attributed-worker:test-startup:${crypto.randomUUID()}` };
  await recordAttributedWorkerReadiness(worker, false, "startup");
  await recordAttributedWorkerReadiness(worker, true, "reconciled");
  const [readiness] = await h.ctx.db.select().from(attributedWorkerReadiness)
    .where(eq(attributedWorkerReadiness.id, worker.attributedWorkerId));
  expect(readiness).toMatchObject({ ready: true, stage: "reconciled" });
});

test("canonical publication failure remains latched until canonical publication succeeds", async () => {
  const worker = { ...h.ctx, attributedWorkerId: `attributed-worker:test-publication:${crypto.randomUUID()}` };
  await recordAttributedWorkerReadiness(worker, false, "publication_failed");
  await recordAttributedWorkerReadiness(worker, true, "reconciled");
  await recordAttributedWorkerReadiness(worker, false, "reconciliation_failed");
  await recordAttributedWorkerReadiness(worker, true, "heartbeat");
  let [readiness] = await h.ctx.db.select().from(attributedWorkerReadiness)
    .where(eq(attributedWorkerReadiness.id, worker.attributedWorkerId));
  expect(readiness).toMatchObject({ ready: false, stage: "publication_failed" });
  await recordAttributedWorkerReadiness(worker, true, "published");
  [readiness] = await h.ctx.db.select().from(attributedWorkerReadiness)
    .where(eq(attributedWorkerReadiness.id, worker.attributedWorkerId));
  expect(readiness).toMatchObject({ ready: true, stage: "published" });
});

test("a heartbeat paused after observing healthy readiness cannot clear a publication failure", async () => {
  // This database trigger is a deterministic barrier at the service/database seam. Before the
  // atomic upsert, the heartbeat reads the healthy row and then waits here; publication failure
  // commits while it is paused. The resumed heartbeat must evaluate the latch against that newer
  // row, rather than write its stale healthy decision.
  const barrierKey = 77_231_091;
  const worker = { ...h.ctx, attributedWorkerId: `attributed-worker:test-readiness-race:${crypto.randomUUID()}` };
  const blocker = await h.ctx.db.$client.reserve();
  await h.ctx.db.execute(sql`
    CREATE OR REPLACE FUNCTION test_attributed_readiness_heartbeat_barrier()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id LIKE 'attributed-worker:test-readiness-race:%' AND NEW.stage = 'heartbeat' THEN
        PERFORM pg_advisory_xact_lock(77231091);
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await h.ctx.db.execute(sql`
    CREATE TRIGGER test_attributed_readiness_heartbeat_barrier
    BEFORE INSERT OR UPDATE ON attributed_worker_readiness
    FOR EACH ROW EXECUTE FUNCTION test_attributed_readiness_heartbeat_barrier()
  `);

  try {
    await recordAttributedWorkerReadiness(worker, true, "reconciled");
    await blocker`SELECT pg_advisory_lock(${barrierKey})`;
    const staleHeartbeat = recordAttributedWorkerReadiness(worker, true, "heartbeat");
    await h.waitFor(async () => {
      const [waiting] = await h.ctx.db.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM pg_locks
        WHERE locktype = 'advisory' AND objid = ${barrierKey} AND NOT granted
      `);
      return waiting.count > 0 ? waiting : null;
    }, { label: "heartbeat readiness barrier" });

    await recordAttributedWorkerReadiness(worker, false, "publication_failed");
    await blocker`SELECT pg_advisory_unlock(${barrierKey})`;
    await staleHeartbeat;

    const [readiness] = await h.ctx.db.select().from(attributedWorkerReadiness)
      .where(eq(attributedWorkerReadiness.id, worker.attributedWorkerId));
    expect(readiness).toMatchObject({ ready: false, stage: "publication_failed" });
  } finally {
    await blocker`SELECT pg_advisory_unlock(${barrierKey})`.catch(() => {});
    await blocker.release();
    await h.ctx.db.execute(sql`DROP TRIGGER IF EXISTS test_attributed_readiness_heartbeat_barrier ON attributed_worker_readiness`);
    await h.ctx.db.execute(sql`DROP FUNCTION IF EXISTS test_attributed_readiness_heartbeat_barrier()`);
  }
});

test("unresolved-speaker ranges publish as unknown without vetoing the meeting (TC-559)", async () => {
  const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.google.com/pqr-stuv-wxy" } });
  const { id } = await created.json();
  const native = "pqr-stuv-wxy";
  const bot = await h.waitFor(async () => h.vexa.meetings.get(`google_meet/${native}`) ?? null, { timeoutMs: 30_000 });
  const rangePath = (sequence: number) => `/meetings/${bot.id}/attributed-audio/ranges/${sequence}`;
  const range = (sequence: number, speaker_key: string, speaker_name: string, start_ms: number, attribution: { source: string; confidence: number }, state = "uploaded") =>
    ({ version: 1, meeting_id: String(bot.id), sequence, idempotency_key: `r${sequence}`, speaker_key, speaker_name,
      attribution, clock_origin_ms: 0, start_ms, end_ms: start_ms + 1000, audio_duration_ms: 1000, channel: 0, turn_generation: 1,
      codec: "pcm_f32le", sample_rate: 16000, channels: 1, byte_count: pcm.byteLength, sha256, state,
      ...(state === "uploaded" ? { path: rangePath(sequence) } : {}) });
  // Meeting 82: 23 completed ranges and 22 unresolved. Resolved text must publish, unresolved
  // audio under an unknown speaker, failed ranges skipped — all marked partial. The unresolved
  // ranges deliberately reuse Alice's speaker_key: a provider key collision must never publish
  // unknown speech under Alice's speaker_id (M2).
  await h.vexa.control("google_meet", native, {
    status: "completed", completion_reason: "stopped",
    attributed_audio_capability: { requested_version: 1, supported_version: 1, status: "supported" },
    attributed_audio_manifest: { version: 1, meeting_id: String(bot.id), state: "closed", clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, ranges: [
      range(0, "alice", "Alice", 0, { source: "glow-bound", confidence: .9 }),
      // Far enough from Alice's speech that no neighbouring bound range names it (TC-742).
      range(1, "alice", "", 10_000, { source: "unresolved", confidence: 0 }),
      range(2, "alice", "", 12_000, { source: "unresolved", confidence: 0 }, "failed"),
    ] },
    attributed_audio_base64: { [rangePath(0)]: Buffer.from(pcm).toString("base64"), [rangePath(1)]: Buffer.from(pcm).toString("base64") },
  });
  const meeting = await h.waitFor(async () => {
    const body = await (await h.api(`/v1/meetings/${id}`)).json(); return body.status === "completed" ? body : null;
  }, { timeoutMs: 30_000 });
  expect(meeting).toMatchObject({ transcript_provider: "tinfoil-attributed", transcript_partial: true });
  const transcript = await (await h.api(`/v1/meetings/${id}/transcript`)).json();
  expect(transcript).toMatchObject({ provider: "tinfoil-attributed", partial: true });
  expect(transcript.segments).toHaveLength(2);
  expect(transcript.segments[1].speaker_id).not.toBe(transcript.segments[0].speaker_id);
  expect(transcript.segments[0]).toMatchObject({ speaker_name: "Alice", attribution: "identified" });
  expect(transcript.segments[1]).toMatchObject({ speaker_name: "Unknown", attribution: "unknown" });
  expect(transcript.text).toContain("Alice: sealed words");
  expect(transcript.text).toContain("Unknown: sealed words");
  const [rangeRow] = await h.ctx.db.execute<{ failed: number; completed: number }>(sql`
    select count(*) filter (where status = 'failed')::int as failed,
           count(*) filter (where status = 'completed')::int as completed
    from attributed_ranges where meeting_id = ${id}`);
  expect(rangeRow).toEqual({ failed: 1, completed: 2 });
});

test("an open manifest degrades to the mixed recording instead of failing (TC-559)", async () => {
  const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.google.com/zab-cdef-ghi" } });
  const { id } = await created.json();
  const native = "zab-cdef-ghi";
  const bot = await h.waitFor(async () => h.vexa.meetings.get(`google_meet/${native}`) ?? null, { timeoutMs: 30_000 });
  // Meeting 83: the producer manifest never closed, but the full mixed recording is retained.
  await h.vexa.control("google_meet", native, {
    status: "completed", completion_reason: "stopped",
    attributed_audio_capability: { requested_version: 1, supported_version: 1, status: "supported" },
    attributed_audio_manifest: { version: 1, meeting_id: String(bot.id), state: "open", clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, ranges: [] },
    recording_base64: Buffer.from(pcmToWav(new Int16Array(PCM_RATE).fill(2_000), PCM_RATE)).toString("base64"),
    recording_content_type: "audio/wav",
  });
  const meeting = await h.waitFor(async () => {
    const body = await (await h.api(`/v1/meetings/${id}`)).json(); return body.status === "completed" ? body : null;
  }, { timeoutMs: 30_000 });
  expect(meeting).toMatchObject({ transcript_provider: "tinfoil", transcript_partial: true });
  const transcript = await (await h.api(`/v1/meetings/${id}/transcript`)).json();
  expect(transcript).toMatchObject({ provider: "tinfoil", partial: true, text: "Unknown: sealed words" });
  expect(h.vexa.requests.map((request) => request.path)).toContain(`/meetings/${bot.id}/attributed-audio`);
  expect(h.vexa.requests.map((request) => request.path).some((path) => path.startsWith("/recordings"))).toBe(true);
  // The fallback marker is durable: reconciler/worker restarts keep polling to complete the
  // recording-owned meeting and never re-stage.
  const [run] = await h.ctx.db.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, id));
  expect(run.status).toBe("fallback");
  // The marker never persists the unvalidated provider manifest.
  expect(run.manifestJson).toEqual({});
  const [rangeCount] = await h.ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from attributed_ranges where meeting_id = ${id}`);
  expect(rangeCount.n).toBe(0);
});

test("unresolved-only ranges publish as unknown with the partial marker (TC-559)", async () => {
  const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.google.com/mno-pqrs-tuv" } });
  const { id } = await created.json();
  const native = "mno-pqrs-tuv";
  const bot = await h.waitFor(async () => h.vexa.meetings.get(`google_meet/${native}`) ?? null, { timeoutMs: 30_000 });
  const path = `/meetings/${bot.id}/attributed-audio/ranges/0`;
  await h.vexa.control("google_meet", native, {
    status: "completed", completion_reason: "stopped",
    attributed_audio_capability: { requested_version: 1, supported_version: 1, status: "supported" },
    attributed_audio_manifest: { version: 1, meeting_id: String(bot.id), state: "closed", clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, ranges: [
      { version: 1, meeting_id: String(bot.id), sequence: 0, idempotency_key: "r0", speaker_key: "unresolved:1", speaker_name: "",
        attribution: { source: "unresolved", confidence: 0 }, clock_origin_ms: 0, start_ms: 0, end_ms: 1000, audio_duration_ms: 1000,
        channel: 0, turn_generation: 1, codec: "pcm_f32le", sample_rate: 16000, channels: 1, byte_count: pcm.byteLength, sha256, state: "uploaded", path },
    ] },
    attributed_audio_base64: { [path]: Buffer.from(pcm).toString("base64") },
  });
  const meeting = await h.waitFor(async () => {
    const body = await (await h.api(`/v1/meetings/${id}`)).json(); return body.status === "completed" ? body : null;
  }, { timeoutMs: 30_000 });
  // Unresolved speech is published but degraded: the meeting and transcript carry the marker.
  expect(meeting).toMatchObject({ transcript_provider: "tinfoil-attributed", transcript_partial: true });
  const transcript = await (await h.api(`/v1/meetings/${id}/transcript`)).json();
  expect(transcript).toMatchObject({ provider: "tinfoil-attributed", text: "Unknown: sealed words" });
  expect(transcript.partial).toBe(true);
  expect(transcript.segments[0]).toMatchObject({ speaker_name: "Unknown", attribution: "unknown" });
});

test("a transient manifest fetch failure retries instead of falling back (TC-559)", async () => {
  const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.google.com/vwx-yzab-cde" } });
  const { id } = await created.json();
  const native = "vwx-yzab-cde";
  const bot = await h.waitFor(async () => h.vexa.meetings.get(`google_meet/${native}`) ?? null, { timeoutMs: 30_000 });
  const path = `/meetings/${bot.id}/attributed-audio/ranges/0`;
  const requestOffset = h.vexa.requests.length;
  // Complete the meeting with no manifest yet: the first poll 404s on the manifest fetch.
  await h.vexa.control("google_meet", native, {
    status: "completed", completion_reason: "stopped",
    attributed_audio_capability: { requested_version: 1, supported_version: 1, status: "supported" },
  });
  // Two manifest GETs prove a bounded retry already happened (first 404 was retried).
  await h.waitFor(async () => h.vexa.requests.filter((request) => request.path === `/meetings/${bot.id}/attributed-audio`).length >= 2 || null, { timeoutMs: 30_000 });
  await h.vexa.control("google_meet", native, {
    attributed_audio_manifest: { version: 1, meeting_id: String(bot.id), state: "closed", clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, ranges: [
      { version: 1, meeting_id: String(bot.id), sequence: 0, idempotency_key: "r0", speaker_key: "alice", speaker_name: "Alice",
        attribution: { source: "glow-bound", confidence: .9 }, clock_origin_ms: 0, start_ms: 0, end_ms: 1000, audio_duration_ms: 1000,
        channel: 0, turn_generation: 1, codec: "pcm_f32le", sample_rate: 16000, channels: 1, byte_count: pcm.byteLength, sha256, state: "uploaded", path },
    ] },
    attributed_audio_base64: { [path]: Buffer.from(pcm).toString("base64") },
  });
  const meeting = await h.waitFor(async () => {
    const body = await (await h.api(`/v1/meetings/${id}`)).json(); return body.status === "completed" ? body : null;
  }, { timeoutMs: 30_000 });
  expect(meeting).toMatchObject({ transcript_provider: "tinfoil-attributed" });
  expect(meeting.transcript_partial).toBeUndefined();
  // Fetch errors retry within the staging attempt budget: at least two manifest GETs.
  const requests = h.vexa.requests.slice(requestOffset).map((request) => request.path);
  expect(requests.filter((path) => path === `/meetings/${bot.id}/attributed-audio`).length).toBeGreaterThanOrEqual(2);
  expect(requests.some((path) => path.startsWith("/recordings"))).toBe(false);
});

// ── No content loss (TC-758) ─────────────────────────────────────────────────────────────────
const speech = (amplitude: number) => new Uint8Array(new Float32Array(16_000).fill(amplitude).buffer);
const alicePcm = speech(0.1), bobPcm = speech(0.2);
const BOB_FIRST_SAMPLE = Math.trunc(0.2 * 32767);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const meetRange = (botId: number, sequence: number, speaker: string, channel: number, start_ms: number, bytes: Uint8Array, state: "uploaded" | "failed" = "uploaded") => ({
  version: 1, meeting_id: String(botId), sequence, idempotency_key: `r${sequence}`, speaker_key: `gmeet:${channel}:${speaker}`, speaker_name: speaker,
  attribution: { source: "glow-bound", confidence: 1 }, clock_origin_ms: 0, start_ms, end_ms: start_ms + 1000, audio_duration_ms: 1000,
  channel, turn_generation: 1, codec: "pcm_f32le", sample_rate: 16000, channels: 1, byte_count: bytes.byteLength, sha256: hash(bytes), state,
  ...(state === "uploaded" ? { path: `/meetings/${botId}/attributed-audio/ranges/${sequence}` } : {}),
});

/** Runs one Google Meet capture to a terminal meeting and returns its API views. */
async function attributedMeeting(native: string, ranges: Array<{ speaker: string; channel: number; start_ms: number; bytes: Uint8Array; state?: "uploaded" | "failed" }>, recording?: Uint8Array) {
  const { id } = await (await h.api("/v1/meetings", { method: "POST", json: { meeting_url: `https://meet.google.com/${native}` } })).json();
  const bot = await h.waitFor(async () => h.vexa.meetings.get(`google_meet/${native}`) ?? null, { timeoutMs: 30_000 });
  const manifestRanges = ranges.map((r, sequence) => meetRange(bot.id, sequence, r.speaker, r.channel, r.start_ms, r.bytes, r.state));
  await h.vexa.control("google_meet", native, {
    status: "completed", completion_reason: "stopped",
    attributed_audio_capability: { requested_version: 1, supported_version: 1, status: "supported" },
    attributed_audio_manifest: { version: 1, meeting_id: String(bot.id), state: "closed", clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, ranges: manifestRanges },
    attributed_audio_base64: Object.fromEntries(manifestRanges.flatMap((r, i) => r.path ? [[r.path, Buffer.from(ranges[i]!.bytes).toString("base64")]] : [])),
    ...(recording ? { recording_base64: Buffer.from(recording).toString("base64"), recording_content_type: "audio/wav" } : {}),
  });
  const meeting = await h.waitFor(async () => {
    const body = await (await h.api(`/v1/meetings/${id}`)).json(); return ["completed", "failed"].includes(body.status) ? body : null;
  }, { timeoutMs: 30_000, label: `${native} terminal` });
  const transcript = meeting.status === "completed" ? await (await h.api(`/v1/meetings/${id}/transcript`)).json() : null;
  const [run] = await h.ctx.db.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, id));
  const batches = await h.ctx.db.select().from(attributedBatches).where(eq(attributedBatches.meetingId, id)).orderBy(asc(attributedBatches.ordinal));
  const attempts = await h.ctx.db.select({ attempt: attributedAttempts }).from(attributedAttempts).innerJoin(attributedBatches, eq(attributedAttempts.batchId, attributedBatches.id))
    .where(eq(attributedBatches.meetingId, id)).orderBy(asc(attributedAttempts.batchId), asc(attributedAttempts.ordinal));
  return { id, meeting, transcript, run, batches, attempts: attempts.map((row) => row.attempt) };
}

test("an uncertain first Tinfoil call is retried and the meeting publishes complete (TC-758)", async () => {
  let calls = 0;
  respond = () => { if (++calls === 1) throw new TypeError("socket hang up"); return words("sealed words"); };
  const { id, meeting, transcript, run, batches, attempts } = await attributedMeeting("ret-ryun-cer", [{ speaker: "Alice", channel: 0, start_ms: 0, bytes: alicePcm }]);
  expect(meeting).toMatchObject({ status: "completed", transcript_provider: "tinfoil-attributed" });
  expect(meeting.transcript_partial).toBeUndefined();
  expect(transcript).toMatchObject({ text: "Alice: sealed words" });
  expect(transcript.partial).toBeUndefined();
  expect(transcript.gaps).toBeUndefined();
  // Two durable attempts: the uncertain one settled terminal, then the retry succeeded.
  expect(batches.map((b) => [b.kind, b.status, b.attempts])).toEqual([["batch", "completed", 2]]);
  expect(attempts.map((a) => [a.ordinal, a.status, a.outcome, a.model])).toEqual([[1, "ambiguous", "external_call_uncertain", "test"], [2, "succeeded", null, "test"]]);
  expect(run.coverageJson).toMatchObject({ captured_ms: 1000, transcribed_ms: 1000, attributed_ms: 1000, gap_ms: 0, retried_batches: 1, gap_fill: "none" });
  expect(warnings.some((w) => w.msg.includes("retry scheduled") && w.data?.meetingId === id && w.data?.code === "external_call_uncertain")).toBe(true);
  expect((await transcriptEvalReport(h.ctx, id)).coverage).toMatchObject({ captured_ms: 1000, transcribed_ms: 1000 });
}, 60_000);

test("two empty Whisper results switch the batch to the fallback model (TC-758)", async () => {
  respond = (request) => words(request.model === "fallback-model" ? "fallback words" : "");
  const { meeting, transcript, attempts } = await attributedMeeting("emp-tyfa-llb", [{ speaker: "Alice", channel: 0, start_ms: 0, bytes: alicePcm }]);
  expect(meeting.status).toBe("completed");
  expect(transcript).toMatchObject({ text: "Alice: fallback words" });
  expect(transcript.partial).toBeUndefined();
  expect(attempts.map((a) => [a.status, a.outcome, a.model])).toEqual([["failed", "empty_transcript", "test"], ["failed", "empty_transcript", "test"], ["succeeded", null, "fallback-model"]]);
}, 60_000);

test("a batch exhausted after retries is filled from the retained recording on the meeting clock (TC-758)", async () => {
  // Bob's stream always fails at Tinfoil; the mixed recording started 1.5 s before the clock origin.
  const gapRequests: string[] = [];
  respond = (request) => {
    if (request.filename.startsWith("gap-")) { gapRequests.push(request.filename); return words("recovered words"); }
    if (request.firstSample === BOB_FIRST_SAMPLE) throw new TypeError("connection reset");
    return words("sealed words");
  };
  const ranges = [
    ...[0, 3_000, 6_000, 9_000].map((start_ms) => ({ speaker: "Alice", channel: 0, start_ms, bytes: alicePcm })),
    ...[12_000, 15_000].map((start_ms) => ({ speaker: "Bob", channel: 1, start_ms, bytes: bobPcm })),
  ];
  const offsetMs = 1_500, mixed = new Int16Array(20 * PCM_RATE).fill(10);
  for (const r of ranges) mixed.fill(4_000, (r.start_ms + offsetMs) * 16, (r.start_ms + 1_000 + offsetMs) * 16);
  const { meeting, transcript, run, batches, attempts } = await attributedMeeting("gap-fill-rec", ranges, pcmToWav(mixed, PCM_RATE));
  expect(meeting).toMatchObject({ status: "completed", transcript_partial: true });
  const bob = batches.find((b) => b.kind === "batch" && b.status !== "completed")!;
  expect([bob.status, bob.attempts]).toEqual(["ambiguous", 6]);
  expect(attempts.filter((a) => a.batchId === bob.id).every((a) => a.status === "ambiguous")).toBe(true);
  const gap = batches.find((b) => b.kind === "gap_fill")!;
  expect([gap.ordinal, gap.status, gap.attempts]).toEqual([-1, "completed", 1]);
  expect(gap.resultJson).toMatchObject({ offset_ms: 1_500, alignment: "correlated" });
  expect(gapRequests).toEqual(["gap-0.wav", "gap-1.wav"]);
  // Bob's lost speech is back under Bob, provisional, marked as recording-sourced, in spoken order.
  expect(transcript.segments.map((s: any) => [s.speaker_name, s.text, s.start, s.end, s.attribution, s.source])).toEqual([
    ["Alice", "sealed words", 0, 10, "identified", undefined],
    ["Bob", "recovered words", 12, 13, "provisional", "recording"],
    ["Bob", "recovered words", 15, 16, "provisional", "recording"],
  ]);
  expect(transcript.gaps).toBeUndefined();
  expect(run.coverageJson).toMatchObject({ captured_ms: 6_000, transcribed_ms: 6_000, attributed_ms: 4_000, recording_ms: 2_000, gap_ms: 0, gap_fill: "completed" });
}, 60_000);

test("speech no path could transcribe is listed as gaps and alerted, never dropped silently (TC-758)", async () => {
  // Carol's upload failed at the producer and the meeting has no retained recording.
  const { id, meeting, transcript, run, batches } = await attributedMeeting("gap-list-ed", [
    { speaker: "Alice", channel: 0, start_ms: 0, bytes: alicePcm },
    { speaker: "Carol", channel: 2, start_ms: 20_000, bytes: alicePcm, state: "failed" },
  ]);
  expect(meeting).toMatchObject({ status: "completed", transcript_partial: true });
  expect(transcript).toMatchObject({ partial: true, text: "Alice: sealed words", gaps: [{ start: 20, end: 21, speaker_name: "Carol" }] });
  expect(batches.find((b) => b.kind === "gap_fill")).toMatchObject({ status: "failed", attempts: 0, fetchAttempts: 5 });
  expect(run.coverageJson).toMatchObject({ captured_ms: 2_000, transcribed_ms: 1_000, gap_ms: 1_000, gap_fill: "failed" });
  expect(warnings.find((w) => w.data?.code === "untranscribed_gap" && w.data?.meetingId === id)?.data).toMatchObject({ gaps: 1, gapMs: 1_000 });
}, 60_000);

test("a dead owner's attempt is re-sent only after its deadline, so two paid calls never overlap (TC-758)", async () => {
  const recovery = h.ctx.transcriptRecovery;
  // Without a Tinfoil provider the worker defers the batch before claiming it, holding it pending.
  h.ctx.transcriptRecovery = null;
  try {
    const native = "dea-down-err";
    const { id } = await (await h.api("/v1/meetings", { method: "POST", json: { meeting_url: `https://meet.google.com/${native}` } })).json();
    const bot = await h.waitFor(async () => h.vexa.meetings.get(`google_meet/${native}`) ?? null, { timeoutMs: 30_000 });
    const range = meetRange(bot.id, 0, "Alice", 0, 0, alicePcm);
    await h.vexa.control("google_meet", native, {
      status: "completed", completion_reason: "stopped",
      attributed_audio_capability: { requested_version: 1, supported_version: 1, status: "supported" },
      attributed_audio_manifest: { version: 1, meeting_id: String(bot.id), state: "closed", clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, ranges: [range] },
      attributed_audio_base64: { [range.path!]: Buffer.from(alicePcm).toString("base64") },
    });
    const batch = await h.waitFor(async () => {
      const [row] = await h.ctx.db.select().from(attributedBatches).where(eq(attributedBatches.meetingId, id)); return row?.status === "pending" ? row : null;
    }, { timeoutMs: 30_000, label: "batch staged" });
    // A worker admitted attempt 1 a minute ago and then stopped heart-beating mid-call.
    const dispatchedAt = new Date(Date.now() - 60_000);
    await h.ctx.db.update(attributedBatches).set({ status: "claimed", claimToken: "dead-claim", claimedAt: dispatchedAt, dispatchToken: "dead-claim", dispatchOwnerId: "attributed-worker:dead", dispatchedAt, attempts: 1 })
      .where(eq(attributedBatches.id, batch.id));
    await h.ctx.db.insert(attributedAttempts).values({ id: `${batch.id}:attempt:1`, batchId: batch.id, ordinal: 1, status: "started", model: "test" });
    await reconcileAttributedRuns(h.ctx);
    const [after] = await h.ctx.db.select().from(attributedBatches).where(eq(attributedBatches.id, batch.id));
    expect([after.status, after.attempts, after.dispatchToken]).toEqual(["pending", 1, null]);
    // The zombie's requests all end by its attempt deadline; the retry waits past it.
    expect(after.nextAttemptAt!.getTime()).toBeGreaterThan(dispatchedAt.getTime() + ATTEMPT_DEADLINE_MS);
    const [first] = await h.ctx.db.select().from(attributedAttempts).where(eq(attributedAttempts.batchId, batch.id));
    expect([first.status, first.outcome]).toEqual(["ambiguous", "external_call_uncertain"]);
    const [rangeRow] = await h.ctx.db.execute<{ status: string }>(sql`select status from attributed_ranges where meeting_id = ${id}`);
    expect(rangeRow.status).toBe("pending");
    // An early wakeup with a provider available still cannot claim it.
    h.ctx.transcriptRecovery = recovery;
    expect(await processAttributedBatch(h.ctx, id, batch.id)).toBe("deferred");
    // Once the deadline has passed, attempt 2 is sent and the meeting publishes complete.
    await h.ctx.db.update(attributedBatches).set({ nextAttemptAt: new Date() }).where(eq(attributedBatches.id, batch.id));
    await h.ctx.queue.push({ type: "attributed.batch", meetingId: id, batchId: batch.id });
    const meeting = await h.waitFor(async () => { const body = await (await h.api(`/v1/meetings/${id}`)).json(); return body.status === "completed" ? body : null; }, { timeoutMs: 30_000 });
    expect(meeting.transcript_partial).toBeUndefined();
    const attempts = await h.ctx.db.select().from(attributedAttempts).where(eq(attributedAttempts.batchId, batch.id)).orderBy(asc(attributedAttempts.ordinal));
    expect(attempts.map((a) => [a.ordinal, a.status])).toEqual([[1, "ambiguous"], [2, "succeeded"]]);
  } finally {
    h.ctx.transcriptRecovery = recovery;
  }
}, 60_000);
