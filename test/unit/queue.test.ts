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
