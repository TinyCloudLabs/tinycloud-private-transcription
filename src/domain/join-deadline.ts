/** Durable join-clock timestamps from the meeting_join_clocks side row, plus the status that picks the window. */
export type JoinClock = {
  status: string;
  createdAt: Date;
  joinObservedAt: Date | null;
  joinDeadlineAt: Date | null;
  dispatchFallbackAt: Date | null;
};

export type JoinWindows = {
  /** Governs only while no pre-admission state was ever observed. */
  joinDispatchFallbackSeconds: number;
  /** Extends the window from the first observation while the bot is in needs_help. */
  joinNeedsHelpMaxSeconds: number;
};

/** Pre-admission statuses where the join attempt is still open and the deadline is enforceable. */
export const JOIN_OPEN_STATUSES = ["joining", "waiting_for_admission", "needs_help"] as const;
export type JoinOpenStatus = (typeof JOIN_OPEN_STATUSES)[number];
const JOIN_OPEN: Record<JoinOpenStatus, true> = {
  joining: true,
  waiting_for_admission: true,
  needs_help: true,
};

/** Own-property check, so inherited keys such as "toString" are not open statuses. */
export const isJoinOpen = (status: string): status is JoinOpenStatus => Object.hasOwn(JOIN_OPEN, status);

/**
 * Raw Vexa statuses that prove the bot reached the join flow. These, and only these, start the join
 * clock. `requested` is excluded: the bot has been asked to join but has not reached the meeting, so a
 * late-booting bot must not burn the window before it does.
 */
const JOIN_OBSERVED_VEXA: Record<string, true> = {
  joining: true,
  awaiting_admission: true,
  needs_help: true,
  needs_human_help: true,
};

/** Own-property check on the raw Vexa status. Unknown or future values do not start the clock. */
export const isJoinObservation = (vexaStatus: string): boolean => Object.hasOwn(JOIN_OBSERVED_VEXA, vexaStatus);

/** Failure code and copy for a join window that closed while the meeting was in this state. Copy names the bot, never the host. */
export const JOIN_DEADLINE_FAILURE: Record<JoinOpenStatus, { code: "waiting_room_timeout" | "meeting_join_failed"; message: string }> = {
  waiting_for_admission: { code: "waiting_room_timeout", message: "The bot was not admitted to the meeting in time." },
  joining: { code: "meeting_join_failed", message: "The bot did not finish joining the meeting in time." },
  needs_help: { code: "meeting_join_failed", message: "The bot was blocked on a join prompt it could not clear in time." },
};

const addSeconds = (from: Date, n: number) => new Date(from.getTime() + n * 1000);

/**
 * When the join attempt must be over. Pure: all state lives on the row, so a worker restart or a
 * lost queue job cannot move the deadline.
 * - never observed: dispatch fallback (legacy rows fall back to createdAt + window)
 * - needs_help: first observation + joinNeedsHelpMaxSeconds
 * - otherwise: the durable joinDeadlineAt set at first observation
 */
export function effectiveJoinDeadline(clock: JoinClock, windows: JoinWindows): Date {
  if (!clock.joinObservedAt) {
    return clock.dispatchFallbackAt ?? addSeconds(clock.createdAt, windows.joinDispatchFallbackSeconds);
  }
  if (clock.status === "needs_help") return addSeconds(clock.joinObservedAt, windows.joinNeedsHelpMaxSeconds);
  return clock.joinDeadlineAt ?? clock.dispatchFallbackAt ?? addSeconds(clock.createdAt, windows.joinDispatchFallbackSeconds);
}
