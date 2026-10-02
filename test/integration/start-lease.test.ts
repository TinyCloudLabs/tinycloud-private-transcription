/**
 * TC-570: one meeting.start chain per queued meeting while a Signal meeting waits for a capture
 * seat. The per-meeting start lease makes heartbeat reconciliation skip a meeting whose chain is
 * already re-enqueueing itself; the attempt counter rides the chain so the join-timeout failure
 * fires exactly once, and a dropped chain is re-armed once its orphaned lease expires.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SignalCaptureAdapter, SignalCaptureSnapshot } from "../../src/providers/signal/adapter.ts";
import { VexaHttpError, type VexaClient } from "../../src/providers/vexa/client.ts";
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
    enabledPlatforms: ["signal", "jitsi"],
    signal,
    signalCapabilityKey: Buffer.alloc(32, 7).toString("base64"),
    // Attempts are spaced max(pollIntervalMs, 1000) = 1s; the seat-wait deadline is
    // createdAt + joinTimeoutSeconds (4 s), so each wait fails roughly 4 s after create.
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
  // The consumed wakeup cleared its marker at handler entry — no safety-net TTL wait.
  expect(counted.wakeups).toBeGreaterThanOrEqual(1);
  await h.waitFor(async () => (await h.ctx.queue.hasStartWakeup(meetingId)) ? null : true, { timeoutMs: 2_000, label: "wakeup marker cleared on consume" });
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

test("a retryable createBot failure retries under the lease instead of failing the meeting", async () => {
  const nativeId = "TransientStart@jitsi.local";
  const originalCreateBot = h.ctx.vexa.createBot.bind(h.ctx.vexa);
  let calls = 0;
  h.ctx.vexa.createBot = async (input: Parameters<VexaClient["createBot"]>[0]) => {
    if (input.native_meeting_id !== nativeId) return originalCreateBot(input);
    calls++;
    if (calls === 1) throw new VexaHttpError(503);
    return originalCreateBot(input);
  };
  try {
    const res = await h.api("/v1/meetings", {
      method: "POST",
      json: { meeting_url: "https://jitsi.local/TransientStart", webhook_url: h.webhook.url },
    });
    expect(res.status).toBe(201);
    const meetingId = (await res.json()).id as string;

    // Attempt 1 gets a retryable 503; the chain's delayed retry (attempt 2, +1 s) must run the
    // dispatch path again. A missing return after the retry push would also fail the meeting.
    const joined = await h.waitFor(async () => {
      const body = await meetingOf(h, meetingId);
      return body.status === "joining" ? body : null;
    }, { timeoutMs: 4_000, label: "joining after transient 503" });
    expect(joined.error).toBeFalsy();
    expect(calls).toBe(2);
    // A few heartbeats settle: the retry path must not emit meeting.failed at all.
    await Bun.sleep(300);
    const failures = h.webhook.received.filter((w) => w.body.type === "meeting.failed" && w.body.data.meeting_id === meetingId);
    expect(failures).toHaveLength(0);
    expect(await h.ctx.queue.hasStartLease(meetingId)).toBe(false);
  } finally {
    h.ctx.vexa.createBot = originalCreateBot;
  }
}, 15_000);

test("a blocked consumer coalesces tokenless start and poll wakeups", async () => {
  // An in-progress jitsi meeting polls every 50 ms; stalling every getTranscript call for 400 ms
  // backs the serial consumer up so delayed chain hops land behind real work and their leases
  // expire (delay + TTL ≈ 1.15 s for start, 200 ms for poll) before being consumed. A tokenless
  // wakeup is tracked by its marker from push until consume: no matter how long the stall lasts,
  // at most one is outstanding per meeting.
  const res = await h.api("/v1/meetings", { method: "POST", json: { meeting_url: "https://jitsi.local/WakeupLoad" } });
  expect(res.status).toBe(201);
  const pollId = (await res.json()).id as string;
  await h.waitFor(async () => h.vexa.meetings.has("jitsi/WakeupLoad@jitsi.local") ? true : null, { timeoutMs: 2_000, label: "bot dispatch" });
  await h.vexa.control("jitsi", "WakeupLoad@jitsi.local", { status: "active" });
  await h.waitFor(async () => {
    const body = await meetingOf(h, pollId);
    return body.status === "in_progress" ? true : null;
  }, { timeoutMs: 3_000, label: "poll chain running" });

  const originalGetTranscript = h.ctx.vexa.getTranscript.bind(h.ctx.vexa);
  let blocking = false;
  h.ctx.vexa.getTranscript = async (platform: string, nativeId: string) => {
    // Real delay: the point is that consumer work outlasts the lease TTL, which fake timers
    // cannot express.
    if (blocking) await Bun.sleep(400);
    return originalGetTranscript(platform, nativeId);
  };

  // Pending tokenless wakeups for one meeting: the tracked-wakeup invariant the marker enforces.
  const pendingTokenless = async (type: "meeting.start" | "meeting.poll", meetingId: string) => {
    const { ready, delayed } = await h.ctx.queue.pending();
    const isWakeup = (j: Job) =>
      (type === "meeting.start" ? j.type === "meeting.start" && j.meetingId === meetingId && !j.startToken
        : j.type === "meeting.poll" && j.meetingId === meetingId && !j.pollToken);
    return ready.filter(isWakeup).length + delayed.filter((d) => isWakeup(d.job)).length;
  };

  const counts = { startWakeups: 0, pollWakeups: 0 };
  const originalPush = h.ctx.queue.push.bind(h.ctx.queue);
  h.ctx.queue.push = async (job: Job, delayMs = 0) => {
    if (job.type === "meeting.start" && !job.startToken) counts.startWakeups++;
    if (job.type === "meeting.poll" && job.meetingId === pollId && !job.pollToken) counts.pollWakeups++;
    return originalPush(job, delayMs);
  };

  try {
    // Establish the seat-wait chain BEFORE the stall so its create-time push is consumed; the
    // stall then covers several hop cycles (its 1 s hop lands mid-stall and its lease expires
    // ~150 ms later) — several chain-lease TTL windows, far short of the 2 min safety TTL.
    const startId = await createSignalMeeting();
    await h.waitFor(async () => (await h.ctx.queue.hasStartLease(startId)) ? true : null, { timeoutMs: 2_000, label: "seat-wait chain claimed" });

    try {
      blocking = true;
      let maxTokenlessStarts = 0;
      let maxTokenlessPolls = 0;
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        maxTokenlessStarts = Math.max(maxTokenlessStarts, await pendingTokenless("meeting.start", startId));
        maxTokenlessPolls = Math.max(maxTokenlessPolls, await pendingTokenless("meeting.poll", pollId));
        await Bun.sleep(25);
      }
      blocking = false;
      // Push count over the whole wrap window: the create-time push (not marker-tracked), a
      // possible pre-claim heartbeat push, and the stall's marker wakeup ≈ 3 — versus one per
      // 25 ms heartbeat (~80) without the marker. The hard invariant is the pending counts: at
      // most ONE outstanding tokenless wakeup per meeting while blocked.
      expect(counts.startWakeups).toBeGreaterThan(0);
      expect(counts.startWakeups).toBeLessThanOrEqual(4);
      expect(counts.pollWakeups).toBeGreaterThan(0);
      expect(counts.pollWakeups).toBeLessThanOrEqual(4);
      expect(maxTokenlessStarts).toBeLessThanOrEqual(1);
      expect(maxTokenlessPolls).toBeLessThanOrEqual(1);
      // After the stall the chains actually resume: a consumed wakeup claims the expired lease
      // itself (or the surviving hop does) and the marker is gone.
      await h.waitFor(async () => (await pendingStarts(startId)) <= 1 ? true : null, { timeoutMs: 3_000, label: "wakeups drained" });
      await h.waitFor(async () => (await h.ctx.queue.hasStartLease(startId)) ? true : null, { timeoutMs: 2_000, label: "start chain re-armed" });
      await h.waitFor(async () => (await h.ctx.queue.hasStartWakeup(startId)) ? null : true, { timeoutMs: 2_000, label: "start marker cleared" });
      await h.waitFor(async () => (await h.ctx.queue.hasPollWakeup(pollId)) ? null : true, { timeoutMs: 2_000, label: "poll marker cleared" });
      const stopped = await h.api(`/v1/meetings/${startId}/stop`, { method: "POST" });
      expect(stopped.status).toBe(200);
    } finally {
      blocking = false;
    }
  } finally {
    h.ctx.queue.push = originalPush;
    h.ctx.vexa.getTranscript = originalGetTranscript;
  }
}, 15_000);

test("a failed wakeup push frees the marker so the next heartbeat retries", async () => {
  // No seat is free, so this meeting's start chain re-enqueues. Dropping one continuation orphans
  // the lease; when it expires the heartbeat claims the wakeup marker and pushes — and we make
  // that push throw. The marker must be released so the very next heartbeat retries instead of
  // waiting out the 2-minute safety TTL.
  const meetingId = await createSignalMeeting();
  await h.waitFor(async () => (await h.ctx.queue.hasStartLease(meetingId)) ? true : null, { timeoutMs: 2_000, label: "seat-wait chain claimed" });

  let dropContinuation = false;
  let failWakeupPush = false;
  let failedPushes = 0;
  const originalPush = h.ctx.queue.push.bind(h.ctx.queue);
  h.ctx.queue.push = async (job: Job, delayMs = 0) => {
    if (job.type === "meeting.start" && job.meetingId === meetingId) {
      if (job.startToken) {
        if (!dropContinuation) { dropContinuation = true; return; }
      } else if (!failWakeupPush) {
        failWakeupPush = true;
        failedPushes++;
        throw new Error("redis temporarily unavailable");
      }
    }
    return originalPush(job, delayMs);
  };
  try {
    await h.waitFor(async () => dropContinuation ? true : null, { timeoutMs: 3_000, label: "continuation dropped" });
    await h.waitFor(async () => failedPushes > 0 ? true : null, { timeoutMs: 4_000, label: "wakeup push failed" });
    // The failed push released its marker; the following heartbeat pushes a working wakeup whose
    // job claims the expired lease and re-arms the chain — well under the marker TTL.
    await h.waitFor(async () => (await h.ctx.queue.hasStartLease(meetingId)) ? true : null, { timeoutMs: 3_000, label: "chain re-armed after failed push" });
    await h.waitFor(async () => (await h.ctx.queue.hasStartWakeup(meetingId)) ? null : true, { timeoutMs: 2_000, label: "marker cleared" });
    const stopped = await h.api(`/v1/meetings/${meetingId}/stop`, { method: "POST" });
    expect(stopped.status).toBe(200);
  } finally {
    h.ctx.queue.push = originalPush;
  }
}, 15_000);
