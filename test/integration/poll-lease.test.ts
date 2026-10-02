import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, type Harness } from "./harness.ts";
import { handleMeetingPoll } from "../../src/worker/meeting-job.ts";
import { startWorker, type WorkerHandle } from "../../src/worker/index.ts";
import type { Job } from "../../src/worker/queue.ts";

let h: Harness;

beforeAll(async () => {
  h = await startHarness({
    enabledPlatforms: ["jitsi"],
    // Exercise the durable scanner independently of Bun's five-second test deadline.
    workerHeartbeatIntervalMs: 25,
    workerPopTimeoutSec: .05,
  });
});
afterAll(async () => h.stop());

const pendingPolls = async (meetingId: string): Promise<number> => {
  const { ready, delayed } = await h.ctx.queue.pending();
  return ready.filter((j) => j.type === "meeting.poll" && j.meetingId === meetingId).length
    + delayed.filter((d) => d.job.type === "meeting.poll" && d.job.meetingId === meetingId).length;
};

const vexaPollCount = () =>
  h.vexa.requests.filter((r: { method: string; path: string }) => r.method === "GET" && r.path.startsWith("/transcripts/")).length;

/** Counts tokenless meeting.poll pushes (wakeups) for one meeting while `fn` runs. */
const countWakeupPushes = async (meetingId: string, fn: () => Promise<void>): Promise<number> => {
  const originalPush = h.ctx.queue.push.bind(h.ctx.queue);
  let wakeups = 0;
  h.ctx.queue.push = async (job: Job, delayMs = 0) => {
    if (job.type === "meeting.poll" && job.meetingId === meetingId && !job.pollToken) wakeups++;
    return originalPush(job, delayMs);
  };
  try {
    await fn();
  } finally {
    h.ctx.queue.push = originalPush;
  }
  return wakeups;
};

test("heartbeats keep one live poll chain per meeting and restart a lost chain", async () => {
  // One active meeting; heartbeats arrive ~2x per poll hop the whole time.
  const res = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/PollLease" } });
  expect(res.status).toBe(201);
  const { id: meetingId } = await res.json();

  await h.waitFor(async () => h.vexa.meetings.has("jitsi/PollLease@jitsi.local") ? true : null, { timeoutMs: 2_000, label: "bot dispatch" });
  await h.vexa.control("jitsi", "PollLease@jitsi.local", { status: "active" });
  await h.waitFor(async () => vexaPollCount() >= 2 ? true : null, { timeoutMs: 2_000, label: "first polls" });

  // A tokenless meeting.poll push is a wakeup. While a chain is live, reconciliation must push
  // none: its EXISTS check skips the meeting, and any wakeup that still lands cannot claim the
  // lease. The sampling window spans ~20 heartbeats on the platform clock, so real sleeps are
  // required — fake timers cannot drive the worker's setInterval.
  const pollsBefore = vexaPollCount();
  const wakeupPushes = await countWakeupPushes(meetingId, async () => {
    for (let i = 0; i < 20; i++) {
      const count = await pendingPolls(meetingId);
      expect(count).toBeLessThanOrEqual(1);
      await Bun.sleep(25);
    }
  });
  expect(wakeupPushes).toBe(0);

  // Polls are real provider traffic at roughly one per interval across the ~600 ms window, not a
  // heartbeat-driven storm (~1 chain ≈ 12 polls; each extra chain adds the same rate again).
  const observedDelta = vexaPollCount() - pollsBefore;
  expect(observedDelta).toBeGreaterThan(0);
  expect(observedDelta).toBeLessThanOrEqual(25);

  // A lost wakeup (dropped Redis job) must be repaired. Drop the chain's next continuation
  // deterministically — no poll can be in flight once its continuation push has been intercepted.
  // The pushed job never lands, so the lease is orphaned rather than released; it must expire,
  // after which heartbeat reconciliation pushes a tokenless wakeup that starts a fresh chain.
  let continuationDropped = false;
  const originalPush = h.ctx.queue.push.bind(h.ctx.queue);
  h.ctx.queue.push = async (job: Job, delayMs = 0) => {
    if (!continuationDropped && job.type === "meeting.poll" && job.meetingId === meetingId) {
      continuationDropped = true;
      return;
    }
    return originalPush(job, delayMs);
  };
  await h.waitFor(async () => continuationDropped ? true : null, { timeoutMs: 2_000, label: "continuation dropped" });
  h.ctx.queue.push = originalPush;
  const restartWakeups = await countWakeupPushes(meetingId, async () => {
    await h.waitFor(async () => (await pendingPolls(meetingId)) === 1 ? true : null, { timeoutMs: 2_000, label: "single chain restarted" });
  });
  // The repair came from reconciliation (a tokenless push), and it was the only one needed.
  expect(restartWakeups).toBeGreaterThanOrEqual(1);
  expect(restartWakeups).toBeLessThanOrEqual(3);
});

test("a tokened poll on a terminal meeting releases the chain's lease", async () => {
  // Direct handleMeetingPoll call stands in for the last hop of a dead chain: the meeting is
  // missing and the job still carries the chain's token. The lease must be released so a
  // recover/stop wakeup in the TTL window is not swallowed as a duplicate.
  const leaseId = `missing-${crypto.randomUUID()}`;
  expect(await h.ctx.queue.claimPollLease(leaseId, "tok", 60_000)).toBe(true);
  await handleMeetingPoll(h.ctx, leaseId, 1, "tok");
  expect(await h.ctx.queue.hasPollLease(leaseId)).toBe(false);
});

test("stop wakeups under a live chain no-op instead of splitting it", async () => {
  const res = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/StopWakeup" } });
  const { id: meetingId } = await res.json();
  await h.waitFor(async () => h.vexa.meetings.has("jitsi/StopWakeup@jitsi.local") ? true : null, { timeoutMs: 2_000, label: "bot dispatch" });
  await h.vexa.control("jitsi", "StopWakeup@jitsi.local", { status: "active" });
  // stopMeeting only pushes a poll wakeup for in_progress meetings; joining is cancelled inline.
  await h.waitFor(async () => (await h.api(`/v1/meetings/${meetingId}`)).json().then((m) => m.status === "in_progress" ? m.status : null), { timeoutMs: 2_000, label: "meeting in progress" });
  // POST /stop pushes a tokenless poll wakeup. It cannot claim the live chain's lease and must
  // not fork a second one; the next chain hop observes stop_requested/completed and finalizes.
  const wakeups = await countWakeupPushes(meetingId, async () => {
    const stopped = await h.api(`/v1/meetings/${meetingId}/stop`, { method: "POST" });
    expect(stopped.status).toBe(200);
  });
  expect(wakeups).toBe(1);
  expect(await pendingPolls(meetingId)).toBeLessThanOrEqual(2);
  await h.vexa.control("jitsi", "StopWakeup@jitsi.local", {
    status: "completed",
    completion_reason: "stopped",
    segments: [{ start: 0, end: 1, text: "Final words", speaker: "Alice", completed: true }],
  });
  const final = await h.waitFor(async () => (await h.api(`/v1/meetings/${meetingId}`)).json().then((m) => (m.status === "completed" || m.status === "failed") ? m.status : null), { timeoutMs: 4_000, label: "meeting finalized" });
  expect(final).toBe("completed");
  // The chain exited without a continuation: its lease was released and nothing stays pending
  // (the wakeup hop is consumed as a claim-failure no-op).
  await h.waitFor(async () => (await h.ctx.queue.hasPollLease(meetingId)) ? null : true, { timeoutMs: 2_000, label: "lease released on exit" });
  await h.waitFor(async () => (await pendingPolls(meetingId)) === 0 ? true : null, { timeoutMs: 2_000, label: "no polls pending" });
});

test("slow provider polls never split the chain, even with two workers", async () => {
  // Each poll takes ~4x the lease TTL (pollIntervalMs=50 → TTL 150 ms). Without renewal the chain
  // would lose its lease mid-request, a tokenless wakeup would claim it, and two chains would poll
  // the same meeting concurrently — the pre-fix storm this file guards against.
  const res = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/SlowPoll" } });
  const { id: meetingId } = await res.json();
  await h.waitFor(async () => h.vexa.meetings.has("jitsi/SlowPoll@jitsi.local") ? true : null, { timeoutMs: 2_000, label: "bot dispatch" });
  await h.vexa.control("jitsi", "SlowPoll@jitsi.local", { status: "active" });
  const nativeId = "SlowPoll@jitsi.local";

  const originalGetTranscript = h.ctx.vexa.getTranscript.bind(h.ctx.vexa);
  let inflight = 0;
  let maxInflight = 0;
  h.ctx.vexa.getTranscript = async (platform: string, id: string) => {
    if (!(platform === "jitsi" && id === nativeId)) return originalGetTranscript(platform, id);
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    // Real delay: the point is that work outlasts the lease TTL, which fake timers cannot express.
    await Bun.sleep(220);
    try {
      return await originalGetTranscript(platform, id);
    } finally {
      inflight--;
    }
  };

  const second: { worker: WorkerHandle | null } = { worker: null };
  try {
    const wakeupPushes = await countWakeupPushes(meetingId, async () => {
      for (let i = 0; i < 12; i++) {
        const count = await pendingPolls(meetingId);
        expect(count).toBeLessThanOrEqual(1);
        await Bun.sleep(50);
      }
      // A second worker on the same ctx/queue must not double the chains either.
      second.worker = startWorker(h.ctx, { popTimeoutSec: .05, heartbeatIntervalMs: 25 });
      for (let i = 0; i < 12; i++) {
        const count = await pendingPolls(meetingId);
        expect(count).toBeLessThanOrEqual(1);
        await Bun.sleep(50);
      }
    });
    // The live chain owns the lease continuously: no wakeup may be pushed or claimable.
    expect(wakeupPushes).toBe(0);
  } finally {
    await second.worker?.stop();
    h.ctx.vexa.getTranscript = originalGetTranscript;
  }
  // Both workers together never ran two provider polls for this meeting at once.
  expect(maxInflight).toBe(1);
});
