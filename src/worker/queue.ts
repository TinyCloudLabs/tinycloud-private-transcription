import { RedisClient } from "bun";

export type Job =
  | { type: "meeting.start"; meetingId: string; attempt?: number }
  | { type: "meeting.poll"; meetingId: string }
  | { type: "webhook.deliver"; deliveryId: string };

/**
 * Minimal Redis-backed queue: a ready list plus a delayed sorted set (score = run-at ms).
 * `pop` promotes due delayed jobs then blocks on the ready list.
 */
export class Queue {
  private readonly ready: string;
  private readonly delayed: string;

  constructor(
    private readonly redis: RedisClient,
    prefix = "ptx",
  ) {
    this.ready = `${prefix}:jobs:ready`;
    this.delayed = `${prefix}:jobs:delayed`;
  }

  async push(job: Job, delayMs = 0): Promise<void> {
    const payload = JSON.stringify(job);
    if (delayMs > 0) {
      // Suffix keeps identical jobs distinct inside the set.
      await this.redis.zadd(this.delayed, String(Date.now() + delayMs), `${payload}|${crypto.randomUUID()}`);
    } else {
      await this.redis.lpush(this.ready, payload);
    }
  }

  async promoteDue(): Promise<number> {
    const due = await this.redis.zrangebyscore(this.delayed, "-inf", String(Date.now()));
    for (const member of due) {
      if ((await this.redis.zrem(this.delayed, member)) === 1) {
        await this.redis.rpush(this.ready, member.slice(0, member.lastIndexOf("|")));
      }
    }
    return due.length;
  }

  /** Blocks up to `timeoutSec` (fractional ok), but never past the next delayed job's due time. */
  async pop(timeoutSec = 1): Promise<Job | null> {
    await this.promoteDue();
    const next = (await this.redis.zrangebyscore(this.delayed, "-inf", "+inf", "WITHSCORES", "LIMIT", "0", "1")) as unknown as [string, number][];
    let timeout = timeoutSec;
    if (next.length === 1) {
      const untilDue = (Number(next[0][1]) - Date.now()) / 1000;
      timeout = Math.max(0.05, Math.min(timeoutSec, untilDue));
    }
    const res = await this.redis.brpop(this.ready, timeout);
    if (!res) return null;
    return JSON.parse(res[1]) as Job;
  }

  async size(): Promise<{ ready: number; delayed: number }> {
    return { ready: await this.redis.llen(this.ready), delayed: await this.redis.zcard(this.delayed) };
  }

  async clear() {
    await this.redis.del(this.ready, this.delayed);
  }
}
