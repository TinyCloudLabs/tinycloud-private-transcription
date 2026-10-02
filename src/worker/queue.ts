import { RedisClient } from "bun";

export type Job =
  | { type: "meeting.start"; meetingId: string; attempt?: number; startToken?: string }
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
  private readonly startLease: (meetingId: string) => string;
  private readonly pollLease: (meetingId: string) => string;
  private readonly startWakeup: (meetingId: string) => string;
  private readonly pollWakeup: (meetingId: string) => string;

  constructor(
    private readonly redis: RedisClient,
    prefix = "ptx",
  ) {
    this.ready = `${prefix}:jobs:ready`;
    this.delayed = `${prefix}:jobs:delayed`;
    this.pollLease = (meetingId) => `${prefix}:poll:${meetingId}`;
    this.startLease = (meetingId) => `${prefix}:start:${meetingId}`;
    this.startWakeup = (meetingId) => `${prefix}:wake:start:${meetingId}`;
    this.pollWakeup = (meetingId) => `${prefix}:wake:poll:${meetingId}`;
  }

  async push(job: Job, delayMs = 0, dedupKey?: string): Promise<void> {
    const payload = JSON.stringify(job);
    if (delayMs > 0) {
      const member = `${payload}|${dedupKey ?? crypto.randomUUID()}`;
      // A caller-provided dedup key keeps at most one delayed entry per key: ZADD NX folds repeats
      // into the pending member. Promotion removes the member, so the next delayed retry re-adds
      // freely — NX only suppresses a duplicate while one is still waiting (TC-576).
      if (dedupKey) await this.redis.send("ZADD", [this.delayed, "NX", String(Date.now() + delayMs), member]);
      else await this.redis.zadd(this.delayed, String(Date.now() + delayMs), member);
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

  /** Claims the lease when absent, or refreshes it while this chain still holds it. */
  private async claimLease(key: string, token: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.send("EVAL", [
      `if redis.call("exists", KEYS[1]) == 0 then return redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2]) and 1 or 0 end
       if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2]) and 1 or 0 end
       return 0`,
      "1",
      key,
      token,
      String(Math.max(1, Math.floor(ttlMs))),
    ])) === 1;
  }

  /**
   * Refreshes the lease only while this chain holds it. Unlike a claim it never creates an
   * absent key: a chain that lost ownership (TTL expiry while a long job ran, or a competing chain
   * claimed first) gets false and must stop instead of silently taking the lease back.
   */
  private async renewLease(key: string, token: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.send("EVAL", [
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2], "XX") and 1 or 0 end return 0`,
      "1",
      key,
      token,
      String(Math.max(1, Math.floor(ttlMs))),
    ])) === 1;
  }

  /** Deletes the lease only while this chain still holds it. */
  private async releaseLease(key: string, token: string): Promise<void> {
    await this.redis.send("EVAL", [
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`,
      "1",
      key,
      token,
    ]);
  }

  /** Claims the short-lived wakeup marker: true when no tokenless wakeup is already outstanding. */
  private async claimWakeup(key: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.send("SET", [key, "1", "PX", String(Math.max(1, Math.floor(ttlMs))), "NX"])) === "OK";
  }

  /**
   * Per-meeting start lease. Exactly one meeting.start chain may be live: a wakeup with no token
   * claims only when no lease exists, a chain's own delayed continuation refreshes the lease it
   * holds, and anything else (a heartbeat push that raced the chain) exits without re-enqueueing.
   * While a Signal meeting waits for a capture seat the chain re-enqueues itself, so a heartbeat
   * that pushed unconditionally would fork a new chain every interval (TC-570). An orphaned lease
   * expires on its own and lets reconciliation start a fresh chain.
   */
  async claimStartLease(meetingId: string, token: string, ttlMs: number): Promise<boolean> {
    return this.claimLease(this.startLease(meetingId), token, ttlMs);
  }

  /** Refreshes the lease only while this start chain holds it. */
  async renewStartLease(meetingId: string, token: string, ttlMs: number): Promise<boolean> {
    return this.renewLease(this.startLease(meetingId), token, ttlMs);
  }

  /** Deletes the start lease only while this chain still holds it. */
  async releaseStartLease(meetingId: string, token: string): Promise<void> {
    return this.releaseLease(this.startLease(meetingId), token);
  }

  /** True while some meeting.start chain owns the lease, live or orphaned. */
  async hasStartLease(meetingId: string): Promise<boolean> {
    return this.redis.exists(this.startLease(meetingId));
  }

  /**
   * Coalesces tokenless meeting.start wakeups while the consumer is blocked. A start chain whose
   * continuation sits in the ready queue behind unrelated work cannot renew its lease; once the
   * lease expires, reconciliation would otherwise push a fresh wakeup every heartbeat and the
   * pending start count would grow unboundedly until the consumer catches up. Taking this marker
   * before the push leaves at most one outstanding wakeup per marker window; the marker's expiry
   * matches the chain-lease TTL so a genuinely lost wakeup is re-armed on the next reconciliation.
   */
  async claimStartWakeup(meetingId: string, ttlMs: number): Promise<boolean> {
    return this.claimWakeup(this.startWakeup(meetingId), ttlMs);
  }

  /**
   * Per-meeting poll lease. Exactly one meeting.poll chain may be live: a wakeup with no token
   * claims only when no lease exists, a chain's own delayed continuation refreshes the lease it
   * holds, and anything else (a heartbeat push that raced the chain) exits without re-enqueueing.
   * The TTL outlives one delayed hop so an active chain never loses its own lease, yet a crashed
   * or dropped job lets reconciliation start a fresh chain once the lease expires.
   */
  async claimPollLease(meetingId: string, token: string, ttlMs: number): Promise<boolean> {
    return this.claimLease(this.pollLease(meetingId), token, ttlMs);
  }

  /** Refreshes the lease only while this poll chain holds it. */
  async renewPollLease(meetingId: string, token: string, ttlMs: number): Promise<boolean> {
    return this.renewLease(this.pollLease(meetingId), token, ttlMs);
  }

  /** Deletes the poll lease only while this chain still holds it. */
  async releasePollLease(meetingId: string, token: string): Promise<void> {
    return this.releaseLease(this.pollLease(meetingId), token);
  }

  /** Coalesces tokenless meeting.poll wakeups while the consumer is blocked; see claimStartWakeup. */
  async claimPollWakeup(meetingId: string, ttlMs: number): Promise<boolean> {
    return this.claimWakeup(this.pollWakeup(meetingId), ttlMs);
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
