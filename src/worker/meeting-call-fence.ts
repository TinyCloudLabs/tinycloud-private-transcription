import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { RecoveryBudgetTransaction } from "../db/recovery-budget.ts";
import { meetings } from "../db/schema.ts";

export type MeetingCallFenceTransaction = RecoveryBudgetTransaction;
export type LiveMeeting = typeof meetings.$inferSelect;

export type MeetingFencedCall<T> =
  | { readonly kind: "stale" }
  | { readonly kind: "started"; readonly response: Promise<T> };

/**
 * Start one external call while holding the live meeting row lock. Additional authority is locked
 * and revalidated by `authorize`. The transaction returns the response promise as inert data, so it
 * commits before the caller awaits the external response.
 */
export async function startMeetingFencedCall<T, Authority>(
  db: Db,
  meetingId: string,
  authorize: (
    tx: MeetingCallFenceTransaction,
    meeting: LiveMeeting,
  ) => Promise<Authority | null>,
  invoke: (authority: Authority) => Promise<T>,
): Promise<MeetingFencedCall<T>> {
  return db.transaction(async (tx) => {
    const [meeting] = await tx.select().from(meetings).where(and(
      eq(meetings.id, meetingId),
      isNull(meetings.deletedAt),
    )).for("update");
    if (!meeting) return { kind: "stale" as const };
    const authority = await authorize(tx, meeting);
    if (authority === null) return { kind: "stale" as const };

    let response: Promise<T>;
    try {
      response = Promise.resolve(invoke(authority));
    } catch (error) {
      response = Promise.reject(error);
    }
    // The caller awaits this same promise after commit. Attach a handler now so a prompt rejection
    // cannot become unhandled while the transaction is still releasing its locks.
    void response.catch(() => {});
    return { kind: "started" as const, response };
  });
}
