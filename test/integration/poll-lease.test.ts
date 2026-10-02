import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, type Harness } from "./harness.ts";
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
  const originalPush = h.ctx.queue.push.bind(h.ctx.queue);
  let wakeupPushes = 0;
  h.ctx.queue.push = async (job: Job, delayMs = 0) => {
    if (job.type === "meeting.poll" && job.meetingId === meetingId && !job.pollToken) wakeupPushes++;
    return originalPush(job, delayMs);
  };
  const pollsBefore = vexaPollCount();
  try {
    for (let i = 0; i < 20; i++) {
      const count = await pendingPolls(meetingId);
      expect(count).toBeLessThanOrEqual(1);
      await Bun.sleep(25);
    }
  } finally {
    h.ctx.queue.push = originalPush;
  }
  expect(wakeupPushes).toBe(0);

  // Polls are real provider traffic at roughly one per interval across the ~600 ms window, not a
  // heartbeat-driven storm (~1 chain ≈ 12 polls; each extra chain adds the same rate again).
  const observedDelta = vexaPollCount() - pollsBefore;
  expect(observedDelta).toBeGreaterThan(0);
  expect(observedDelta).toBeLessThanOrEqual(25);

  // A lost wakeup (dropped Redis job) must be repaired. Drop the chain's next continuation
  // deterministically — no poll can be in flight once its continuation push has been intercepted —
  // then the lease is released and heartbeat reconciliation starts a fresh chain.
  let continuationDropped = false;
  h.ctx.queue.push = async (job: Job, delayMs = 0) => {
    if (!continuationDropped && job.type === "meeting.poll" && job.meetingId === meetingId) {
      continuationDropped = true;
      return;
    }
    return originalPush(job, delayMs);
  };
  await h.waitFor(async () => continuationDropped ? true : null, { timeoutMs: 2_000, label: "continuation dropped" });
  h.ctx.queue.push = originalPush;
  await h.waitFor(async () => (await h.ctx.queue.hasPollLease(meetingId)) ? true : null, { timeoutMs: 2_000, label: "fresh chain claimed lease" });
  await h.waitFor(async () => (await pendingPolls(meetingId)) === 1 ? true : null, { timeoutMs: 2_000, label: "single chain restarted" });
});
