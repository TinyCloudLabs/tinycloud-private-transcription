/** Durable join-clock columns on a meeting row, plus the status that picks the window. */
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
const JOIN_OPEN: Record<(typeof JOIN_OPEN_STATUSES)[number], true> = {
  joining: true,
  waiting_for_admission: true,
  needs_help: true,
};

/** Own-property check, so inherited keys such as "toString" are not open statuses. */
export const isJoinOpen = (status: string): boolean => Object.hasOwn(JOIN_OPEN, status);

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
