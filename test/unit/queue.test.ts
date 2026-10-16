import { afterAll, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { Queue } from "../../src/worker/queue.ts";
import { withRequestId } from "../../src/request-context.ts";

const redis = new RedisClient(process.env.REDIS_URL ?? "redis://localhost:56379");
const queues: Queue[] = [];
function isolatedQueue() {
  const prefix = `test:${crypto.randomUUID()}`;
  const queue = new Queue(redis, prefix);
  queues.push(queue);
  return { queue, prefix, delayedKey: `${prefix}:jobs:delayed` };
}
const { queue: q } = isolatedQueue();
afterAll(async () => {
  for (const queue of queues) await queue.clear();
  redis.close();
});

test("immediate jobs pop FIFO; delayed jobs only after their delay", async () => {
  await q.push({ type: "meeting.poll", meetingId: "delayed" }, 400);
  await q.push({ type: "meeting.start", meetingId: "a" });
  await q.push({ type: "meeting.start", meetingId: "b" });
  expect(await q.pop(1)).toEqual({ type: "meeting.start", meetingId: "a" });
  expect(await q.pop(1)).toEqual({ type: "meeting.start", meetingId: "b" });
  expect(await q.promoteDue()).toBe(0);
  await Bun.sleep(450);
  expect(await q.pop(1)).toEqual({ type: "meeting.poll", meetingId: "delayed" });
  expect(await q.size()).toEqual({ ready: 0, delayed: 0 });
});

test("poll lease admits exactly one chain and frees itself on expiry", async () => {
  const meetingId = `lease-${crypto.randomUUID()}`;
  // A tokenless wakeup claims only an unheld lease; a second one is a duplicate and must not run.
  expect(await q.claimPollLease(meetingId, "a", 10_000)).toBe(true);
  expect(await q.claimPollLease(meetingId, "b", 10_000)).toBe(false);
  expect(await q.hasPollLease(meetingId)).toBe(true);
  // The owning chain refreshes its own lease; nothing else can.
  expect(await q.claimPollLease(meetingId, "a", 60)).toBe(true);
  await q.releasePollLease(meetingId, "not-the-owner");
  expect(await q.hasPollLease(meetingId)).toBe(true);
  await q.releasePollLease(meetingId, "a");
  expect(await q.hasPollLease(meetingId)).toBe(false);
  expect(await q.claimPollLease(meetingId, "c", 10_000)).toBe(true);

  // An orphaned lease (worker crashed holding it) expires and lets reconciliation claim again.
  const orphanId = `lease-${crypto.randomUUID()}`;
  expect(await q.claimPollLease(orphanId, "dead", 50)).toBe(true);
  expect(await q.claimPollLease(orphanId, "wakeup", 50)).toBe(false);
  await Bun.sleep(60); // real PX expiry; no fake-timer substitute for Redis TTLs
  expect(await q.claimPollLease(orphanId, "wakeup", 10_000)).toBe(true);
});

test("pending() reports ready and delayed jobs separately", async () => {
  await q.push({ type: "meeting.poll", meetingId: "p1" });
  await q.push({ type: "meeting.poll", meetingId: "p2", pollToken: "t" }, 60_000);
  const { ready, delayed } = await q.pending();
  expect(ready).toEqual([{ type: "meeting.poll", meetingId: "p1" }]);
  expect(delayed).toHaveLength(1);
  expect(delayed[0].job).toEqual({ type: "meeting.poll", meetingId: "p2", pollToken: "t" });
});
test("deduped delayed pushes keep one entry and re-add after promotion", async () => {
  const batchId = `b-${crypto.randomUUID()}`;
  const job = { type: "attributed.batch", meetingId: "m", batchId } as const;
  await q.push(job, 60, `batch:${batchId}`);
  await q.push(job, 60_000, `batch:${batchId}`); // folds into the first entry, not a second member
  expect((await q.pending()).delayed.filter((e) => e.job.type === "attributed.batch" && e.job.batchId === batchId)).toHaveLength(1);
  // Promotion removes the member, so the same key re-adds for the next delayed retry.
  await Bun.sleep(70); // real promotion window: the delayed set is wall-clock scored
  expect(await q.pop(1)).toEqual(job);
  await q.push(job, 60_000, `batch:${batchId}`);
  expect((await q.pending()).delayed.filter((e) => e.job.type === "attributed.batch" && e.job.batchId === batchId)).toHaveLength(1);
});

test("ten metadata-free reconciliation wakeups keep the first minted request ID and due score", async () => {
  const { queue, delayedKey } = isolatedQueue();
  const job = { type: "attributed.batch", meetingId: "reconcile", batchId: "minted" } as const;
  const ids: string[] = [];
  await withRequestId(undefined, async (id) => {
    ids.push(id);
    await queue.push(job, 60_000, "batch:minted");
  });
  const [member] = await redis.zrangebyscore(delayedKey, "-inf", "+inf");
  const due = Date.now() + 30_000;
  await redis.zadd(delayedKey, String(due), member!);
  for (let i = 1; i < 10; i++) {
    await withRequestId(undefined, async (id) => {
      ids.push(id);
      await queue.push(job, 120_000, "batch:minted");
    });
  }
  expect(new Set(ids).size).toBe(10);
  expect(await queue.size()).toEqual({ ready: 0, delayed: 1 });
  expect((await queue.pending()).delayed).toEqual([{ job: { ...job, requestId: ids[0] }, runAt: due }]);
});

test("ten valid request contexts share delayed work identity without rewriting the first payload", async () => {
  const { queue, delayedKey } = isolatedQueue();
  const job = { type: "attributed.batch", meetingId: "reconcile", batchId: "valid" } as const;
  const ids = Array.from({ length: 10 }, () => crypto.randomUUID());
  await withRequestId(ids[0], () => queue.push(job, 60_000, "batch:valid"));
  const [member] = await redis.zrangebyscore(delayedKey, "-inf", "+inf");
  const due = Date.now() + 30_000;
  await redis.zadd(delayedKey, String(due), member!);
  for (const id of ids.slice(1)) await withRequestId(id, () => queue.push(job, 120_000, "batch:valid"));
  expect(await queue.size()).toEqual({ ready: 0, delayed: 1 });
  expect((await queue.pending()).delayed).toEqual([{ job: { ...job, requestId: ids[0] }, runAt: due }]);

  // A dedup suffix is scoped to the work, not a global slot that could discard a different job.
  const otherJob = { ...job, batchId: "other" };
  await withRequestId(ids[1], () => queue.push(otherJob, 60_000, "batch:valid"));
  expect((await queue.pending()).delayed).toHaveLength(2);
});

test("concurrent Redis clients atomically select and retain one delayed payload", async () => {
  const { queue, prefix, delayedKey } = isolatedQueue();
  const otherRedis = new RedisClient(process.env.REDIS_URL ?? "redis://localhost:56379");
  const otherQueue = new Queue(otherRedis, prefix);
  const job = { type: "attributed.batch", meetingId: "reconcile", batchId: "concurrent" } as const;
  const ids: string[] = Array.from({ length: 10 }, () => crypto.randomUUID());
  try {
    await Promise.all(ids.map((id, i) => withRequestId(id, () => (i % 2 ? otherQueue : queue).push(job, 60_000, "batch:concurrent"))));
    const selected = (await queue.pending()).delayed;
    expect(selected).toHaveLength(1);
    expect(ids).toContain(selected[0]!.job.requestId!);
    const [member] = await redis.zrangebyscore(delayedKey, "-inf", "+inf");
    const due = Date.now() + 30_000;
    await redis.zadd(delayedKey, String(due), member!);
    await Promise.all(ids.map((id, i) => withRequestId(id, () => (i % 2 ? queue : otherQueue).push(job, 120_000, "batch:concurrent"))));
    expect((await queue.pending()).delayed).toEqual([{ job: selected[0]!.job, runAt: due }]);

    // Promotion and a new push are serialized together, including release of the identity slot.
    await redis.zadd(delayedKey, "0", member!);
    const replacementId = crypto.randomUUID();
    const [promoted] = await Promise.all([
      queue.promoteDue(),
      withRequestId(replacementId, () => otherQueue.push(job, 60_000, "batch:concurrent")),
    ]);
    expect(promoted).toBe(1);
    expect(await queue.pop(1)).toEqual(selected[0]!.job);
    const afterRace = (await queue.pending()).delayed;
    expect(afterRace.length).toBeLessThanOrEqual(1);
    if (afterRace.length) expect(afterRace[0]!.job.requestId).toBe(replacementId);
    await withRequestId(replacementId, () => otherQueue.push(job, 60_000, "batch:concurrent"));
    expect((await queue.pending()).delayed.map(({ job: pendingJob }) => pendingJob)).toEqual([{ ...job, requestId: replacementId }]);
  } finally {
    otherRedis.close();
  }
});

test("promotion releases delayed identity and preserves each selected request ID", async () => {
  const { queue, delayedKey } = isolatedQueue();
  const job = { type: "attributed.batch", meetingId: "reconcile", batchId: "promotion" } as const;
  const firstId = crypto.randomUUID();
  const nextId = crypto.randomUUID();
  await withRequestId(firstId, () => queue.push(job, 60_000, "batch:promotion"));
  const [member] = await redis.zrangebyscore(delayedKey, "-inf", "+inf");
  await redis.zadd(delayedKey, "0", member!);
  expect(await queue.promoteDue()).toBe(1);
  expect(await queue.promoteDue()).toBe(0);
  expect(await queue.pop(1)).toEqual({ ...job, requestId: firstId });
  await withRequestId(nextId, () => queue.push(job, 60_000, "batch:promotion"));
  expect((await queue.pending()).delayed.map(({ job: pendingJob }) => pendingJob)).toEqual([{ ...job, requestId: nextId }]);
});

test("delayed cancellation ignores request metadata and releases every removed identity", async () => {
  const { queue } = isolatedQueue();
  const job = { type: "attributed.batch", meetingId: "reconcile", batchId: "removal" } as const;
  await withRequestId(crypto.randomUUID(), () => queue.push(job, 60_000, "batch:removal:a"));
  await withRequestId(crypto.randomUUID(), () => queue.push(job, 60_000, "batch:removal:b"));
  await withRequestId(crypto.randomUUID(), () => queue.push(job, 60_000));
  expect(await withRequestId(crypto.randomUUID(), () => queue.removeDelayed(job))).toBe(3);
  expect(await queue.size()).toEqual({ ready: 0, delayed: 0 });
  const nextId = crypto.randomUUID();
  await withRequestId(nextId, () => queue.push(job, 60_000, "batch:removal:a"));
  expect((await queue.pending()).delayed.map(({ job: pendingJob }) => pendingJob)).toEqual([{ ...job, requestId: nextId }]);
  await queue.clear();
  await withRequestId(nextId, () => queue.push(job, 60_000, "batch:removal:a"));
  expect((await queue.pending()).delayed).toHaveLength(1);
});

for (const attributed of [false, true]) {
  test(`pending legacy raw JSON entries ${attributed ? "with" : "without"} requestId retain their payload and due score`, async () => {
    const { queue, delayedKey } = isolatedQueue();
    const job = { type: "attributed.batch", meetingId: "legacy", batchId: "continuity" } as const;
    const legacyJob = attributed ? { ...job, requestId: crypto.randomUUID() } : job;
    const due = Date.now() + 30_000;
    await redis.zadd(delayedKey, String(due), `${JSON.stringify(legacyJob)}|batch:continuity`);
    expect((await queue.pending()).delayed).toEqual([{ job: legacyJob, runAt: due }]);
    for (let i = 0; i < 10; i++) {
      await withRequestId(crypto.randomUUID(), () => queue.push(job, 120_000, "batch:continuity"));
    }
    expect(await queue.size()).toEqual({ ready: 0, delayed: 1 });
    expect((await queue.pending()).delayed).toEqual([{ job: legacyJob, runAt: due }]);
    const [member] = await redis.zrangebyscore(delayedKey, "-inf", "+inf");
    await redis.zadd(delayedKey, "0", member!);
    expect(await queue.promoteDue()).toBe(1);
    expect(await queue.pop(1)).toEqual(legacyJob);
    const nextId = crypto.randomUUID();
    await withRequestId(nextId, () => queue.push(job, 60_000, "batch:continuity"));
    expect((await queue.pending()).delayed.map(({ job: pendingJob }) => pendingJob)).toEqual([{ ...job, requestId: nextId }]);
  });
}

test("legacy delayed cancellation removes metadata-free and attributed payloads without leaving dedup guards", async () => {
  const { queue, delayedKey } = isolatedQueue();
  const job = { type: "attributed.batch", meetingId: "legacy", batchId: "cancel" } as const;
  const due = String(Date.now() + 60_000);
  await redis.zadd(delayedKey, due, `${JSON.stringify(job)}|batch:cancel:a`);
  await redis.zadd(delayedKey, due, `${JSON.stringify({ ...job, requestId: crypto.randomUUID() })}|batch:cancel:b`);
  expect(await withRequestId(crypto.randomUUID(), () => queue.removeDelayed(job))).toBe(2);
  expect((await queue.pending()).delayed).toEqual([]);
  const nextId = crypto.randomUUID();
  await withRequestId(nextId, () => queue.push(job, 60_000, "batch:cancel:a"));
  await withRequestId(nextId, () => queue.push(job, 60_000, "batch:cancel:b"));
  expect((await queue.pending()).delayed.map(({ job: pendingJob }) => pendingJob)).toEqual([
    { ...job, requestId: nextId },
    { ...job, requestId: nextId },
  ]);
});

test("wakeup markers are owned by wakeupId and orphaned markers re-acquire", async () => {
  // Fresh prefix: marker assertions must not share the ready list with other tests.
  const wq = new Queue(redis, `test:${crypto.randomUUID()}`);
  const meetingId = `wake-${crypto.randomUUID()}`;
  // A tracked wakeup claims the marker; a second acquire is coalesced while its job is queued.
  const first = await wq.acquireStartWakeup(meetingId);
  expect(first).toMatchObject({ type: "meeting.start", meetingId });
  expect(first!.wakeupId).toBeTruthy();
  await wq.push(first!);
  expect(await wq.acquireStartWakeup(meetingId)).toBeNull();
  // An untracked release (wrong/foreign wakeupId) must not free the marker — the compare-and-delete
  // is what keeps a consumed untracked job from exposing a tracked wakeup.
  await wq.releaseStartWakeup(meetingId, "foreign");
  expect(await wq.hasStartWakeup(meetingId)).toBe(true);
  // Consuming the job frees exactly its own marker.
  await wq.pop(1);
  await wq.releaseStartWakeup(meetingId, first!.wakeupId!);
  expect(await wq.hasStartWakeup(meetingId)).toBe(false);

  // A pushed-but-lost wakeup leaves an orphaned marker; acquire detects the missing payload and
  // re-claims in the same pass instead of waiting out the safety-net TTL.
  const lost = await wq.acquireStartWakeup(meetingId);
  await wq.push(lost!);
  await wq.pop(1); // simulate a worker crash between pop and handler entry: job gone, marker held
  const repaired = await wq.acquireStartWakeup(meetingId);
  expect(repaired?.wakeupId).toBeTruthy();
  expect(repaired!.wakeupId).not.toBe(lost!.wakeupId);
  await wq.releaseStartWakeup(meetingId, repaired!.wakeupId!);
  expect(await wq.hasStartWakeup(meetingId)).toBe(false);
});
