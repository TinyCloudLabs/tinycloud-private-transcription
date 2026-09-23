import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { attributedWorkerReadiness } from "../../src/db/schema.ts";
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
