import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { PCM_RATE, pcmToWav } from "../../src/providers/transcription/audio.ts";
import { attributedTranscriptionRuns, attributedWorkerReadiness } from "../../src/db/schema.ts";
import { attributedWorkerReady, recordAttributedWorkerReadiness } from "../../src/services/attributed-transcription.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
const pcm = new Uint8Array(new Float32Array(Array(16_000).fill(.1)).buffer);
const sha256 = createHash("sha256").update(pcm).digest("hex");

beforeAll(async () => {
  const fetchMock = (async () => new Response(JSON.stringify({ text: "sealed words", language: "en" }))) as unknown as typeof fetch;
  const tinfoil = new TinfoilTranscriptionProvider({ baseUrl: "http://tinfoil.invalid", apiKey: "test", model: "test", fetch: fetchMock });
  h = await startHarness({ attributedTranscriptionEnabled: true, enabledPlatforms: ["google_meet"], transcriptRecovery: tinfoil });
});
afterAll(async () => h.stop());

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
      range(1, "alice", "", 2000, { source: "unresolved", confidence: 0 }),
      range(2, "alice", "", 4000, { source: "unresolved", confidence: 0 }, "failed"),
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
