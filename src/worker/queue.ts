import { RedisClient } from "bun";

export type Job =
  | { type: "meeting.start"; meetingId: string; attempt?: number }
  | { type: "meeting.poll"; meetingId: string; recoveryAttempt?: number; stagingAttempt?: number; pollToken?: string }
  | { type: "meeting.join_deadline"; meetingId: string }
  | { type: "attributed.batch"; meetingId: string; batchId: string }
  | { type: "attributed.finalize"; meetingId: string }
  | { type: "webhook.deliver"; deliveryId: string; claimToken: string };

/**
 * Minimal Redis-backed queue: a ready list plus a delayed sorted set (score = run-at ms).
 * `pop` promotes due delayed jobs then blocks on the ready list.
 */
export class Queue {
  private readonly ready: string;
  private readonly delayed: string;
  private readonly pollLease: (meetingId: string) => string;

  constructor(
    private readonly redis: RedisClient,
    prefix = "ptx",
  ) {
    this.ready = `${prefix}:jobs:ready`;
    this.delayed = `${prefix}:jobs:delayed`;
    this.pollLease = (meetingId) => `${prefix}:poll:${meetingId}`;
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

  /** Deletes every delayed member with exactly this payload; returns how many were removed. */
  async removeDelayed(job: Job): Promise<number> {
    const payload = JSON.stringify(job);
    const members = await this.redis.zrangebyscore(this.delayed, "-inf", "+inf");
    let removed = 0;
    for (const member of members) {
      if (member.slice(0, payload.length + 1) === `${payload}|`) removed += await this.redis.zrem(this.delayed, member);
    }
    return removed;
  }

  async size(): Promise<{ ready: number; delayed: number }> {
    return { ready: await this.redis.llen(this.ready), delayed: await this.redis.zcard(this.delayed) };
  }

  async clear() {
    await this.redis.del(this.ready, this.delayed);
  }

  /**
   * Per-meeting poll lease. Exactly one meeting.poll chain may be live: a wakeup with no token
   * claims only when no lease exists, a chain's own delayed continuation refreshes the lease it
   * holds, and anything else (a heartbeat push that raced the chain) exits without re-enqueueing.
   * The TTL outlives one delayed hop so an active chain never loses its own lease, yet a crashed
   * or dropped job lets reconciliation start a fresh chain once the lease expires.
   */
  async claimPollLease(meetingId: string, token: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.send("EVAL", [
      `if redis.call("exists", KEYS[1]) == 0 then return redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2]) and 1 or 0 end
       if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2]) and 1 or 0 end
       return 0`,
      "1",
      this.pollLease(meetingId),
      token,
      String(Math.max(1, Math.floor(ttlMs))),
    ])) === 1;
  }

  /**
   * Refreshes the lease only while this chain holds it. Unlike claimPollLease it never creates an
   * absent key: a chain that lost ownership (TTL expiry while a long job ran, or a competing chain
   * claimed first) gets false and must stop instead of silently taking the lease back.
   */
  async renewPollLease(meetingId: string, token: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.send("EVAL", [
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2], "XX") and 1 or 0 end return 0`,
      "1",
      this.pollLease(meetingId),
      token,
      String(Math.max(1, Math.floor(ttlMs))),
    ])) === 1;
  }

  /** Deletes the lease only while this chain still holds it. */
  async releasePollLease(meetingId: string, token: string): Promise<void> {
    await this.redis.send("EVAL", [
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`,
      "1",
      this.pollLease(meetingId),
      token,
    ]);
  }

  /** True while some meeting.poll chain owns the lease, live or orphaned. */
  async hasPollLease(meetingId: string): Promise<boolean> {
    return this.redis.exists(this.pollLease(meetingId));
  }

  /** Ready and delayed jobs; delayed members keep their dedup suffix so each push is counted. */
  async pending(): Promise<{ ready: Job[]; delayed: { job: Job; runAt: number }[] }> {
    const ready = (await this.redis.lrange(this.ready, 0, -1)).map((raw) => JSON.parse(raw) as Job);
    const delayedRows = (await this.redis.zrangebyscore(this.delayed, "-inf", "+inf", "WITHSCORES")) as unknown as [string, number][];
    const delayed = delayedRows.map(([member, score]) => ({ job: JSON.parse(member.slice(0, member.lastIndexOf("|"))) as Job, runAt: Number(score) }));
    return { ready, delayed };
  }
}
