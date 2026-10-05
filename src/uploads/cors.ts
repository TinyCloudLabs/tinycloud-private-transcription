import type { MiddlewareHandler } from "hono";

/** `scheme://host[:port]`, lowercase, no path; the host may start with one `*.` wildcard label. */
const ORIGIN_ENTRY = /^([a-z][a-z0-9+.-]*):\/\/(\*\.)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(:[0-9]{1,5})?$/;
const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Parses BATCH_CORS_ORIGINS: comma-separated exact origins, each optionally with one leading wildcard label
 * (`https://*.tinychat-4jq.pages.dev`). Empty/unset → no CORS. Any malformed entry throws, so the service
 * refuses to start rather than silently allow or block an origin.
 */
export function parseCorsOrigins(raw: string): string[] {
  if (raw.trim() === "") return [];
  return raw.split(",").map((part) => {
    const entry = part.trim();
    if (!ORIGIN_ENTRY.test(entry)) {
      throw new Error(`BATCH_CORS_ORIGINS: "${entry}" is not an origin (scheme://host[:port], lowercase, optional leading "*." label, no path)`);
    }
    return entry;
  });
}

/** Builds the origin predicate. A wildcard matches exactly one DNS label: `*.x.dev` allows `a.x.dev`, not `x.dev` or `a.b.x.dev`. */
export function corsOriginMatcher(entries: readonly string[]): (origin: string) => boolean {
  const exact = new Set(entries.filter((entry) => !entry.includes("://*.")));
  const wildcards = entries.filter((entry) => entry.includes("://*.")).map((entry) => {
    const [scheme, rest] = entry.split("://*.") as [string, string];
    return new RegExp(`^${escape(scheme)}://${LABEL}\\.${escape(rest)}$`);
  });
  return (origin) => exact.has(origin) || wildcards.some((pattern) => pattern.test(origin));
}

/**
 * CORS for `PUT /uploads/{id}` only, so a browser can upload straight to PTX with the capability. Preflight is
 * answered here; the PUT and every error it returns carry the allow headers. No credentials are allowed: the
 * capability travels in Authorization, never a cookie. No entries → passthrough (no CORS headers at all).
 */
export function uploadCors(entries: readonly string[]): MiddlewareHandler {
  if (entries.length === 0) return async (_c, next) => next();
  const allowed = corsOriginMatcher(entries);
  return async (c, next) => {
    const origin = c.req.header("origin");
    const allow = origin !== undefined && allowed(origin);
    if (c.req.method === "OPTIONS") {
      const headers = new Headers({ Vary: "Origin" });
      if (allow) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Allow-Methods", "PUT, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
        headers.set("Access-Control-Max-Age", "600");
      }
      return new Response(null, { status: 204, headers });
    }
    await next();
    c.res.headers.append("Vary", "Origin");
    if (allow) c.res.headers.set("Access-Control-Allow-Origin", origin);
  };
}
