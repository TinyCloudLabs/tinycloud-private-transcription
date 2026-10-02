import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import type { Db } from "../db/client.ts";
import { attributedBatches, attributedTranscriptionRuns, meetings, recordingRecoveryRuns, type MeetingRow } from "../db/schema.ts";
import type { ErrorCode } from "../domain/errors.ts";
import { canTransition, type MeetingStatus } from "../domain/state.ts";

/** What `db.transaction` hands to its callback; structurally a Db without transaction(). */
type DbSession = Pick<Db, "update" | "select" | "insert" | "delete" | "execute">;

/**
 * Re-admission bound: an admission may be taken over only after its owner's heartbeat is stale
 * (no `admitted_at` refresh for `config.recordingRecovery.admissionMs`). The window must exceed
 * the longest possible gap between beats — one dispatch wave's worst-case duration (bounded by
 * `TranscriptionProvider.maxRequestWaveMs` ≈ per-request timeout × retries) plus the heartbeat
 * freshness margin — because a late heartbeat acknowledgement is fenced out before its wave
 * can be dispatched (TC-574). A heart-beating owner can therefore never be overlapped by a
 * re-admission; only a dead one can.
 */
/** A crashed admission permits at most one bounded re-admission (TC-574). */
export const MAX_RECOVERY_ADMISSIONS = 2;

export type RecoveryOutcome = "succeeded" | "failed" | "ambiguous" | "exhausted";

export type RecoveryAdmission =
  | { kind: "admitted"; token: string }
  /** Another worker owns a live admission; the poll should re-check on the next hop. */
  | { kind: "deferred" }
  /** The run row is already terminal; `outcome` carries the recorded result. */
  | { kind: "settled"; outcome: RecoveryOutcome }
  /** Nothing to fence (meeting gone, left processing, or deletion-blocked). */
  | { kind: "ineligible" };

/**
 * Atomically admits the paid whole-recording transcription, taken under a database lock
 * immediately before the provider call — the recording-fallback analogue of the attributed
 * dispatch fence. A live admission defers a concurrent poll; a stale one is re-admitted only
 * while admissions stay bounded, after which the row is settled "exhausted" so a crash can
 * never repeat the paid request unboundedly.
 */
export async function admitRecordingRecovery(ctx: AppContext, meetingId: string): Promise<RecoveryAdmission> {
  const admissionMs = ctx.config.recordingRecovery.admissionMs;
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`recording_recovery:${meetingId}`}))`);
    const [meeting] = await tx.select().from(meetings).where(eq(meetings.id, meetingId)).for("update");
    if (!meeting || meeting.status !== "processing" || meeting.dispatchBlocked) return { kind: "ineligible" };
    const [run] = await tx.select().from(recordingRecoveryRuns).where(eq(recordingRecoveryRuns.meetingId, meetingId)).for("update");
    const token = crypto.randomUUID();
    // Staleness is judged on the database clock so workers never disagree about the window.
    const [clock] = await tx.execute(sql`select now() as now`);
    const now = new Date((clock as { now: Date }).now);
    if (!run) {
      await tx.insert(recordingRecoveryRuns).values({ meetingId, ownerToken: token, admittedAt: now, admissions: 1 });
      return { kind: "admitted", token };
    }
    if (run.outcome) return { kind: "settled", outcome: run.outcome as RecoveryOutcome };
    const stale = !run.admittedAt || now.getTime() - run.admittedAt.getTime() > admissionMs;
    // A freed slot (released before dispatch, or reset by explicit recovery) is re-granted
    // without spending the bounded takeover budget; the floor keeps a fresh round at 1.
    if (!run.ownerToken) {
      await tx.update(recordingRecoveryRuns)
        .set({ ownerToken: token, admittedAt: now, admissions: Math.max(1, run.admissions), updatedAt: now })
        .where(eq(recordingRecoveryRuns.meetingId, meetingId));
      return { kind: "admitted", token };
    }
    if (!stale) return { kind: "deferred" };
    if (run.admissions >= MAX_RECOVERY_ADMISSIONS) {
      const [exhausted] = await tx.update(recordingRecoveryRuns)
        .set({ outcome: "exhausted", updatedAt: now })
        .where(and(eq(recordingRecoveryRuns.meetingId, meetingId), eq(recordingRecoveryRuns.admissions, run.admissions)))
        .returning();
      return exhausted ? { kind: "settled", outcome: "exhausted" } : { kind: "deferred" };
    }
    await tx.update(recordingRecoveryRuns)
      .set({ ownerToken: token, admittedAt: now, admissions: run.admissions + 1, updatedAt: now })
      .where(eq(recordingRecoveryRuns.meetingId, meetingId));
    return { kind: "admitted", token };
  });
}

/**
 * How much of the heartbeat round trip may elapse before the acknowledgement is stale: the
 * admission window minus one full dispatch wave (the provider's worst-case `maxRequestWaveMs`)
 * and a margin that scales with the window. A non-positive budget means the configured window
 * can never cover a wave — workers refuse to start rather than strand meetings (TC-574).
 */
export function recoveryAckBudgetMs(ctx: AppContext): number {
  const admissionMs = ctx.config.recordingRecovery.admissionMs;
  const waveMs = ctx.transcriptRecovery?.maxRequestWaveMs ?? 0;
  const marginMs = Math.min(5_000, Math.floor(admissionMs * 0.1));
  return admissionMs - waveMs - marginMs;
}

/**
 * The serialized counterpart of `admitRecordingRecovery` for terminal failure writes (TC-574):
 * under the same advisory lock, a live foreign admission defers the write (a paid call may be
 * in flight and owns the outcome), otherwise the meeting's failure transition commits inside
 * the lock so a later admission observes a non-processing meeting and is always ineligible.
 * Returns "deferred" or the transition result ({meeting, changed}); callers mirror `failMeeting`.
 */
export async function failMeetingUnlessRecoveryLive(
  ctx: AppContext,
  meeting: MeetingRow,
  code: ErrorCode,
  message: string,
): Promise<{ meeting: MeetingRow; changed: boolean } | "deferred"> {
  for (;;) {
    const result = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`recording_recovery:${meeting.id}`}))`);
      const [run] = await tx.select().from(recordingRecoveryRuns).where(eq(recordingRecoveryRuns.meetingId, meeting.id));
      if (run?.ownerToken && !run.outcome && run.admittedAt) {
        const [clock] = await tx.execute(sql`select now() as now`);
        const now = new Date((clock as { now: Date }).now);
        if (now.getTime() - run.admittedAt.getTime() <= ctx.config.recordingRecovery.admissionMs) {
          return { deferred: true as const, waiting: false as const };
        }
      }
      // The meeting row lock and the conditional update mirror terminalTransition, including the
      // attributed dispatch-ledger wait, so the failure write keeps every existing guarantee.
      const [current] = await tx.select().from(meetings).where(eq(meetings.id, meeting.id)).for("update");
      if (!current || current.status !== meeting.status || !canTransition(current.status as MeetingStatus, "failed")) {
        return { deferred: false as const, waiting: false as const, meeting: current ?? meeting, changed: false };
      }
      const [run2] = await tx.select().from(attributedTranscriptionRuns)
        .where(eq(attributedTranscriptionRuns.meetingId, meeting.id)).for("update");
      if (run2) {
        const active = await tx.select({ id: attributedBatches.id }).from(attributedBatches)
          .where(and(eq(attributedBatches.meetingId, meeting.id), isNotNull(attributedBatches.dispatchToken))).for("update");
        if (active.length) return { deferred: false as const, waiting: true as const };
      }
      const patch: Partial<typeof meetings.$inferInsert> = { status: "failed", errorCode: code, errorMessage: message };
      if (!meeting.endedAt) patch.endedAt = new Date();
      if (meeting.platform === "signal") patch.signalCapability = null;
      const [row] = await tx.update(meetings).set(patch)
        .where(and(eq(meetings.id, meeting.id), eq(meetings.status, meeting.status))).returning();
      return row
        ? { deferred: false as const, waiting: false as const, meeting: row, changed: true }
        : { deferred: false as const, waiting: false as const, meeting: current, changed: false };
    });
    if (result.deferred) return "deferred";
    if (!result.waiting) {
      if (result.changed) ctx.log.info("meeting status changed", { meetingId: result.meeting.id, stage: "status_transition" });
      return { meeting: result.meeting, changed: result.changed };
    }
    // A paid attributed request is still in flight; retry once its dispatch marker settles.
    await Bun.sleep(10);
  }
}

/**
 * The owning admission heartbeats its timestamp. False means the fence no longer names this
 * token (settled or re-admitted elsewhere); the caller must stop dispatching paid requests.
 */
export async function heartbeatRecordingRecovery(ctx: AppContext, meetingId: string, token: string): Promise<boolean> {
  const [beat] = await ctx.db.update(recordingRecoveryRuns)
    .set({ admittedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(recordingRecoveryRuns.meetingId, meetingId), eq(recordingRecoveryRuns.ownerToken, token), isNull(recordingRecoveryRuns.outcome)))
    .returning();
  return !!beat;
}

/** Frees an admission that never reached the paid call (e.g. the recording was not ready). */
export async function releaseRecordingRecovery(ctx: AppContext, meetingId: string, token: string): Promise<void> {
  await ctx.db.update(recordingRecoveryRuns)
    .set({ ownerToken: null, admittedAt: null, updatedAt: sql`now()` })
    .where(and(eq(recordingRecoveryRuns.meetingId, meetingId), eq(recordingRecoveryRuns.ownerToken, token), isNull(recordingRecoveryRuns.outcome)));
}

/**
 * Records the terminal outcome of an admitted call. Terminal outcomes are monotonic: only the
 * owning token settles, and never over a recorded one. `succeeded` must only be recorded when
 * publication actually moved the meeting; `failed` is for definitive outcomes (rejection, empty
 * or undecodable audio), `ambiguous` for genuinely uncertain remote outcomes.
 */
export async function settleRecordingRecovery(ctx: AppContext, meetingId: string, token: string, outcome: "succeeded" | "failed" | "ambiguous"): Promise<void> {
  await ctx.db.update(recordingRecoveryRuns)
    .set({ outcome, updatedAt: sql`now()` })
    .where(and(eq(recordingRecoveryRuns.meetingId, meetingId), eq(recordingRecoveryRuns.ownerToken, token), isNull(recordingRecoveryRuns.outcome)));
}

/** Explicit operator recovery opens a fresh bounded round only over a terminal outcome. A live
 *  (unsettled) admission is left untouched so duplicate recover calls cannot reset it. */
export async function resetRecordingRecovery(db: DbSession, meetingId: string): Promise<void> {
  await db.update(recordingRecoveryRuns)
    .set({ ownerToken: null, admittedAt: null, admissions: 0, outcome: null, updatedAt: sql`now()` })
    .where(and(eq(recordingRecoveryRuns.meetingId, meetingId), isNotNull(recordingRecoveryRuns.outcome)));
}
