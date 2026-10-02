import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { TinfoilTranscriptionProvider } from "../../src/providers/transcription/tinfoil.ts";
import { PCM_RATE, pcmToWav } from "../../src/providers/transcription/audio.ts";
import { admitRecordingRecovery, heartbeatRecordingRecovery } from "../../src/services/recording-recovery.ts";
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

beforeAll(async () => {
  h = await startHarness({
    transcriptRecovery: new TinfoilTranscriptionProvider({
      baseUrl: "https://tinfoil.test",
      apiKey: "test",
      model: "voxtral-small-24b",
      fetch: (async () => {
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
      }) as unknown as typeof fetch,
    }),
    // Shared Redis connections must not idle in a 1 s BRPOP while lease renewals race; see
    // test/integration/poll-lease.test.ts for the same constraint.
    workerPopTimeoutSec: .05,
    workerHeartbeatIntervalMs: 25,
  });
});
afterAll(() => h.stop());

const waitStatus = (id: string, status: string) => h.waitFor(async () => {
  const body = await (await h.api(`/v1/meetings/${id}`)).json();
  return body.status === status ? body : null;
});

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
