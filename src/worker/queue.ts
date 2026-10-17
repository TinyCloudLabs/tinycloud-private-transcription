import { RedisClient } from "bun";
import { currentRequestId } from "../request-context.ts";

export type Job = (
  | { type: "meeting.start"; meetingId: string; attempt?: number; startToken?: string; wakeupId?: string }
  | { type: "meeting.poll"; meetingId: string; recoveryAttempt?: number; stagingAttempt?: number; pollToken?: string; wakeupId?: string }
  | { type: "meeting.join_deadline"; meetingId: string }
  | { type: "attributed.batch"; meetingId: string; batchId: string }
  | { type: "attributed.finalize"; meetingId: string }
  | { type: "eval.meeting"; meetingId: string; models?: string[] }
  | { type: "webhook.deliver"; deliveryId: string; claimToken: string }
) & { requestId?: string };

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

const DELAYED_BATCH_SIZE = 64;

// Each EVAL visits at most one bounded page. Payload parsing is protected before any member
// mutation: Redis does not roll a script's earlier writes back when a later command throws.
const DELAYED_IDENTITY_SCRIPT = `
local function workIdentity(payload)
  if type(payload) ~= "string" then return nil end
  local ok, work = pcall(function()
    local job = cjson.decode(payload)
    if type(job) ~= "table" or type(job.type) ~= "string" then return nil end
    job.requestId = nil
    local fields = {}
    for key in pairs(job) do
      if type(key) ~= "string" then return nil end
      fields[#fields + 1] = key
    end
    table.sort(fields)
    for i, key in ipairs(fields) do fields[i] = cjson.encode(key) .. ":" .. cjson.encode(job[key]) end
    return "{" .. table.concat(fields, ",") .. "}"
  end)
  if ok then return work end
  return nil
end
local function memberParts(member)
  local payload, suffix = string.match(member, "^(.*)|([^|]*)$")
  local work = workIdentity(payload)
  if not work then return nil end
  return payload, work .. "|" .. suffix, work
end
local function forgetMember(member, identity)
  local removed = redis.call("ZREM", KEYS[1], member)
  if redis.call("HGET", KEYS[2], identity) == member then
    redis.call("HDEL", KEYS[2], identity)
    redis.call("ZREM", KEYS[3], identity)
  end
  return removed
end
local function quarantine(member)
  local score = redis.call("ZSCORE", KEYS[1], member)
  if score then
    redis.call("ZADD", KEYS[4], score, member)
    redis.call("ZREM", KEYS[1], member)
  end
end
`;

const INDEX_DELAYED_SCRIPT = `-- queue:index-delayed
${DELAYED_IDENTITY_SCRIPT}
local state = redis.call("HGET", KEYS[2], "")
if state == "v2:ready" then return 1 end
local offset = tonumber(string.match(state or "", "^v2:(%d+)$"))
if not offset then
  -- Rebuild old/partially failed indexes, retaining raw pending payloads and scores.
  redis.call("UNLINK", KEYS[2], KEYS[3])
  offset = 0
end
local members = redis.call("ZRANGE", KEYS[1], offset, offset + ${DELAYED_BATCH_SIZE - 1})
local retained = 0
for _, member in ipairs(members) do
  local payload, identity = memberParts(member)
  if not payload then quarantine(member)
  else
    local selected = redis.call("HGET", KEYS[2], identity)
    if not selected then
      redis.call("HSET", KEYS[2], identity, member)
      redis.call("ZADD", KEYS[3], 0, identity)
      retained = retained + 1
    elseif selected == member then retained = retained + 1
    else forgetMember(member, identity) end
  end
end
offset = offset + retained
if #members < ${DELAYED_BATCH_SIZE} or offset >= redis.call("ZCARD", KEYS[1]) then
  redis.call("HSET", KEYS[2], "", "v2:ready")
  return 1
end
redis.call("HSET", KEYS[2], "", "v2:" .. offset)
return 0
`;

const PUSH_DELAYED_SCRIPT = `-- queue:push-delayed
${DELAYED_IDENTITY_SCRIPT}
if redis.call("HGET", KEYS[2], "") ~= "v2:ready" then return -1 end
local work = workIdentity(ARGV[1])
if not work then return -2 end
local identity = work .. "|" .. ARGV[2]
local selected = redis.call("HGET", KEYS[2], identity)
if selected and redis.call("ZSCORE", KEYS[1], selected) then return 0 end
local member = ARGV[1] .. "|" .. ARGV[2]
redis.call("ZADD", KEYS[1], "NX", ARGV[3], member)
redis.call("HSET", KEYS[2], identity, member)
redis.call("ZADD", KEYS[3], 0, identity)
return 1
`;

const PROMOTE_DUE_SCRIPT = `-- queue:promote-due
${DELAYED_IDENTITY_SCRIPT}
if redis.call("HGET", KEYS[2], "") ~= "v2:ready" then return -1 end
local due = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, ${DELAYED_BATCH_SIZE})
local promoted = 0
for _, member in ipairs(due) do
  local payload, identity = memberParts(member)
  if not payload then quarantine(member)
  elseif forgetMember(member, identity) == 1 then
    redis.call("RPUSH", KEYS[5], payload)
    promoted = promoted + 1
  end
end
return promoted
`;

const REMOVE_DELAYED_SCRIPT = `-- queue:remove-delayed
${DELAYED_IDENTITY_SCRIPT}
if redis.call("HGET", KEYS[2], "") ~= "v2:ready" then return {-1, 0} end
local target = workIdentity(ARGV[1])
if not target then return {-2, 0} end
local prefix = target .. "|"
local identities = redis.call("ZRANGEBYLEX", KEYS[3], "[" .. prefix, "[" .. prefix .. string.char(255), "LIMIT", 0, ${DELAYED_BATCH_SIZE})
local removed = 0
for _, identity in ipairs(identities) do
  local member = redis.call("HGET", KEYS[2], identity)
  if member then removed = removed + forgetMember(member, identity)
  else redis.call("ZREM", KEYS[3], identity) end
end
return {removed, #identities}
`;

/**
 * Minimal Redis-backed queue: ready/delayed jobs, selected-payload and work indexes, and an
 * isolated invalid-member set. Every migration/promotion/cancellation EVAL processes at most 64 rows.
 */
export class Queue {
  private readonly ready: string;
  private readonly delayed: string;
  private readonly delayedIndex: string;
  private readonly delayedWork: string;
  private readonly delayedInvalid: string;
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
    this.delayedIndex = `${this.delayed}:index`;
    this.delayedWork = `${this.delayed}:work`;
    this.delayedInvalid = `${this.delayed}:invalid`;
    this.pollLease = (meetingId) => `${prefix}:poll:${meetingId}`;
    this.startLease = (meetingId) => `${prefix}:start:${meetingId}`;
    this.startWakeup = (meetingId) => `${prefix}:wake:start:${meetingId}`;
    this.pollWakeup = (meetingId) => `${prefix}:wake:poll:${meetingId}`;
  }

  private payload(job: Job): string {
    const id = currentRequestId();
    return JSON.stringify(id ? { ...job, requestId: id } : job);
  }

  private async prepareDelayed(): Promise<void> {
    // All delayed writers/drainers wait on the same resumable index cursor. Only this script
    // changes membership until ready; immediate jobs remain independent. Each await releases Redis.
    while (await this.redis.send("EVAL", [
      INDEX_DELAYED_SCRIPT, "4", this.delayed, this.delayedIndex, this.delayedWork, this.delayedInvalid,
    ]) !== 1) {}
  }

  async push(job: Job, delayMs = 0, dedupKey?: string): Promise<void> {
    const payload = this.payload(job);
    if (delayMs > 0) {
      for (;;) {
        await this.prepareDelayed();
        const result = await this.redis.send("EVAL", [
          PUSH_DELAYED_SCRIPT, "4", this.delayed, this.delayedIndex, this.delayedWork, this.delayedInvalid,
          payload, dedupKey ?? crypto.randomUUID(), String(Date.now() + delayMs),
        ]) as number;
        if (result === -1) continue;
        if (result === -2) throw new Error("Invalid delayed queue job");
        return;
      }
    } else {
      await this.redis.lpush(this.ready, payload);
    }
  }

  async promoteDue(): Promise<number> {
    for (;;) {
      await this.prepareDelayed();
      const result = await this.redis.send("EVAL", [
        PROMOTE_DUE_SCRIPT, "5", this.delayed, this.delayedIndex, this.delayedWork, this.delayedInvalid, this.ready, String(Date.now()),
      ]) as number;
      if (result !== -1) return result;
    }
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

  /** Deletes every delayed member for this work, regardless of its request metadata or suffix. */
  async removeDelayed(job: Job): Promise<number> {
    let total = 0;
    for (;;) {
      await this.prepareDelayed();
      const [removed, visited] = await this.redis.send("EVAL", [
        REMOVE_DELAYED_SCRIPT, "4", this.delayed, this.delayedIndex, this.delayedWork, this.delayedInvalid, JSON.stringify(job),
      ]) as [number, number];
      if (removed === -1) continue;
      if (removed === -2) throw new Error("Invalid delayed queue job");
      total += removed;
      if (visited < DELAYED_BATCH_SIZE) return total;
    }
  }

  async size(): Promise<{ ready: number; delayed: number }> {
    return { ready: await this.redis.llen(this.ready), delayed: await this.redis.zcard(this.delayed) };
  }

  async clear() {
    await this.redis.del(this.ready, this.delayed, this.delayedIndex, this.delayedWork, this.delayedInvalid);
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

  /** Ready and delayed jobs, retaining the selected raw payloads of new and legacy entries. */
  async pending(): Promise<{ ready: Job[]; delayed: { job: Job; runAt: number }[] }> {
    // Delayed before ready: promotion moves a job delayed -> ready, so this order sees it in one of them.
    const delayedRows = (await this.redis.zrangebyscore(this.delayed, "-inf", "+inf", "WITHSCORES")) as unknown as [string, number][];
    const ready = (await this.redis.lrange(this.ready, 0, -1)).map((raw) => JSON.parse(raw) as Job);
    const delayed = delayedRows.map(([member, score]) => ({ job: JSON.parse(member.slice(0, member.lastIndexOf("|"))) as Job, runAt: Number(score) }));
    return { ready, delayed };
  }
}
