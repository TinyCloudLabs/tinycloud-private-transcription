import type { MiddlewareHandler } from "hono";
import { ApiError } from "../domain/errors.ts";
import type { AuthEnv } from "./auth.ts";

/**
 * API-key meeting scopes.
 *
 * `meetings:*` grants every meeting action and stays the default a key is minted with, so
 * existing keys keep working. The three specific scopes grant exactly their own action and
 * compose freely. Everything else is denied: an unusable scope set is a configuration mistake,
 * and the safe reading of a mistake is "no permission", never "all permissions".
 */
export type MeetingScope = "meetings:read" | "meetings:write" | "meetings:recover";

export const MEETINGS_WILDCARD = "meetings:*";

const KNOWN_SCOPES: ReadonlySet<string> = new Set<string>([MEETINGS_WILDCARD, "meetings:read", "meetings:write", "meetings:recover"]);

/**
 * Fail-closed: a set that is missing, not an array, empty, holds a non-string member, or names
 * any scope this build does not know grants nothing. Matching is exact — no trimming, no
 * case folding, no prefix matching — so a near-miss such as `" meetings:read"` is simply unknown.
 */
export function hasMeetingScope(scopes: unknown, required: MeetingScope): boolean {
  if (!Array.isArray(scopes) || scopes.length === 0) return false;
  if (!scopes.every((s) => typeof s === "string")) return false;
  if (!(scopes as string[]).every((s) => KNOWN_SCOPES.has(s))) return false;
  return scopes.includes(MEETINGS_WILDCARD) || scopes.includes(required);
}

/**
 * Route guard. Runs before the handler, so a refusal happens before any lookup, queue write,
 * capture-provider call, or status change. The message is deliberately generic: naming the
 * missing scope, or the ones the key holds, would turn a refusal into a probe of the key.
 */
export function requireMeetingScope(required: MeetingScope): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!hasMeetingScope(c.get("project")?.scopes, required)) {
      throw new ApiError("insufficient_scope", "This API key is not permitted to perform this action.");
    }
    await next();
  };
}
