import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { meetings } from "../../src/db/schema.ts";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { PCM_RATE, pcmToWav } from "../../src/providers/transcription/audio.ts";
import { admitRecordingRecovery, failMeetingUnlessRecoveryLive, heartbeatRecordingRecovery, MIN_RECOVERY_ACK_BUDGET_MS, recoveryAckBudgetMs, releaseRecordingRecovery } from "../../src/services/recording-recovery.ts";
import { startWorker, type WorkerHandle } from "../../src/worker/index.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
let paidCalls = 0;
let inflight = 0;
let maxInflight = 0;
// Held open while a paid call must stay in flight; each test installs a fresh gate.
let gate: { promise: Promise<void>; resolve: () => void } | null = null;
// Fires inside the first paid provider call of a test (arming lease-loss injection).
let onFirstCall: (() => void) | null = null;
// Per-call failure for tests that need the provider to reject.
let failNextStatus: number | null = null;

const recordingBase64 = Buffer.from(pcmToWav(new Int16Array(PCM_RATE).fill(2_000), PCM_RATE)).toString("base64");

const paidFetch = (async () => {
  inflight++;
  maxInflight = Math.max(maxInflight, inflight);
  paidCalls++;
  onFirstCall?.();
  try {
    if (gate) await gate.promise;
    if (failNextStatus) {
      const status = failNextStatus;
      failNextStatus = null;
      return new Response("rejected", { status });
    }
    return Response.json({ text: "Recovered remarks.", language: "en", duration: 5 });
  } finally {
    inflight--;
  }
}) as unknown as typeof fetch;

beforeAll(async () => {
  h = await startHarness({
    transcriptRecovery: new TinfoilTranscriptionProvider({
      baseUrl: "https://tinfoil.test",
      apiKey: "test",
      model: "voxtral-small-24b",
      fetch: paidFetch,
    }),
    // Shared Redis connections must not idle in a 1 s BRPOP while lease renewals race; see
    // test/integration/poll-lease.test.ts for the same constraint.
    workerPopTimeoutSec: .05,
    workerHeartbeatIntervalMs: 25,
  });
});
afterAll(() => h.stop());

const waitStatus = (id: string, status: string, timeoutMs = 5_000) => h.waitFor(async () => {
  const body = await (await h.api(`/v1/meetings/${id}`)).json();
  return body.status === status ? body : null;
}, { timeoutMs, label: `status ${status}` });

const recoveryRun = async (id: string) =>
  (await h.ctx.db.execute(sql`select owner_token, admitted_at, admissions, outcome from recording_recovery_runs where meeting_id = ${id}`))[0] as
    | { owner_token: string | null; admitted_at: Date | null; admissions: number; outcome: string | null }
    | undefined;

const ageAdmission = (id: string, minutes: number) =>
  h.ctx.db.execute(sql`update recording_recovery_runs set admitted_at = now() - ${sql.raw(`interval '${minutes} minutes'`)} where meeting_id = ${id}`);

/** Provider GET /transcripts/* requests observed by mock Vexa — one per poll hop per worker. */
const vexaPollCount = () =>
  h.vexa.requests.filter((r: { method: string; path: string }) => r.method === "GET" && r.path.startsWith("/transcripts/")).length;

/** Unpaid recording reads observed by mock Vexa. */
const recordingFetches = () =>
  h.vexa.requests.filter((r: { method: string; path: string }) => r.method === "GET" && r.path.startsWith("/recordings")).length;

/** The Redis lease key's current owner token (private field reached for verification only). */
const leaseOwner = async (meetingId: string) =>
  h.ctx.redis.get((h.ctx.queue as unknown as { pollLease: (id: string) => string }).pollLease(meetingId));

/** Completes the capture with a materially incomplete native timeline plus a retained recording. */
const incompleteCapture = (native: string, segments: object[] = [{ start: 110, end: 120, text: "Only the ending survived.", speaker: "Alice", completed: true }]) =>
  h.vexa.control("jitsi", native, {
    status: "completed",
    completion_reason: "stopped",
    start_time: "2026-10-02T10:00:00.000Z",
    end_time: "2026-10-02T10:02:00.000Z",
    segments,
    recording_base64: recordingBase64,
  });

/**
 * Records the token of the first successful poll-lease claim for `meetingId` and, once armed,
 * makes every renewal for that token throw — worker A's "Redis error" from the issue while a
 * second worker's renewals keep working.
 */
function injectRenewalFailure(meetingId: string) {
  let armed = false;
  let token: string | undefined;
  const origClaim = h.ctx.queue.claimPollLease.bind(h.ctx.queue);
  const origRenew = h.ctx.queue.renewPollLease.bind(h.ctx.queue);
  h.ctx.queue.claimPollLease = async (id, candidate, ttlMs) => {
    const claimed = await origClaim(id, candidate, ttlMs);
    if (claimed && id === meetingId && !token) token = candidate;
    return claimed;
  };
  h.ctx.queue.renewPollLease = async (id, candidate, ttlMs) => {
    if (armed && id === meetingId && candidate === token) throw new Error("injected renewal failure");
    return origRenew(id, candidate, ttlMs);
  };
  return {
    arm: () => { armed = true; },
    token: () => token,
    restore: () => {
      h.ctx.queue.claimPollLease = origClaim;
      h.ctx.queue.renewPollLease = origRenew;
    },
  };
}

test("a poll chain that loses its lease mid-recovery cannot run a second paid call", async () => {
  paidCalls = 0; inflight = 0; maxInflight = 0;
  gate = Promise.withResolvers<void>();
  const releaseGate = gate.resolve;

  const res = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/LeaseLossRecovery" } });
  const { id: meetingId } = await res.json();
  const injection = injectRenewalFailure(meetingId);
  const second: { worker: WorkerHandle | null } = { worker: null };
  try {
    await h.waitFor(async () => h.vexa.meetings.has("jitsi/LeaseLossRecovery@jitsi.local") ? true : null, { timeoutMs: 2_000, label: "bot dispatch" });
    await h.vexa.control("jitsi", "LeaseLossRecovery@jitsi.local", { status: "active" });
    // The second worker competes for the same queue/meeting; its Redis path stays healthy.
    second.worker = startWorker(h.ctx, { popTimeoutSec: .05, heartbeatIntervalMs: 25 });
    // Renewals for the paying chain start failing only once the paid call is in flight.
    onFirstCall = () => injection.arm();
    await incompleteCapture("LeaseLossRecovery@jitsi.local");

    await h.waitFor(async () => inflight === 1 ? true : null, { timeoutMs: 4_000, label: "paid call in flight" });
    const pollsAtTakeover = vexaPollCount();
    const fetchesAtTakeover = recordingFetches();
    // Lease expires under failed renewals (~150 ms TTL); a takeover claims it while worker A is
    // still inside the provider call.
    await h.waitFor(async () => {
      const owner = await leaseOwner(meetingId);
      return owner && injection.token() && owner !== injection.token() ? owner : null;
    }, { timeoutMs: 4_000, label: "lease takeover" });
    // The takeover chain must keep polling — each hop sees the live admission and defers before
    // touching Vexa's recordings: no paid call, and no readiness attempt burned either.
    await h.waitFor(async () => vexaPollCount() >= pollsAtTakeover + 2 ? true : null, { timeoutMs: 4_000, label: "takeover chain deferral hops" });
    expect(paidCalls).toBe(1);
    expect(recordingFetches()).toBe(fetchesAtTakeover);

    releaseGate();
    await waitStatus(meetingId, "completed");
  } finally {
    releaseGate();
    await second.worker?.stop();
    injection.restore();
    gate = null;
    onFirstCall = null;
  }
  expect(paidCalls).toBe(1);
  expect(maxInflight).toBe(1);
  const run = await recoveryRun(meetingId);
  expect(run).toMatchObject({ admissions: 1, outcome: "succeeded" });
}, 20_000);

test("a poll that lost its lease before recovery is fenced off the paid call", async () => {
  paidCalls = 0; inflight = 0; maxInflight = 0;
  gate = null;

  const res = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/LostBeforeRecovery" } });
  const { id: meetingId } = await res.json();
  const injection = injectRenewalFailure(meetingId);
  const second: { worker: WorkerHandle | null } = { worker: null };

  // Arm injection on the last unpaid transcript read: renewal failure then costs the chain its
  // lease (~150 ms TTL) and a takeover claims it before the chain reaches the paid boundary.
  // The wait is event-driven: it observes the real lease key, not a guessed duration.
  const origGet = h.ctx.vexa.getTranscript.bind(h.ctx.vexa);
  let armedOnce = false;
  h.ctx.vexa.getTranscript = async (platform: string, id: string) => {
    const result = await origGet(platform, id);
    if (!armedOnce && platform === "jitsi" && id === "LostBeforeRecovery@jitsi.local" && result.status === "completed") {
      armedOnce = true;
      injection.arm();
      await h.waitFor(async () => {
        const owner = await leaseOwner(meetingId);
        return owner && injection.token() && owner !== injection.token() ? true : null;
      }, { timeoutMs: 4_000, label: "lease takeover before paid boundary" });
    }
    return result;
  };
  try {
    await h.waitFor(async () => h.vexa.meetings.has("jitsi/LostBeforeRecovery@jitsi.local") ? true : null, { timeoutMs: 2_000, label: "bot dispatch" });
    await h.vexa.control("jitsi", "LostBeforeRecovery@jitsi.local", { status: "active" });
    second.worker = startWorker(h.ctx, { popTimeoutSec: .05, heartbeatIntervalMs: 25 });
    await incompleteCapture("LostBeforeRecovery@jitsi.local");

    await waitStatus(meetingId, "completed");
  } finally {
    await second.worker?.stop();
    injection.restore();
    h.ctx.vexa.getTranscript = origGet;
  }
  // The takeover worker paid exactly once; the chain that lost the lease skipped the call, so no
  // second admission exists either.
  expect(paidCalls).toBe(1);
  const run = await recoveryRun(meetingId);
  expect(run).toMatchObject({ admissions: 1, outcome: "succeeded" });
}, 20_000);

test("a heart-beating admission is never overlapped; a stopped one yields once, bounded", async () => {
  paidCalls = 0; inflight = 0; maxInflight = 0;
  gate = Promise.withResolvers<void>();
  const releaseGate = gate.resolve;

  const res = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/RecoveryAdmission" } });
  const { id: meetingId } = await res.json();
  try {
    await h.waitFor(async () => h.vexa.meetings.has("jitsi/RecoveryAdmission@jitsi.local") ? true : null, { timeoutMs: 2_000, label: "bot dispatch" });
    await h.vexa.control("jitsi", "RecoveryAdmission@jitsi.local", { status: "active" });
    await incompleteCapture("RecoveryAdmission@jitsi.local");

    // Worker A holds the live admission inside the gated provider call. A concurrent poll
    // (post-takeover or repeated fallback) must defer, never admit.
    await h.waitFor(async () => inflight === 1 ? true : null, { timeoutMs: 4_000, label: "paid call in flight" });
    expect(await admitRecordingRecovery(h.ctx, meetingId)).toEqual({ kind: "deferred" });

    // A long transcription can outlast the raw timestamp bound: a still-beating owner refreshes
    // admitted_at and keeps deferring re-admission, so re-admission can never overlap it.
    const owner = (await recoveryRun(meetingId))!.owner_token!;
    await ageAdmission(meetingId, 11);
    expect(await heartbeatRecordingRecovery(h.ctx, meetingId, owner)).toBe(true);
    expect(await admitRecordingRecovery(h.ctx, meetingId)).toEqual({ kind: "deferred" });
    expect(await recoveryRun(meetingId)).toMatchObject({ admissions: 1, owner_token: owner });
    // A foreign token cannot heartbeat the row.
    expect(await heartbeatRecordingRecovery(h.ctx, meetingId, "not-the-owner")).toBe(false);

    // The heartbeat stops (owner crash): only now does a stale row admit, and only once.
    await ageAdmission(meetingId, 11);
    const re = await admitRecordingRecovery(h.ctx, meetingId);
    expect(re).toMatchObject({ kind: "admitted" });
    expect(await recoveryRun(meetingId)).toMatchObject({ admissions: 2 });

    // The bound is spent: a further stale admission settles the row exhausted, terminal.
    await ageAdmission(meetingId, 11);
    expect(await admitRecordingRecovery(h.ctx, meetingId)).toEqual({ kind: "settled", outcome: "exhausted" });
    expect(await recoveryRun(meetingId)).toMatchObject({ admissions: 2, outcome: "exhausted" });

    // The legitimately admitted call still completes the meeting; its settle CAS misses the
    // re-admitted token, leaving the durable exhausted outcome in place.
    releaseGate();
    await waitStatus(meetingId, "completed");
  } finally {
    releaseGate();
    gate = null;
  }
  expect(paidCalls).toBe(1);
  expect(await recoveryRun(meetingId)).toMatchObject({ admissions: 2, outcome: "exhausted" });
}, 20_000);

test("explicit recovery opens a fresh admission round over a terminal outcome", async () => {
  paidCalls = 0; inflight = 0; maxInflight = 0;
  gate = null;

  const res = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/RecoverRound" } });
  const { id: meetingId } = await res.json();
  try {
    await h.waitFor(async () => h.vexa.meetings.has("jitsi/RecoverRound@jitsi.local") ? true : null, { timeoutMs: 2_000, label: "bot dispatch" });
    await h.vexa.control("jitsi", "RecoverRound@jitsi.local", { status: "active" });
    // No native words: a failed paid call ends the meeting failed rather than preserving segments.
    failNextStatus = 400;
    await incompleteCapture("RecoverRound@jitsi.local", []);
    await waitStatus(meetingId, "failed");
    // A definitive 400 rejection is a paid dispatch with a conclusive answer: outcome "failed".
    expect(paidCalls).toBe(1);
    expect(await recoveryRun(meetingId)).toMatchObject({ admissions: 1, outcome: "failed" });

    // Operator recovery opens a fresh bounded round: the terminal row is reset and the next poll
    // is admitted again (this time the provider answers).
    const recovered = await h.api(`/v1/meetings/${meetingId}/recover`, { method: "POST" });
    expect(recovered.status).toBe(200);
    await waitStatus(meetingId, "completed");
    expect(paidCalls).toBe(2);
    expect(await recoveryRun(meetingId)).toMatchObject({ admissions: 1, outcome: "succeeded" });
  } finally {
    failNextStatus = null;
    gate = null;
  }
}, 20_000);

test("recover on a live admission is a no-op wakeup and never resets the round", async () => {
  paidCalls = 0; inflight = 0; maxInflight = 0;
  gate = Promise.withResolvers<void>();
  const releaseGate = gate.resolve;

  const res = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/RecoverLive" } });
  const { id: meetingId } = await res.json();
  try {
    await h.waitFor(async () => h.vexa.meetings.has("jitsi/RecoverLive@jitsi.local") ? true : null, { timeoutMs: 2_000, label: "bot dispatch" });
    await h.vexa.control("jitsi", "RecoverLive@jitsi.local", { status: "active" });
    await incompleteCapture("RecoverLive@jitsi.local");
    await h.waitFor(async () => inflight === 1 ? true : null, { timeoutMs: 4_000, label: "paid call in flight" });

    // A duplicate recover while an admission is in flight only pushes a wakeup: the row is
    // untouched (owner, timestamp and admission count all preserved).
    const before = await recoveryRun(meetingId);
    const recovered = await h.api(`/v1/meetings/${meetingId}/recover`, { method: "POST" });
    expect(recovered.status).toBe(200);
    expect(await recoveryRun(meetingId)).toEqual(before);

    releaseGate();
    await waitStatus(meetingId, "completed");
    expect(await recoveryRun(meetingId)).toMatchObject({ admissions: 1, outcome: "succeeded" });
  } finally {
    releaseGate();
    gate = null;
  }
  expect(paidCalls).toBe(1);
}, 20_000);

// Lets a test re-gate the next paid call while the first is still resolving.
let gateAfterFirst: { promise: Promise<void>; resolve: () => void } | null = null;

/** Installs a short-wave recovery provider with a small admission window for heartbeat tests. */
const smallWindowRecovery = (admissionMs = 800) => {
  const previous = {
    transcriptRecovery: h.ctx.transcriptRecovery,
    admissionMs: h.ctx.config.recordingRecovery.admissionMs,
    delay: h.ctx.recoveryHeartbeatDelay,
  };
  h.ctx.transcriptRecovery = new TinfoilTranscriptionProvider({
    baseUrl: "https://tinfoil.test",
    apiKey: "test",
    model: "voxtral-small-24b",
    fetch: paidFetch,
    wholeChunkSec: 1,
    concurrency: 1,
    timeoutMs: 100,
    maxRetries: 1,
    retryDelayMs: 100,
  });
  h.ctx.config.recordingRecovery.admissionMs = admissionMs;
  return () => {
    h.ctx.transcriptRecovery = previous.transcriptRecovery;
    h.ctx.config.recordingRecovery.admissionMs = previous.admissionMs;
    h.ctx.recoveryHeartbeatDelay = previous.delay;
  };
};

/** ~2.5 s of loud PCM — three single-chunk waves under wholeChunkSec 1. */
const threeWaveRecording = () =>
  Buffer.from(pcmToWav(new Int16Array(Math.floor(PCM_RATE * 2.5)).fill(2_000), PCM_RATE)).toString("base64");

const incompleteThreeWaveCapture = (native: string) =>
  h.vexa.control("jitsi", native, {
    status: "completed",
    completion_reason: "stopped",
    start_time: "2026-10-02T10:00:00.000Z",
    end_time: "2026-10-02T10:02:00.000Z",
    segments: [{ start: 110, end: 120, text: "Only the ending survived.", speaker: "Alice", completed: true }],
    recording_base64: threeWaveRecording(),
  });

test("a delayed heartbeat acknowledgement cannot authorize a wave after takeover", async () => {
  paidCalls = 0; inflight = 0; maxInflight = 0;
  gate = Promise.withResolvers<void>();
  const releaseGate = gate.resolve;
  const restore = smallWindowRecovery();
  let beats = 0;
  // The second heartbeat's acknowledgement resolves only after the 800 ms admission window has
  // lapsed — its CAS committed on time, but the stale row may already be re-admitted, so the
  // ack must not authorize admission 1's next wave.
  const heldAck = Promise.withResolvers<void>();
  h.ctx.recoveryHeartbeatDelay = async () => {
    if (++beats === 2) {
      await Bun.sleep(1_000);
      heldAck.resolve();
    }
  };

  const res = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/LateAck" } });
  const { id: meetingId } = await res.json();
  try {
    await h.waitFor(async () => h.vexa.meetings.has("jitsi/LateAck@jitsi.local") ? true : null, { timeoutMs: 2_000, label: "bot dispatch" });
    await h.vexa.control("jitsi", "LateAck@jitsi.local", { status: "active" });
    await incompleteThreeWaveCapture("LateAck@jitsi.local");

    await h.waitFor(async () => inflight === 1 ? true : null, { timeoutMs: 4_000, label: "paid call in flight" });
    // Re-gate before releasing call 1 so the next paid call is observable.
    gateAfterFirst = Promise.withResolvers<void>();
    gate = gateAfterFirst;
    releaseGate();
    // The second heartbeat's acknowledgement resolves on its own after the 800 ms window lapses.
    // The withheld wave ends admission 1's job, which frees the poll lease; the reconciler
    // re-arms a chain that re-admits the now-stale row and reaches the paid boundary.
    await h.waitFor(async () => paidCalls === 2 ? true : null, { timeoutMs: 8_000, label: "re-admitted paid call" });
    // Call 2 belongs to the re-admitted owner; the late ack never authorized admission 1's wave.
    expect(await recoveryRun(meetingId)).toMatchObject({ admissions: 2 });
    expect(maxInflight).toBe(1);
    gateAfterFirst.resolve();
    await waitStatus(meetingId, "completed", 20_000);
  } finally {
    heldAck.resolve();
    gateAfterFirst?.resolve();
    gateAfterFirst = null;
    gate = null;
    restore();
  }
  // Admission 1 paid for exactly one wave; the re-admitted owner paid for its own fresh-heartbeat
  // waves. Neither call overlapped another.
  expect(maxInflight).toBe(1);
  expect(await recoveryRun(meetingId)).toMatchObject({ admissions: 2, outcome: "succeeded" });
}, 30_000);

test("a live-but-late first heartbeat frees its admission without spending the re-admission", async () => {
  paidCalls = 0; inflight = 0; maxInflight = 0;
  gate = null;
  const restore = smallWindowRecovery();
  let beats = 0;
  // The very first heartbeat's acknowledgement resolves past the freshness budget: nothing paid
  // has left yet, so the admission is released — the next poll re-grants the freed slot without
  // consuming the bounded takeover count.
  h.ctx.recoveryHeartbeatDelay = async () => {
    if (++beats === 1) await Bun.sleep(1_000);
  };

  const res = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/LateFirstBeat" } });
  const { id: meetingId } = await res.json();
  try {
    await h.waitFor(async () => h.vexa.meetings.has("jitsi/LateFirstBeat@jitsi.local") ? true : null, { timeoutMs: 2_000, label: "bot dispatch" });
    await h.vexa.control("jitsi", "LateFirstBeat@jitsi.local", { status: "active" });
    await incompleteThreeWaveCapture("LateFirstBeat@jitsi.local");
    await waitStatus(meetingId, "completed", 20_000);
  } finally {
    gate = null;
    restore();
  }
  // The released slot was re-granted (admissions stays 1), the fresh beats drove all three waves,
  // and the outcome is a clean success — not the exhaustion a held-until-stale admission costs.
  expect(paidCalls).toBe(3);
  expect(maxInflight).toBe(1);
  expect(await recoveryRun(meetingId)).toMatchObject({ admissions: 1, outcome: "succeeded" });
}, 30_000);

test("a backward wall-clock step cannot resurrect an expired heartbeat acknowledgement", async () => {
  paidCalls = 0; inflight = 0; maxInflight = 0;
  gate = Promise.withResolvers<void>();
  const releaseGate = gate.resolve;
  const restore = smallWindowRecovery();
  const realDateNow = Date.now;
  let beats = 0;
  // Admission 1's second heartbeat is held past the 800 ms window while the worker's wall clock
  // reads 2 s in the past — a Date.now-based freshness check computes a negative round trip and
  // would authorize a wave competing with the re-admitted owner's call. Restored on beat 3.
  const heldAck = Promise.withResolvers<void>();
  h.ctx.recoveryHeartbeatDelay = async () => {
    const beat = ++beats;
    if (beat === 2) {
      Date.now = () => realDateNow() - 2_000;
      await Bun.sleep(1_000);
      heldAck.resolve();
    }
    if (beat === 3) Date.now = realDateNow;
  };

  const res = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/ClockStep" } });
  const { id: meetingId } = await res.json();
  try {
    await h.waitFor(async () => h.vexa.meetings.has("jitsi/ClockStep@jitsi.local") ? true : null, { timeoutMs: 2_000, label: "bot dispatch" });
    await h.vexa.control("jitsi", "ClockStep@jitsi.local", { status: "active" });
    await incompleteThreeWaveCapture("ClockStep@jitsi.local");
    await h.waitFor(async () => inflight === 1 ? true : null, { timeoutMs: 4_000, label: "paid call in flight" });
    gateAfterFirst = Promise.withResolvers<void>();
    gate = gateAfterFirst;
    releaseGate();
    // The correct (monotonic) check withholds the stepped-clock ack; the job exits, frees the
    // poll lease, and the reconciler re-arms a chain that re-admits the stale row.
    await heldAck.promise;
    await h.waitFor(async () => paidCalls === 2 ? true : null, { timeoutMs: 8_000, label: "re-admitted paid call" });
    expect(await recoveryRun(meetingId)).toMatchObject({ admissions: 2 });
    expect(maxInflight).toBe(1);
    gateAfterFirst.resolve();
    await waitStatus(meetingId, "completed", 20_000);
  } finally {
    Date.now = realDateNow;
    heldAck.resolve();
    gateAfterFirst?.resolve();
    gateAfterFirst = null;
    gate = null;
    restore();
  }
  expect(maxInflight).toBe(1);
  expect(await recoveryRun(meetingId)).toMatchObject({ admissions: 2, outcome: "succeeded" });
}, 30_000);

test("a competing poll cannot fail a meeting while a paid admission is live", async () => {
  paidCalls = 0; inflight = 0; maxInflight = 0;

  gate = Promise.withResolvers<void>();
  const releaseGate = gate.resolve;

  const res = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/Poll404" } });
  const { id: meetingId } = await res.json();
  const injection = injectRenewalFailure(meetingId);
  const second: { worker: WorkerHandle | null } = { worker: null };
  try {
    await h.waitFor(async () => h.vexa.meetings.has("jitsi/Poll404@jitsi.local") ? true : null, { timeoutMs: 2_000, label: "bot dispatch" });
    await h.vexa.control("jitsi", "Poll404@jitsi.local", { status: "active" });
    second.worker = startWorker(h.ctx, { popTimeoutSec: .05, heartbeatIntervalMs: 25 });
    onFirstCall = () => injection.arm();
    await incompleteCapture("Poll404@jitsi.local");
    await h.waitFor(async () => inflight === 1 ? true : null, { timeoutMs: 4_000, label: "paid call in flight" });

    // Worker A holds the admission inside the gated paid call; its lease expires under injected
    // renewal failures, so worker B takes the poll chain over.
    await h.waitFor(async () => {
      const owner = await leaseOwner(meetingId);
      return owner && injection.token() && owner !== injection.token() ? owner : null;
    }, { timeoutMs: 4_000, label: "lease takeover" });

    // Now the provider loses the transcript record: B's next poll hop must defer on the live
    // admission instead of failing the meeting under A's in-flight paid call.
    await h.vexa.control("jitsi", "Poll404@jitsi.local", { transcript_missing: true });
    await Bun.sleep(300); // several takeover hops land on the 404 while the call stays in flight
    const meeting = await h.ctx.db.execute(sql`select status from meetings where id = ${meetingId}`) as unknown as { status: string }[];
    expect(meeting[0]!.status).toBe("processing");

    releaseGate();
    await waitStatus(meetingId, "completed");
  } finally {
    releaseGate();
    gate = null;
    onFirstCall = null;
    await second.worker?.stop();
    injection.restore();
  }
  expect(paidCalls).toBe(1);
  expect(maxInflight).toBe(1);
  expect(await recoveryRun(meetingId)).toMatchObject({ admissions: 1, outcome: "succeeded" });
}, 20_000);

test("check-and-fail is serialized with admission: a live one defers, a committed fail forecloses", async () => {
  paidCalls = 0; inflight = 0; maxInflight = 0;
  gate = null;

  const res = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/SerializedFail" } });
  const { id: meetingId } = await res.json();
  try {
    await h.waitFor(async () => h.vexa.meetings.has("jitsi/SerializedFail@jitsi.local") ? true : null, { timeoutMs: 2_000, label: "bot dispatch" });
    await h.vexa.control("jitsi", "SerializedFail@jitsi.local", { status: "active" });
    await waitStatus(meetingId, "in_progress");
    // Stand the meeting in the same state a poll hop reaches right before an admission.
    await h.ctx.db.execute(sql`update meetings set status = 'processing' where id = ${meetingId}`);

    // Case A: a live admission owns the outcome — the provider 404 must defer, never fail.
    const admission = await admitRecordingRecovery(h.ctx, meetingId);
    expect(admission).toMatchObject({ kind: "admitted" });
    await h.vexa.control("jitsi", "SerializedFail@jitsi.local", { transcript_missing: true });
    await Bun.sleep(300); // several poll hops hit the 404 while the admission is live
    const liveRow = await h.ctx.db.execute(sql`select status from meetings where id = ${meetingId}`) as unknown as { status: string }[];
    expect(liveRow[0]!.status).toBe("processing");
    // No hop may grant a second admission or dispatch paid work while the slot is live.
    expect(await recoveryRun(meetingId)).toMatchObject({ admissions: 1 });

    // Case B: once the owner frees the slot, the next hop's failure write commits under the same
    // lock the admission needs — a later grant can only observe a non-processing meeting.
    await releaseRecordingRecovery(h.ctx, meetingId, (admission as { token: string }).token);
    await waitStatus(meetingId, "failed");
    expect(await admitRecordingRecovery(h.ctx, meetingId)).toEqual({ kind: "ineligible" });
    expect(await recoveryRun(meetingId)).toMatchObject({ admissions: 1 });

    // Concurrent contention: for each round's processing meeting, many admit/fail pairs race.
    // Whichever serialized winner commits first decides the meeting — every later admit sees a
    // failed row, every later fail defers on a live admission. The postcondition is the fence
    // itself: a round may never end both failed AND holding a granted admission.
    for (let round = 0; round < 6; round++) {
      const barrageId = `mtg_fencerr_${round}`;
      await h.ctx.db.insert(meetings).values({
        id: barrageId,
        projectId: "demo",
        platform: "jitsi",
        status: "processing",
        meetingUrl: `https://jitsi.local/FenceRace${round}`,
      });
      // A held poll lease keeps the reconciler from pushing worker hops into the race.
      await h.ctx.queue.claimPollLease(barrageId, `fence-race-${round}`, 60_000);
      try {
        const [row] = await h.ctx.db.select().from(meetings).where(eq(meetings.id, barrageId));
        const pairs = Array.from({ length: 12 }, (_, i) =>
          i % 2 === 0
            ? admitRecordingRecovery(h.ctx, barrageId)
            : failMeetingUnlessRecoveryLive(h.ctx, row!, "capture_failed", "racing failure write"));
        const results = await Promise.all(pairs);
        const grants = results.filter((r) => (r as { kind?: string }).kind === "admitted").length;
        const [final] = await h.ctx.db.select({ status: meetings.status }).from(meetings).where(eq(meetings.id, barrageId));
        expect(final!.status === "failed" && grants > 0).toBe(false);
      } finally {
        await h.ctx.db.execute(sql`update meetings set status = 'failed' where id = ${barrageId} and status = 'processing'`);
        await h.ctx.queue.releasePollLease(barrageId, `fence-race-${round}`);
      }
    }
  } finally {
    gate = null;
  }
}, 20_000);

test("worker startup requires a real acknowledgement budget, not just a positive one", () => {
  const origAdmission = h.ctx.config.recordingRecovery.admissionMs;
  const waveMs = h.ctx.transcriptRecovery!.maxRequestWaveMs!;
  try {
    // The default 600 s window leaves ~234 s of acknowledgement budget.
    const worker = startWorker(h.ctx, { popTimeoutSec: .05 });
    void worker.stop();
    // Opus's repro: 366251 clears the 365250 wave + 5000 margin guard by 1 ms and was accepted;
    // a 1 ms budget marks every heartbeat ack stale and livelocks admit → release → re-admit.
    h.ctx.config.recordingRecovery.admissionMs = waveMs + 5_001;
    expect(recoveryAckBudgetMs(h.ctx)).toBe(1);
    expect(() => startWorker(h.ctx)).toThrow(/RECORDING_RECOVERY_ADMISSION_MS/);
    // The floor is the named minimum budget, not the wave bound.
    h.ctx.config.recordingRecovery.admissionMs = waveMs + 5_000 + MIN_RECOVERY_ACK_BUDGET_MS;
    const ok = startWorker(h.ctx, { popTimeoutSec: .05 });
    void ok.stop();
    // NaN is defence-in-depth (config parsing already rejects non-integer env values).
    h.ctx.config.recordingRecovery.admissionMs = Number.NaN;
    expect(() => startWorker(h.ctx)).toThrow(/RECORDING_RECOVERY_ADMISSION_MS/);
  } finally {
    h.ctx.config.recordingRecovery.admissionMs = origAdmission;
  }
});
