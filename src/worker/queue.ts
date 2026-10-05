import { RedisClient } from "bun";

export type Job =
  | { type: "meeting.start"; meetingId: string; attempt?: number; startToken?: string; wakeupId?: string }
  | { type: "meeting.poll"; meetingId: string; recoveryAttempt?: number; stagingAttempt?: number; pollToken?: string; wakeupId?: string }
  | { type: "meeting.join_deadline"; meetingId: string }
  | { type: "attributed.batch"; meetingId: string; batchId: string }
  | { type: "attributed.finalize"; meetingId: string }
  | { type: "eval.meeting"; meetingId: string; models?: string[] }
  | { type: "webhook.deliver"; deliveryId: string; claimToken: string };

// A wakeup marker's TTL is only a lost-job safety net. The marker value is the wakeupId carried
// by the job it guards: the job deletes its own marker at handler entry, a failed push
// compare-and-deletes it, and untracked tokenless jobs (create/stop/recover pushes) never carry
// a wakeupId and therefore never touch the marker. At most one tracked wakeup per meeting is
// outstanding no matter how long the consumer is blocked. If the job was pushed but never ran —
// a worker crash between pop and handler — reconcile detects the orphan (marker held, payload
// absent from the ready list) and re-pushes; the TTL only repairs a marker orphaned beyond that
// check. The trade-off: shorter resumes wakeup pushes sooner while the consumer is stalled,
// longer delays repairing a genuinely lost wakeup.
const WAKEUP_MARKER_TTL_MS = 120_000;

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

  /**
   * Claims the wakeup marker with this wakeup's id as its value. Ownership matters: a consumed
   * job deletes only its own marker, so untracked tokenless pushes (create/stop/recover wakeups
   * carry no wakeupId) can never free a tracked wakeup's marker early.
   */
  private async claimWakeup(key: string, wakeupId: string): Promise<boolean> {
    return (await this.redis.send("SET", [key, wakeupId, "PX", String(WAKEUP_MARKER_TTL_MS), "NX"])) === "OK";
  }

  /**
   * Detects an orphaned marker: the marked wakeup is still tracked only while its exact payload
   * remains on the ready list (wakeups are never pushed delayed). LPOS compares raw bytes, so
   * callers must construct the job exactly as the wakeup push does — see reconcileMeetingWakeups.
   */
  private async wakeupQueued(job: Job): Promise<boolean> {
    return (await this.redis.send("LPOS", [this.ready, JSON.stringify(job)])) !== null;
  }

  private async acquireWakeup<T extends Job>(key: string, job: (wakeupId: string) => T): Promise<T | null> {
    const marked = await this.redis.get(key);
    if (marked && !(await this.wakeupQueued(job(marked)))) {
      // The marked wakeup is gone: orphan, not coalescing. Compare-and-delete preserves a marker
      // claimed by a concurrent reconciler between our reads.
      await this.releaseLease(key, marked);
    }
    const wakeupId = crypto.randomUUID();
    return (await this.claimWakeup(key, wakeupId)) ? job(wakeupId) : null;
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
   * Acquires a tracked meeting.start wakeup slot and returns the job to push (null when a wakeup
   * is already outstanding). The returned job carries the marker's wakeupId; pushing anything
   * else leaves the marker orphaned. If the push throws, release the claim with
   * releaseStartWakeup so the next heartbeat retries without waiting out the safety-net TTL.
   */
  async acquireStartWakeup(meetingId: string): Promise<Extract<Job, { type: "meeting.start" }> | null> {
    return this.acquireWakeup(this.startWakeup(meetingId), (wakeupId) => ({ type: "meeting.start", meetingId, wakeupId }));
  }

  /** Frees the wakeup slot only while this wakeup still owns the marker. */
  async releaseStartWakeup(meetingId: string, wakeupId: string): Promise<void> {
    await this.releaseLease(this.startWakeup(meetingId), wakeupId);
  }

  /** True while a tokenless meeting.start wakeup is outstanding (or its marker is orphaned). */
  async hasStartWakeup(meetingId: string): Promise<boolean> {
    return this.redis.exists(this.startWakeup(meetingId));
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

  /** Acquires a tracked meeting.poll wakeup slot; see acquireStartWakeup. */
  async acquirePollWakeup(meetingId: string): Promise<Extract<Job, { type: "meeting.poll" }> | null> {
    return this.acquireWakeup(this.pollWakeup(meetingId), (wakeupId) => ({ type: "meeting.poll", meetingId, wakeupId }));
  }

  /** Frees the poll wakeup slot only while this wakeup still owns the marker. */
  async releasePollWakeup(meetingId: string, wakeupId: string): Promise<void> {
    await this.releaseLease(this.pollWakeup(meetingId), wakeupId);
  }

  /** True while a tokenless meeting.poll wakeup is outstanding (or its marker is orphaned). */
  async hasPollWakeup(meetingId: string): Promise<boolean> {
    return this.redis.exists(this.pollWakeup(meetingId));
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
