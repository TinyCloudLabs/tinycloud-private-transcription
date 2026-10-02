/**
 * TC-570: one meeting.start chain per queued meeting while a Signal meeting waits for a capture
 * seat. The per-meeting start lease makes heartbeat reconciliation skip a meeting whose chain is
 * already re-enqueueing itself; the attempt counter rides the chain so the join-timeout failure
 * fires exactly once, and a dropped chain is re-armed once its orphaned lease expires.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SignalCaptureAdapter, SignalCaptureSnapshot } from "../../src/providers/signal/adapter.ts";
import { meetings } from "../../src/db/schema.ts";
import { startHarness, type Harness } from "./harness.ts";
import type { Job } from "../../src/worker/queue.ts";

const capability = "bcdf-ghkm-npqr-stxz-cbdg-fhkn-mqps-rtzx";
const meetingOf = async (h: Harness, id: string) => (await h.api(`/v1/meetings/${id}`)).json();

// Occupied-seat scenario only: the seat holder blocks capacity, so signal.start is never invoked
// for the waiting meeting. The adapter exists because handleSignalStart requires ctx.signal.
class FakeSignalCapture implements SignalCaptureAdapter {
  starts = 0;
  snapshot: SignalCaptureSnapshot = { status: "joining" };
  async start() { this.starts++; return { sessionId: "signal-session-unused" }; }
  async status() { return this.snapshot; }
  async leave() {}
  async remove() {}
}

let h: Harness;
let signal: FakeSignalCapture;

beforeAll(async () => {
  signal = new FakeSignalCapture();
  h = await startHarness({
    enabledPlatforms: ["signal"],
    signal,
    signalCapabilityKey: Buffer.alloc(32, 7).toString("base64"),
    // Attempts are spaced max(pollIntervalMs, 1000) = 1s; attempt*delay >= 4s fails the wait.
    joinTimeoutSeconds: 4,
    workerHeartbeatIntervalMs: 25,
    workerPopTimeoutSec: .05,
  });
  // Durably occupy the only seat (SIGNAL_MAX_CONCURRENT_CALLS defaults to 1): capacity counts
  // signal meetings mid-lifecycle. A real meeting would release the seat on its own deadline.
  await h.ctx.db.insert(meetings).values({
    id: "mtg_seat_holder",
    projectId: "demo",
    platform: "signal",
    status: "in_progress",
    meetingUrl: "https://signal.link/call/",
  });
});
afterAll(async () => h.stop());

const pendingStarts = async (meetingId: string): Promise<number> => {
  const { ready, delayed } = await h.ctx.queue.pending();
  return ready.filter((j) => j.type === "meeting.start" && j.meetingId === meetingId).length
    + delayed.filter((d) => d.job.type === "meeting.start" && d.job.meetingId === meetingId).length;
};

/** Counts tokenless meeting.start pushes (heartbeat/create wakeups) for one meeting. */
const wrapPush = (meetingId: string, counted: { wakeups: number; continuations: Extract<Job, { type: "meeting.start" }>[] }) => {
  const originalPush = h.ctx.queue.push.bind(h.ctx.queue);
  h.ctx.queue.push = async (job: Job, delayMs = 0) => {
    if (job.type === "meeting.start" && job.meetingId === meetingId) {
      if (job.startToken) counted.continuations.push(job);
      else counted.wakeups++;
    }
    return originalPush(job, delayMs);
  };
  return () => { h.ctx.queue.push = originalPush; };
};

const createSignalMeeting = async () => {
  const res = await h.api("/v1/meetings", {
    method: "POST",
    json: { meeting_url: `https://signal.link/call/#key=${capability}`, webhook_url: h.webhook.url },
  });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
};

test("all seats busy: N heartbeats leave one pending meeting.start; join timeout fires once", async () => {
  const meetingId = await createSignalMeeting();
  const counted = { wakeups: 0, continuations: [] as Extract<Job, { type: "meeting.start" }>[] };
  const unWrap = wrapPush(meetingId, counted);

  // ~60 heartbeats over 1.5 s while the chain waits on its 1 s seat poll. The create-time push
  // lands before wrapping; once the chain holds its lease no heartbeat may push another start.
  let maxPending = 0;
  try {
    for (let i = 0; i < 30; i++) {
      maxPending = Math.max(maxPending, await pendingStarts(meetingId));
      await Bun.sleep(50);
    }
  } finally {
    unWrap();
  }
  expect(maxPending).toBeLessThanOrEqual(1);
  // The create→claim window can admit one queued-meeting heartbeat push (it no-ops on the live
  // lease); under load a second reconcile pass may beat the claim. Anything larger is the TC-570
  // storm: pre-fix this window alone accrues a tokenless push per heartbeat (~60).
  expect(counted.wakeups).toBeLessThanOrEqual(2);
  expect(counted.continuations.length).toBeGreaterThan(0);
  for (const job of counted.continuations) expect(job.startToken).toBeTruthy();
  expect(signal.starts).toBe(0);

  // The attempt counter rides the single chain: after ~joinTimeoutSeconds the seat wait fails
  // once as provider_unavailable and no chain remains.
  const failed = await h.waitFor(async () => {
    const body = await meetingOf(h, meetingId);
    return body.status === "failed" ? body : null;
  }, { timeoutMs: 8_000, label: "seat wait join timeout" });
  expect(failed.error.code).toBe("provider_unavailable");
  const hook = await h.waitFor(
    async () => h.webhook.received.find((w) => w.body.type === "meeting.failed" && w.body.data.meeting_id === meetingId) ?? null,
    { label: "meeting.failed webhook" },
  );
  expect(hook.body.data.error.code).toBe("provider_unavailable");
  // Settle a few heartbeats: any duplicate chain would deliver a second failure.
  await Bun.sleep(300);
  const failures = h.webhook.received.filter((w) => w.body.type === "meeting.failed" && w.body.data.meeting_id === meetingId);
  expect(failures).toHaveLength(1);
  expect(await pendingStarts(meetingId)).toBe(0);
  expect(await h.ctx.queue.hasStartLease(meetingId)).toBe(false);
}, 15_000);

test("a dropped seat-wait continuation is re-armed by heartbeat after the lease expires", async () => {
  const meetingId = await createSignalMeeting();
  await h.waitFor(async () => (await h.ctx.queue.hasStartLease(meetingId)) ? true : null, { timeoutMs: 2_000, label: "start chain claimed" });

  // Drop exactly one continuation: the pushed job never lands, so the lease is orphaned (TTL was
  // extended to delay + TTL ≈ 1.15 s). After expiry the next heartbeat must push a tokenless
  // wakeup that claims the expired lease and resumes the chain.
  let dropped = false;
  const counted = { wakeups: 0, continuations: [] as Job[] };
  const originalPush = h.ctx.queue.push.bind(h.ctx.queue);
  h.ctx.queue.push = async (job: Job, delayMs = 0) => {
    if (job.type === "meeting.start" && job.meetingId === meetingId) {
      if (job.startToken) {
        if (!dropped) { dropped = true; return; }
        counted.continuations.push(job);
      } else {
        counted.wakeups++;
      }
    }
    return originalPush(job, delayMs);
  };
  try {
    await h.waitFor(async () => dropped ? true : null, { timeoutMs: 3_000, label: "continuation dropped" });
    // Nothing pending while the orphaned lease runs out.
    await h.waitFor(async () => (await pendingStarts(meetingId)) === 0 ? true : null, { timeoutMs: 2_000, label: "chain stalled" });
    await h.waitFor(async () => (await pendingStarts(meetingId)) === 1 ? true : null, { timeoutMs: 4_000, label: "chain re-armed" });
  } finally {
    h.ctx.queue.push = originalPush;
  }
  // The repair was reconciliation's tokenless wakeup; the resumed chain re-enqueues itself.
  expect(counted.wakeups).toBeGreaterThanOrEqual(1);
  await h.waitFor(async () => (await h.ctx.queue.hasStartLease(meetingId)) ? true : null, { timeoutMs: 2_000, label: "lease re-claimed" });

  // Cancel before the join timeout so this meeting does not add a second failure webhook.
  const stopped = await h.api(`/v1/meetings/${meetingId}/stop`, { method: "POST" });
  expect(stopped.status).toBe(200);
  await h.waitFor(async () => {
    const body = await meetingOf(h, meetingId);
    return body.status === "cancelled" ? true : null;
  }, { timeoutMs: 2_000, label: "meeting cancelled" });
  await h.waitFor(async () => (await h.ctx.queue.hasStartLease(meetingId)) ? null : true, { timeoutMs: 2_000, label: "lease released on exit" });
  await h.waitFor(async () => (await pendingStarts(meetingId)) === 0 ? true : null, { timeoutMs: 2_000, label: "no starts pending" });
}, 15_000);
