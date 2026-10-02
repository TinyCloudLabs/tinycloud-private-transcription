import { afterAll, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { Queue } from "../../src/worker/queue.ts";

const redis = new RedisClient(process.env.REDIS_URL ?? "redis://localhost:56379");
const q = new Queue(redis, `test:${crypto.randomUUID()}`);
afterAll(async () => {
  await q.clear();
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
