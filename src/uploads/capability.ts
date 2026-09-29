import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Job-scoped upload capability: `PUT /uploads/{id}` only, for that job's declared length/hash/type. */
export const CAPABILITY_PREFIX = "tcu_";
export const generateCapability = () => `${CAPABILITY_PREFIX}${randomBytes(32).toString("base64url")}`;
export const hashCapability = (token: string) => createHash("sha256").update(token).digest("hex");

/** Compares the presented token against every stored hash in constant time per comparison, without early exit. */
export function matchCapability<T extends { tokenHash: string }>(token: string, rows: readonly T[]): T | null {
  const presented = Buffer.from(hashCapability(token), "hex");
  let match: T | null = null;
  for (const row of rows) {
    const stored = Buffer.from(row.tokenHash, "hex");
    if (stored.length === presented.length && timingSafeEqual(stored, presented) && match === null) match = row;
  }
  return match;
}

/** Constant-time equality of two lowercase hex digests. */
export function digestEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}
