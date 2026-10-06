import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import type { Db } from "../db/client.ts";
import { meetings, recordingRecoveryRuns, type MeetingRow } from "../db/schema.ts";
import { ApiError, type ErrorCode } from "../domain/errors.ts";
import { VexaHttpError } from "../providers/vexa/client.ts";
import { terminalTransition } from "./meetings.ts";

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
 * Minimum leftover acknowledgement budget a worker may start with. A tiny budget still passes
 * a strict positivity check yet can never cover a real heartbeat round trip: every ack lands
 * "late", and the first-beat release turns each miss into admit → release → re-admit churn —
 * a livelock that never reaches the paid call (TC-574). Well above any loopback round trip.
 */
export const MIN_RECOVERY_ACK_BUDGET_MS = 30_000;

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
  // Built once, like failMeeting's patch, so endedAt reflects the call, not the last retry.
  const patch: Partial<typeof meetings.$inferInsert> = { status: "failed", errorCode: code, errorMessage: message };
  if (!meeting.endedAt) patch.endedAt = new Date();
  if (meeting.platform === "signal") patch.signalCapability = null;
  return terminalTransition(ctx, meeting, "failed", patch, async (tx) => {
    // The live-admission check runs inside terminalTransition's transaction ahead of the
    // meeting row lock, keeping lock acquisition order identical for every contender: the
    // advisory lock serializes the check with admitRecordingRecovery, so a committed failure
    // can only ever be observed by a later admission as a non-processing meeting.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`recording_recovery:${meeting.id}`}))`);
    const [run] = await tx.select().from(recordingRecoveryRuns).where(eq(recordingRecoveryRuns.meetingId, meeting.id));
    if (run?.ownerToken && !run.outcome && run.admittedAt) {
      const [clock] = await tx.execute(sql`select now() as now`);
      const now = new Date((clock as { now: Date }).now);
      if (now.getTime() - run.admittedAt.getTime() <= ctx.config.recordingRecovery.admissionMs) {
        return "deferred";
      }
    }
  });
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

export class RecoveryRecordingNotReadyError extends Error {
  constructor() {
    super("The retained recording is not ready");
    this.name = "RecoveryRecordingNotReadyError";
  }
}

const isRetryableRecordingFetchError = (error: unknown) =>
  (error instanceof ApiError && (error.code === "provider_unavailable" || error.code === "provider_timeout"))
  || (error instanceof VexaHttpError && (error.notFound || error.status === 429 || error.status >= 500));

/**
 * Downloads Vexa's retained mixed recording of one capture (unpaid). A missing, unfinished or
 * transiently unreachable recording is `RecoveryRecordingNotReadyError`, which callers retry.
 */
export async function fetchRetainedRecording(ctx: AppContext, vexaMeetingId: number) {
  try {
    const recordings = await ctx.vexa.listRecordings();
    const recording = recordings.recordings.find((candidate) => candidate.meeting_id === vexaMeetingId && candidate.media_files.some((file) => file.type === "audio"));
    if (!recording) throw new RecoveryRecordingNotReadyError();
    const master = await ctx.vexa.recordingMaster(recording.id);
    if (!master.raw_url) throw new RecoveryRecordingNotReadyError();
    const { bytes, contentType } = await ctx.vexa.fetchBytes(master.raw_url);
    if (!bytes.length) throw new RecoveryRecordingNotReadyError();
    return { bytes, filename: "meeting.webm", contentType };
  } catch (error) {
    if (error instanceof RecoveryRecordingNotReadyError || isRetryableRecordingFetchError(error)) {
      throw new RecoveryRecordingNotReadyError();
    }
    throw error;
  }
}

/** Streams the retained recording to `destination` (unpaid). Not ready is `RecoveryRecordingNotReadyError`. */
export async function fetchRetainedRecordingToFile(ctx: AppContext, vexaMeetingId: number, destination: string): Promise<void> {
  try {
    const recordings = await ctx.vexa.listRecordings();
    const recording = recordings.recordings.find((candidate) => candidate.meeting_id === vexaMeetingId && candidate.media_files.some((file) => file.type === "audio"));
    if (!recording) throw new RecoveryRecordingNotReadyError();
    const master = await ctx.vexa.recordingMaster(recording.id);
    if (!master.raw_url) throw new RecoveryRecordingNotReadyError();
    if (!(await ctx.vexa.fetchToFile(master.raw_url, destination))) throw new RecoveryRecordingNotReadyError();
  } catch (error) {
    if (error instanceof RecoveryRecordingNotReadyError || isRetryableRecordingFetchError(error)) throw new RecoveryRecordingNotReadyError();
    throw error;
  }
}
