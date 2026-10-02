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
