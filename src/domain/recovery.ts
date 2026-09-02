import type { MeetingStatus } from "./state.ts";

/**
 * What a recover request is allowed to do for a meeting in a given state.
 *
 * - `already_completed` / `already_active`: read-only dispositions; the caller is told what the
 *   meeting is doing and nothing is enqueued, mutated, or asked of the capture provider.
 * - `eligible`: the failed row's exact safe code is potentially manually eligible at the A1
 *   taxonomy layer; whether it actually is remains gated elsewhere.
 * - `not_recoverable`: refuse. This is also the answer for anything unrecognized.
 */
export type RecoveryClassification = "already_completed" | "already_active" | "eligible" | "not_recoverable";

export interface RecoveryDeadlineSnapshot {
  readonly acceptedAt: Date;
  readonly deadlineAt: Date | null;
}

/**
 * Persisted deadlines are authoritative. Legacy nullable rows fail closed at acceptance time so a
 * later policy cannot silently extend work that was accepted without a deadline snapshot.
 */
export function authoritativeRecoveryDeadline(operation: RecoveryDeadlineSnapshot): Date {
  return operation.deadlineAt ?? operation.acceptedAt;
}

/** Every durable recovery wake is bounded by the immutable operation deadline. */
export function clampRecoveryWakeToDeadline(operation: RecoveryDeadlineSnapshot, requested: Date): Date {
  const deadline = authoritativeRecoveryDeadline(operation);
  return requested.getTime() < deadline.getTime() ? requested : deadline;
}

/**
 * A Map, not an object literal: an object lookup answers `"toString"`/`"constructor"` from
 * Object.prototype, which would turn an unknown status into a truthy classification.
 */
const CLASSIFICATION = new Map<MeetingStatus, RecoveryClassification>([
  ["queued", "not_recoverable"],
  ["joining", "not_recoverable"],
  ["waiting_for_admission", "not_recoverable"],
  ["in_progress", "not_recoverable"],
  ["processing", "already_active"],
  ["completed", "already_completed"],
  ["failed", "not_recoverable"],
  ["cancelled", "not_recoverable"],
]);

const MANUALLY_RECOVERABLE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "provider_timeout",
  "provider_unavailable",
  "finalizer_interrupted",
]);

/** Pure, I/O-free, fail-closed: unknown statuses and missing/unknown failure codes are ineligible. */
export function classifyRecovery(status: string, failureCode?: string | null): RecoveryClassification {
  if (status === "failed") {
    return failureCode !== null && failureCode !== undefined && MANUALLY_RECOVERABLE_FAILURE_CODES.has(failureCode)
      ? "eligible"
      : "not_recoverable";
  }
  return CLASSIFICATION.get(status as MeetingStatus) ?? "not_recoverable";
}
