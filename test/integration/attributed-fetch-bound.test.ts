import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { attributedBatches, attributedTranscriptionRuns, meetings, tinfoilDispatchSlots } from "../../src/db/schema.ts";
import { finalizeAttributedRun, reconcileAttributedRuns } from "../../src/services/attributed-transcription.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
let tinfoilCalls = 0;
const pcm = new Uint8Array(new Float32Array(Array(16_000).fill(.1)).buffer);
const sha256 = createHash("sha256").update(pcm).digest("hex");

beforeAll(async () => {
  const fetchMock = (async () => {
    tinfoilCalls++;
    return new Response(JSON.stringify({ text: "sealed words", language: "en" }));
  }) as unknown as typeof fetch;
  const tinfoil = new TinfoilTranscriptionProvider({ baseUrl: "http://tinfoil.invalid", apiKey: "test", model: "test", fetch: fetchMock });
  h = await startHarness({ attributedTranscriptionEnabled: true, enabledPlatforms: ["google_meet"], transcriptRecovery: tinfoil });
});
afterAll(async () => h.stop());

const rangeSpec = (vexaMeetingId: number, path: string) => ({
  version: 1, meeting_id: String(vexaMeetingId), sequence: 0, idempotency_key: "r0",
  speaker_key: "alice", speaker_name: "Alice",
  attribution: { source: "glow-bound", confidence: .9 }, clock_origin_ms: 0, start_ms: 0, end_ms: 1000,
  audio_duration_ms: 1000, channel: 0, turn_generation: 1, codec: "pcm_f32le", sample_rate: 16000,
  channels: 1, byte_count: pcm.byteLength, sha256, state: "uploaded", path,
});

// MAX_FETCH_ATTEMPTS is 3: a permanently missing range may be fetched 4 times total. The bound
// lives on the batch row, so finalize/reconcile requeues (which carry no fetch counter) must not
// extend it (TC-576).
test("a permanently missing range is fetched at most MAX_FETCH_ATTEMPTS + 1 times", async () => {
  const baselineTinfoilCalls = tinfoilCalls;
  const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.google.com/fetch-bound-1" } });
  const { id } = await created.json();
  const native = "fetch-bound-1";
  const bot = await h.waitFor(async () => h.vexa.meetings.get(`google_meet/${native}`) ?? null, { timeoutMs: 30_000 });
  const path = `/meetings/${bot.id}/attributed-audio/ranges/0`;
  await h.vexa.control("google_meet", native, {
    status: "completed", completion_reason: "stopped",
    attributed_audio_capability: { requested_version: 1, supported_version: 1, status: "supported" },
    attributed_audio_manifest: { version: 1, meeting_id: String(bot.id), state: "closed", clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, ranges: [rangeSpec(bot.id, path)] },
    // No attributed_audio_base64: every range fetch 404s.
  });
  // While retries run, hammer the wakeup paths that used to reset the counter: a direct finalize
  // pass, a reconcile sweep, and a counter-less batch requeue on every poll tick.
  const batch = await h.waitFor(async () => {
    const [row] = await h.ctx.db.select().from(attributedBatches).where(eq(attributedBatches.meetingId, id));
    if (!row) return null;
    if (row.status === "pending") {
      await finalizeAttributedRun(h.ctx, id);
      await reconcileAttributedRuns(h.ctx);
      await h.ctx.queue.push({ type: "attributed.batch", meetingId: id, batchId: row.id });
      return null;
    }
    return row.status === "failed" ? row : null;
  }, { timeoutMs: 30_000, label: "batch settled failed" });
  expect(batch.status).toBe("failed");
  const meeting = await h.waitFor(async () => {
    const body = await (await h.api(`/v1/meetings/${id}`)).json(); return body.status === "failed" ? body : null;
  }, { timeoutMs: 30_000 });
  expect(meeting.error?.code).toBe("transcription_failed");
  // No paid call was ever admitted: the attempt ledger stays empty and Tinfoil was never invoked.
  const [attempts] = await h.ctx.db.execute<{ n: number }>(
    sql`select count(*)::int as n from attributed_attempts a join attributed_batches b on a.batch_id = b.id where b.meeting_id = ${id}`,
  );
  expect(attempts.n).toBe(0);
  expect(tinfoilCalls).toBe(baselineTinfoilCalls);
  // Settled means settled: further finalize/reconcile wakeups must not trigger another fetch.
  expect(h.vexa.requests.filter((request) => request.path === path).length).toBe(4);
  await finalizeAttributedRun(h.ctx, id);
  await reconcileAttributedRuns(h.ctx);
  await h.waitFor(async () => (await h.ctx.queue.pending()).delayed.length === 0 || null, { timeoutMs: 10_000 }).catch(() => {});
  expect(h.vexa.requests.filter((request) => request.path === path).length).toBe(4);
}, 60_000);

// Only failed range fetches spend the durable retry budget: a batch deferred on dispatch capacity
// must still retry after a later transient 404, and waiting on capacity must not re-fetch retained
// audio in a tight loop (TC-576).
test("capacity deferrals do not spend the fetch budget and requeue at the poll interval", async () => {
  const baselineTinfoilCalls = tinfoilCalls;
  const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.google.com/fetch-bound-2" } });
  const { id } = await created.json();
  const native = "fetch-bound-2";
  const bot = await h.waitFor(async () => h.vexa.meetings.get(`google_meet/${native}`) ?? null, { timeoutMs: 30_000 });
  const path = `/meetings/${bot.id}/attributed-audio/ranges/0`;
  // Hold both dispatch slots so every admitted-path hop defers on capacity.
  await h.ctx.db.update(tinfoilDispatchSlots).set({ claimToken: "held", claimedAt: new Date(), ownerId: "other-worker" });
  await h.vexa.control("google_meet", native, {
    status: "completed", completion_reason: "stopped",
    attributed_audio_capability: { requested_version: 1, supported_version: 1, status: "supported" },
    attributed_audio_manifest: { version: 1, meeting_id: String(bot.id), state: "closed", clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, ranges: [rangeSpec(bot.id, path)] },
    attributed_audio_base64: { [path]: Buffer.from(pcm).toString("base64") },
  });
  const batch = await h.waitFor(async () => {
    const [row] = await h.ctx.db.select().from(attributedBatches).where(eq(attributedBatches.meetingId, id));
    return row?.status === "pending" ? row : null;
  }, { timeoutMs: 30_000, label: "batch deferred on capacity" });
  // Measure the requeue rate against the wall clock — this test deliberately times real dequeue
  // cadence, which fake timers cannot drive. ~20 fetches/sec at a 50 ms poll interval vs ~170/sec
  // when the capacity branch re-pushed through an immediate finalize wakeup.
  const fetchesAt = () => h.vexa.requests.filter((request) => request.path === path).length;
  await h.waitFor(async () => fetchesAt() >= 3 || null, { timeoutMs: 30_000, label: "capacity churn live" });
  const before = fetchesAt();
  await Bun.sleep(1000);
  expect(fetchesAt() - before).toBeLessThanOrEqual(40);
  const [stillPending] = await h.ctx.db.select().from(attributedBatches).where(eq(attributedBatches.id, batch.id));
  expect(stillPending.status).toBe("pending");
  expect(stillPending.fetchAttempts).toBe(0);
  // One transient 404 while still capacity-blocked spends exactly one retry.
  await h.vexa.control("google_meet", native, { attributed_audio_base64: {} });
  await h.waitFor(async () => {
    const [row] = await h.ctx.db.select().from(attributedBatches).where(eq(attributedBatches.id, batch.id));
    return row && row.fetchAttempts >= 1 ? row : null;
  }, { timeoutMs: 30_000, label: "transient fetch failure counted once" });
  // Audio returns and capacity opens: the batch completes on its first paid call.
  await h.vexa.control("google_meet", native, { attributed_audio_base64: { [path]: Buffer.from(pcm).toString("base64") } });
  await h.ctx.db.update(tinfoilDispatchSlots).set({ claimToken: null, claimedAt: null, ownerId: null });
  await h.waitFor(async () => {
    const body = await (await h.api(`/v1/meetings/${id}`)).json(); return body.status === "completed" ? body : null;
  }, { timeoutMs: 30_000, label: "meeting completed after capacity cleared" });
  const [settled] = await h.ctx.db.select().from(attributedBatches).where(eq(attributedBatches.id, batch.id));
  expect(settled.status).toBe("completed");
  expect(settled.attempts).toBe(1);
  expect(settled.fetchAttempts).toBeLessThanOrEqual(3);
  expect(settled.fetchAttempts).toBeGreaterThanOrEqual(1);
  expect(tinfoilCalls).toBe(baselineTinfoilCalls + 1);
}, 60_000);

// reconcileAttributedRuns polls run-less and fallback processing meetings so a lost chain wakeup
// self-heals — but while a poll lease is live that push is pure queue churn and must be skipped,
// as reconcileMeetingWakeups already does (TC-576).
test("attributed reconciliation never pushes a tokenless poll while a lease is live", async () => {
  const created = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://meet.google.com/lease-skip-1" } });
  const { id } = await created.json();
  const native = "lease-skip-1";
  const bot = await h.waitFor(async () => h.vexa.meetings.get(`google_meet/${native}`) ?? null, { timeoutMs: 30_000 });
  const [owner] = await h.ctx.db.select({ projectId: meetings.projectId }).from(meetings).where(eq(meetings.id, id));

  // Skip case: a processing meeting whose meeting.poll chain already owns the lease. Claiming the
  // lease directly (same primitive startPollChain uses) models a live chain on another hop without
  // depending on the real chain's renewal timing.
  const leased = `${id}-leased`;
  await h.ctx.db.insert(meetings).values({
    id: leased,
    projectId: owner!.projectId,
    meetingUrl: "https://meet.google.com/lease-held",
    platform: "google_meet",
    status: "processing",
    vexaPlatform: "google_meet",
    vexaNativeMeetingId: "lease-held",
    vexaMeetingId: 999_999_998,
  });
  expect(await h.ctx.queue.claimPollLease(leased, "held-by-live-chain", 60_000)).toBe(true);
  await reconcileAttributedRuns(h.ctx);
  const { ready, delayed } = await h.ctx.queue.pending();
  const pushed = [...ready, ...delayed.map((entry) => entry.job)]
    .filter((job) => job.type === "meeting.poll" && job.meetingId === leased);
  expect(pushed).toHaveLength(0);

  // No-lease case: an orphaned processing meeting (fallback run, no chain) must still get its
  // tokenless poll. A run row excludes it from reconcileMeetingWakeups, so only
  // reconcileAttributedRuns can push it; the poll then 404s on Vexa and fails the meeting.
  const orphan = `${id}-orphan`;
  await h.ctx.db.insert(meetings).values({
    id: orphan,
    projectId: owner!.projectId,
    meetingUrl: "https://meet.google.com/lease-orphan",
    platform: "google_meet",
    status: "processing",
    vexaPlatform: "google_meet",
    vexaNativeMeetingId: "lease-orphan",
    vexaMeetingId: 999_999_999,
  });
  await h.ctx.db.insert(attributedTranscriptionRuns).values({ meetingId: orphan, status: "fallback", manifestJson: {} });
  await reconcileAttributedRuns(h.ctx);
  await h.waitFor(async () => {
    const [row] = await h.ctx.db.select().from(meetings).where(eq(meetings.id, orphan));
    return row?.status === "failed" ? row : null;
  }, { timeoutMs: 10_000, label: "orphaned processing meeting polled to failure" });

  // End-to-end shape: a real completed meeting with an open manifest and no recording lands on the
  // fallback path and is failed by its own live poll chain.
  await h.vexa.control("google_meet", native, {
    status: "completed", completion_reason: "stopped",
    attributed_audio_capability: { requested_version: 1, supported_version: 1, status: "supported" },
    attributed_audio_manifest: { version: 1, meeting_id: String(bot.id), state: "open", clock_origin: "first_admitted_capture_epoch_ms", clock_origin_ms: 0, ranges: [] },
  });
  const run = await h.waitFor(async () => {
    const [row] = await h.ctx.db.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, id));
    return row?.status === "fallback" ? row : null;
  }, { timeoutMs: 30_000, label: "fallback marker staged" });
  expect(run.status).toBe("fallback");
  await reconcileAttributedRuns(h.ctx); // exercises the skip branch against the live chain's lease
  await h.waitFor(async () => {
    const body = await (await h.api(`/v1/meetings/${id}`)).json(); return body.status === "failed" ? body : null;
  }, { timeoutMs: 30_000, label: "fallback meeting failed" });
}, 60_000);
