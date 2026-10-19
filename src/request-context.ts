import { AsyncLocalStorage } from "node:async_hooks";

// RFC 9562 canonical UUIDs, versions 1–8 and RFC variant; no nil/max, lists or opaque text.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requests = new AsyncLocalStorage<string>();

export function withRequestId<T>(presented: unknown, run: (id: string, replaced: boolean) => T): T {
  const valid = typeof presented === "string" && presented.length === 36 && UUID.test(presented);
  const id = valid ? presented.toLowerCase() : crypto.randomUUID();
  const replaced = presented !== undefined && !valid;
  return requests.run(id, () => run(id, replaced));
}

/** Undefined outside realtime API/job scopes: batch's correlation contract is independent. */
export function currentRequestId(): string | undefined { return requests.getStore(); }

/** Monotonic whole milliseconds, bounded for the typed request/worker event schema. */
export function requestDurationMs(started: number): number {
  return Math.min(86_400_000, Math.max(0, Math.floor(performance.now() - started)));
}
