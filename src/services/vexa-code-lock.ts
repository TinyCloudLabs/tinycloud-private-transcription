import { sql } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { ApiError } from "../domain/errors.ts";

/**
 * Serialises, per platform + meeting CODE, the two ptx paths that can create or destroy the Vexa row a
 * code resolves to: starting a bot (`POST /bots`) and the code-addressed delete (TC-3136).
 *
 * Vexa addresses a delete by code, and a code can recur (a standing Meet room). The delete is only sent
 * after Vexa resolves the code to one of OUR recorded rows; without this lock another meeting's bot start
 * could land between that check and the delete, and the delete would purge the newer meeting. Every
 * start goes through ptx, so holding one lock per code across "resolve + delete" (and across the start's
 * own provider call) closes that window. Taken as a transaction-scoped Postgres advisory lock: released on
 * commit, rollback or connection loss, so a crashed holder cannot leave it behind.
 *
 * - `wait` (a bot start): queues behind the holder for up to `LOCK_WAIT_MS`, then fails retryably.
 * - `try` (a delete): never queues. If the code is busy it fails at once with a retryable
 *   `provider_unavailable` having sent nothing, so a second delete on the same code (another worker, or a
 *   retry after an unknown outcome) neither races the first nor blocks behind it; the owner's retry
 *   re-runs the whole check.
 *
 * The lock transaction holds one pool connection while `fn` uses others, so the number of simultaneous
 * holders in this process is capped to leave the pool free for them.
 */
const LOCK_WAIT_MS = 30_000;
const MAX_HOLDERS = 3;
let holders = 0;
const waiters: Array<() => void> = [];
export class CodeBusyError extends ApiError {
  constructor() {
    super("provider_unavailable", "Another request for the same meeting code is in progress; try again");
  }
}

const busy = () => new CodeBusyError();

async function takeSlot(mode: "wait" | "try"): Promise<void> {
  if (holders < MAX_HOLDERS) {
    holders++;
    return;
  }
  if (mode === "try") throw busy();
  const turn = Promise.withResolvers<void>();
  waiters.push(turn.resolve);
  await turn.promise; // the releasing holder hands its slot straight to us
}

function freeSlot(): void {
  const next = waiters.shift();
  if (next) next();
  else holders--;
}

export async function withVexaCodeLock<T>(ctx: AppContext, platform: string, code: string | null, mode: "wait" | "try", fn: () => Promise<T>): Promise<T> {
  if (code === null) return fn(); // no code, nothing a code-addressed delete could resolve to
  await takeSlot(mode);
  try {
    return await ctx.db.transaction(async (tx) => {
      const key = `vexa-code:${platform}:${code}`;
      try {
        if (mode === "try") {
          const rows = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${key})) as locked`);
          if (rows[0]?.locked !== true) throw busy();
        } else {
          await tx.execute(sql.raw(`set local lock_timeout = ${LOCK_WAIT_MS}`));
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
        }
      } catch (error) {
        throw error instanceof ApiError ? error : busy();
      }
      return fn();
    });
  } finally {
    freeSlot();
  }
}
