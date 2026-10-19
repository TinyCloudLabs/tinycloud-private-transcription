import { afterAll, expect, spyOn, test } from "bun:test";
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

const malformedDelayed: Record<string, string> = {
  json: "PRIVATE_QUEUE_PAYLOAD not-json|bad",
  null: "null|PRIVATE_QUEUE_PAYLOAD",
  array: '["PRIVATE_QUEUE_PAYLOAD"]|bad',
  separator: '{"type":"meeting.start","meetingId":"PRIVATE_QUEUE_PAYLOAD"}',
};

for (const [label, malformed] of Object.entries(malformedDelayed)) {
  test(`malformed due ${label} cannot block healthy ready/delayed work or poison dedup`, async () => {
    const { queue, prefix, delayedKey } = isolatedQueue();
    const delayed = { type: "meeting.start", meetingId: "healthy-delayed", requestId: crypto.randomUUID() } as const;
    const ready = { type: "meeting.start", meetingId: "healthy-ready" } as const;
    await queue.push(delayed, 60_000, "healthy");
    const [member] = await redis.zrangebyscore(delayedKey, "-inf", "+inf");
    await redis.zadd(delayedKey, "0", member!);
    await redis.zadd(delayedKey, "-1", malformed);
    await queue.push(ready);
    const output = spyOn(console, "log").mockImplementation(() => {});
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const processed = [await queue.pop(0.1), await queue.pop(0.1)];
      expect(processed.map((job) => job && "meetingId" in job ? job.meetingId : undefined).sort()).toEqual(["healthy-delayed", "healthy-ready"]);
      expect(processed.find((job) => job && "meetingId" in job && job.meetingId === delayed.meetingId)).toEqual(delayed);
      expect(await queue.size()).toEqual({ ready: 0, delayed: 0 });
      expect(await redis.zrangebyscore(`${delayedKey}:invalid`, "-inf", "+inf")).toEqual([malformed]);
      await queue.push(delayed, 60_000, "healthy");
      await withRequestId(crypto.randomUUID(), () => queue.push(delayed, 120_000, "healthy"));
      expect((await queue.pending()).delayed.map(({ job }) => job)).toEqual([delayed]);
      expect(await redis.lrange(`${prefix}:jobs:ready`, 0, -1)).toEqual([]);
      expect([...output.mock.calls, ...errors.mock.calls].flat().join("\n")).not.toContain("PRIVATE_QUEUE_PAYLOAD");
    } finally { output.mockRestore(); errors.mockRestore(); }
  });

  test(`malformed future ${label} cannot abort lazy indexing after partial old-script effects`, async () => {
    const { queue, delayedKey } = isolatedQueue();
    const legacy = { type: "attributed.batch", meetingId: "legacy", batchId: "healthy", requestId: crypto.randomUUID() } as const;
    const other = { type: "meeting.start", meetingId: "unrelated" } as const;
    const legacyMember = `${JSON.stringify(legacy)}|legacy`;
    const otherMember = `${JSON.stringify(other)}|other`;
    const future = Date.now() + 60_000;
    await redis.zadd(delayedKey, String(future), legacyMember);
    await redis.zadd(delayedKey, String(future + 1), malformed);
    await redis.zadd(delayedKey, String(future + 2), otherMember);
    // A Redis Lua error does not roll prior HSETs back. Reproduce a partial, unsentinelled index.
    await redis.send("HSET", [`${delayedKey}:index`, "stale-partial-guard", "missing-member|old"]);
    const fresh = { type: "attributed.batch", meetingId: "fresh", batchId: "new" } as const;
    const selectedId = crypto.randomUUID();
    await withRequestId(selectedId, () => queue.push(fresh, 120_000, "fresh"));
    await withRequestId(crypto.randomUUID(), () => queue.push(fresh, 240_000, "fresh"));
    const pending = (await queue.pending()).delayed;
    expect(pending.map(({ job }) => job)).toEqual([legacy, other, { ...fresh, requestId: selectedId }]);
    expect(pending.slice(0, 2).map(({ runAt }) => runAt)).toEqual([future, future + 2]);
    expect(await redis.zrangebyscore(`${delayedKey}:invalid`, "-inf", "+inf")).toEqual([malformed]);
    const members = await redis.zrangebyscore(delayedKey, "-inf", "+inf");
    const guards = await redis.send("HVALS", [`${delayedKey}:index`]) as string[];
    expect(guards.filter((value) => value.includes("|")).sort()).toEqual([...members].sort());
    await redis.zadd(delayedKey, "0", legacyMember);
    expect(await queue.pop(0.1)).toEqual(legacy);
    await queue.push(legacy, 60_000, "legacy");
    expect((await queue.pending()).delayed.filter(({ job }) => job.type === "attributed.batch" && job.batchId === "healthy")).toHaveLength(1);
  });

  test(`malformed future ${label} cannot abort cancellation or prevent healthy progress`, async () => {
    const { queue, delayedKey } = isolatedQueue();
    const cancelled = { type: "attributed.batch", meetingId: "cancelled", batchId: "target", requestId: crypto.randomUUID() } as const;
    const survivor = { type: "meeting.start", meetingId: "survivor", requestId: crypto.randomUUID() } as const;
    await queue.push(cancelled, 60_000, "cancel");
    await queue.push(survivor, 120_000, "survivor");
    await redis.zadd(delayedKey, String(Date.now() + 90_000), malformed);
    await queue.push({ type: "meeting.start", meetingId: "ready-survivor" });
    expect(await queue.removeDelayed(cancelled)).toBe(1);
    const members = await redis.zrangebyscore(delayedKey, "-inf", "+inf");
    expect(members.some((member) => member.startsWith(JSON.stringify(cancelled)))).toBe(false);
    for (const member of members) await redis.zadd(delayedKey, "0", member);
    const progressed = [await queue.pop(0.1), await queue.pop(0.1)];
    expect(progressed.map((job) => job && "meetingId" in job ? job.meetingId : undefined).sort()).toEqual(["ready-survivor", "survivor"]);
    expect(progressed.find((job) => job && "meetingId" in job && job.meetingId === survivor.meetingId)).toEqual(survivor);
    expect(await redis.zrangebyscore(`${delayedKey}:invalid`, "-inf", "+inf")).toEqual([malformed]);
    const nextId = crypto.randomUUID();
    await withRequestId(nextId, () => queue.push(cancelled, 60_000, "cancel"));
    expect((await queue.pending()).delayed.map(({ job }) => job)).toEqual([{ ...cancelled, requestId: nextId }]);
    const guards = await redis.send("HVALS", [`${delayedKey}:index`]) as string[];
    expect(guards.filter((value) => value.includes("|"))).toEqual(await redis.zrangebyscore(delayedKey, "-inf", "+inf"));
  });
}

test("large due backlog promotes at most 64 entries per call without losing healthy jobs", async () => {
  const { queue, delayedKey } = isolatedQueue();
  const expected = Array.from({ length: 300 }, (_, i) => ({ type: "meeting.start", meetingId: `bounded-${i}` }));
  for (const job of expected) await redis.zadd(delayedKey, "0", `${JSON.stringify(job)}|legacy-${job.meetingId}`);
  expect(await queue.promoteDue()).toBe(64);
  expect(await queue.size()).toEqual({ ready: 64, delayed: 236 });
  for (let i = 0; i < 4; i++) await queue.promoteDue();
  const pending = await queue.pending();
  expect(pending.delayed).toEqual([]);
  expect(pending.ready.map((job) => "meetingId" in job ? job.meetingId : "").sort()).toEqual(expected.map((job) => job.meetingId).sort());
});

test("chunked legacy indexing and cancellation preserve work across malformed page boundaries", async () => {
  const { queue, delayedKey } = isolatedQueue();
  const target = { type: "attributed.batch", meetingId: "bulk", batchId: "cancel" } as const;
  const survivors = Array.from({ length: 300 }, (_, i) => ({ type: "meeting.start", meetingId: `survivor-${i}` }));
  for (const [i, job] of survivors.entries()) {
    await redis.zadd(delayedKey, String(Date.now() + 60_000 + i * 3), `${JSON.stringify(job)}|survivor-${i}`);
    await redis.zadd(delayedKey, String(Date.now() + 60_000 + i * 3 + 1), `${JSON.stringify({ ...target, requestId: crypto.randomUUID() })}|target-${i}`);
    if (i % 30 === 0) await redis.zadd(delayedKey, String(Date.now() + 60_000 + i * 3 + 2), `PRIVATE_QUEUE_PAYLOAD-${i}|malformed`);
  }
  expect(await queue.removeDelayed(target)).toBe(300);
  expect((await queue.pending()).delayed.map(({ job }) => "meetingId" in job ? job.meetingId : "").sort()).toEqual(survivors.map((job) => job.meetingId).sort());
  expect((await redis.zrangebyscore(`${delayedKey}:invalid`, "-inf", "+inf"))).toHaveLength(10);
  const guards = await redis.send("HVALS", [`${delayedKey}:index`]) as string[];
  expect(guards.filter((value) => value.includes("|")).sort()).toEqual((await redis.zrangebyscore(delayedKey, "-inf", "+inf")).sort());
  await queue.push(target, 60_000, "target-0");
  expect((await queue.pending()).delayed.filter(({ job }) => job.type === target.type)).toHaveLength(1);
});
