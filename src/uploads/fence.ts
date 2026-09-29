import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { transcriptions } from "../db/schema.ts";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

/** A worker's claim on one job. Every worker write is a compare-and-swap against all of it. */
export interface Fence {
  id: string;
  token: string;
  generation: number;
}

/** The claim was invalidated (cancel, delete, timeout, or a newer claim). Stop and write no content. */
export class LostFence extends Error {
  constructor(readonly id: string) {
    super("claim fence lost");
  }
}

export const fenceGuard = (fence: Fence): SQL =>
  and(
    eq(transcriptions.id, fence.id),
    eq(transcriptions.status, "processing"),
    eq(transcriptions.claimToken, fence.token),
    eq(transcriptions.generation, fence.generation),
    eq(transcriptions.tombstoned, false),
  )!;

/**
 * Compare-and-swap that proves the fence still holds and row-locks the job for the rest of the
 * transaction (so a concurrent cancel/delete serializes after this write, and then sees the new state).
 * Also renews the claim heartbeat. Throws LostFence when any part of the fence changed.
 */
export async function holdFence(db: DbOrTx, fence: Fence): Promise<void> {
  const held = await db.update(transcriptions).set({ claimHeartbeatAt: sql`now()` }).where(fenceGuard(fence)).returning({ id: transcriptions.id });
  if (held.length === 0) throw new LostFence(fence.id);
}
