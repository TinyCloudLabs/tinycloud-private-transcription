import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { RecoveryBudgetTransaction } from "../db/recovery-budget.ts";
import { meetings } from "../db/schema.ts";

export type MeetingCallFenceTransaction = RecoveryBudgetTransaction;
export type LiveMeeting = typeof meetings.$inferSelect;

export type MeetingFencedCall<T> =
  | { readonly kind: "stale"; readonly invocationBegan: false }
  | { readonly kind: "not_started"; readonly invocationBegan: false }
  | { readonly kind: "ambiguous"; readonly invocationBegan: true }
  | { readonly kind: "started"; readonly invocationBegan: true; readonly response: Promise<T> };

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
  let invocationBegan = false;
  try {
    return await db.transaction(async (tx) => {
      const [meeting] = await tx.select().from(meetings).where(and(
        eq(meetings.id, meetingId),
        isNull(meetings.deletedAt),
      )).for("update");
      if (!meeting) return { kind: "stale" as const, invocationBegan: false as const };
      const authority = await authorize(tx, meeting);
      if (authority === null) return { kind: "stale" as const, invocationBegan: false as const };

      let response: Promise<T>;
      invocationBegan = true;
      try {
        response = Promise.resolve(invoke(authority));
      } catch (error) {
        response = Promise.reject(error);
      }
      // The response is abandoned if commit acknowledgement is lost. Attach a terminal rejection
      // observer before commit so neither prompt nor late rejection can escape as unhandled work.
      void response.catch(() => {});
      return { kind: "started" as const, invocationBegan: true as const, response };
    });
  } catch {
    return invocationBegan
      ? { kind: "ambiguous", invocationBegan: true }
      : { kind: "not_started", invocationBegan: false };
  }
}
