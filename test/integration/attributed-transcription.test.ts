import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
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

test("live worker readiness is conjunctive and a no-op peer cannot heal a failed worker", async () => {
  const failed = { ...h.ctx, attributedWorkerId: `attributed-worker:test-failed:${crypto.randomUUID()}` };
  const healthy = { ...h.ctx, attributedWorkerId: `attributed-worker:test-healthy:${crypto.randomUUID()}` };
  await recordAttributedWorkerReadiness(failed, false, "reconciliation_failed");
  await recordAttributedWorkerReadiness(healthy, true, "heartbeat");
  expect(await attributedWorkerReady(h.ctx)).toBe(false);
  // A successful no-op heartbeat for another worker leaves the failed identity authoritative.
  await recordAttributedWorkerReadiness(healthy, true, "reconciled");
  expect(await attributedWorkerReady(h.ctx)).toBe(false);
  await h.ctx.db.update(attributedWorkerReadiness).set({ observedAt: new Date(Date.now() - 16_000) })
    .where(eq(attributedWorkerReadiness.id, failed.attributedWorkerId));
  expect(await attributedWorkerReady(h.ctx)).toBe(true);
});
