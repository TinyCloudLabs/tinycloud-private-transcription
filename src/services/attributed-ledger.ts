/**
 * Attempt-ledger rules for attributed batches and recording gap fills (TC-758).
 *
 * TC-574 sent every batch to Tinfoil at most once. Losing captured speech is worse than a possible
 * duplicate $0.01 request, so a failed or uncertain attempt is now re-sent after a durable backoff.
 * What has not changed is that at most one paid request per batch is ever in flight: every attempt
 * is a new durable row admitted under the claim + dispatch-slot fence, and an attempt whose owner
 * died is re-sent only after its ATTEMPT_DEADLINE_MS bound has passed.
 */

/** Publication accepts no more attempts than this, whatever the configured schedule. */
export const MAX_VERIFIED_ATTEMPTS = 16;
/** Empty results (voiced audio, no words) before an attempt switches to the fallback model. */
export const EMPTY_RESULTS_BEFORE_FALLBACK = 2;

/** Delay before the attempt that follows `failures` failed tries (1-based); the schedule's tail repeats. */
export const retryDelayMs = (backoffMs: readonly number[], failures: number): number =>
  backoffMs[Math.min(Math.max(failures, 1), backoffMs.length) - 1]!;

/** Paid attempts (and range-fetch tries) a batch gets: one per backoff step plus the first. */
export const attemptLimit = (backoffMs: readonly number[]): number => Math.min(backoffMs.length + 1, MAX_VERIFIED_ATTEMPTS);

export interface AttemptEvidence { ordinal: number; status: string; completedAt: Date | null }
const terminalFailure = (row: AttemptEvidence) => (row.status === "failed" || row.status === "ambiguous") && !!row.completedAt;

/**
 * The attempt ledger publication accepts for a settled batch:
 * - completed: ≥ 1 attempts numbered 1..n; the latest succeeded, every earlier one failed/ambiguous;
 * - silence: no attempt (decided from the PCM before any paid call);
 * - failed | ambiguous (exhausted): attempts numbered 1..n, all terminal and none succeeded (n may be 0
 *   when the audio could never be fetched).
 * Ledgers settled before TC-758 have at most one attempt and satisfy the same rules unchanged.
 */
export function attemptsVerified(status: string, attempts: number, rows: AttemptEvidence[]): boolean {
  if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts > MAX_VERIFIED_ATTEMPTS || rows.length !== attempts) return false;
  const sorted = [...rows].sort((a, b) => a.ordinal - b.ordinal);
  if (sorted.some((row, index) => row.ordinal !== index + 1)) return false;
  if (status === "completed") {
    const latest = sorted.at(-1);
    return !!latest && latest.status === "succeeded" && !!latest.completedAt && sorted.slice(0, -1).every(terminalFailure);
  }
  if (status === "silence") return attempts === 0;
  if (status === "failed" || status === "ambiguous") return sorted.every(terminalFailure);
  return false;
}

/** The fallback model takes over once the primary has returned no words twice for this batch. */
export function attemptModel(prior: Array<{ outcome: string | null }>, primary: string, fallback: string): string {
  return prior.filter((row) => row.outcome === "empty_transcript").length >= EMPTY_RESULTS_BEFORE_FALLBACK ? fallback : primary;
}
