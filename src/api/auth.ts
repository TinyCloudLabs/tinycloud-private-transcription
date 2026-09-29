import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../context.ts";
import { apiKeys, projects } from "../db/schema.ts";
import { ApiError } from "../domain/errors.ts";
import { newKeyId } from "../domain/ids.ts";

export const KEY_PREFIX = "tc_live_";

export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** A fresh plaintext API key. Only its sha256 is ever persisted. */
export const generateApiKey = () => `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;

/**
 * Every scope an API key can hold. Each scope is an exact, opaque string that grants one route
 * group; the `:*` suffix is naming only. There is no global wildcard and no prefix matching, so
 * `*`, `meetings`, or `meetings:read` grant nothing.
 */
export const API_KEY_SCOPES = ["meetings:*", "transcriptions:*", "admin:*"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Scopes of a key minted without explicit scopes. Every key created before enforcement holds meetings:* (migration 0016). */
export const DEFAULT_KEY_SCOPES: readonly ApiKeyScope[] = ["meetings:*"];

/** Validates scopes for a key being minted: at least one, all known. Returns them de-duplicated. */
export function parseScopes(input: readonly string[]): ApiKeyScope[] {
  if (input.length === 0) throw new Error("An API key needs at least one scope");
  const unknown = input.filter((scope) => !(API_KEY_SCOPES as readonly string[]).includes(scope));
  if (unknown.length > 0) {
    throw new Error(`Unknown API key scope(s): ${unknown.map((s) => JSON.stringify(s)).join(", ")}; known scopes: ${API_KEY_SCOPES.join(", ")}`);
  }
  return [...new Set(input)] as ApiKeyScope[];
}

export interface AuthedProject {
  id: string;
  scopes: string[];
}

export type AuthEnv = { Variables: { project: AuthedProject } };

export function bearerAuth(ctx: AppContext): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token || !token.startsWith(KEY_PREFIX)) {
      throw new ApiError("unauthorized", "Missing or malformed API key");
    }
    const [row] = await ctx.db
      .select({ projectId: apiKeys.projectId, scopes: apiKeys.scopes })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hashApiKey(token)))
      .limit(1);
    if (!row) throw new ApiError("unauthorized", "Invalid API key");
    c.set("project", { id: row.projectId, scopes: row.scopes });
    await next();
  };
}

/** Rejects the request with 403 `insufficient_scope` unless the authenticated key holds exactly `scope`. Runs after `bearerAuth`. */
export function requireScope(scope: ApiKeyScope): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!c.get("project").scopes.includes(scope)) {
      throw new ApiError("insufficient_scope", `API key lacks the required scope ${scope}`);
    }
    await next();
  };
}

/** Creates the project if needed and mints a new key. Returns the plaintext key exactly once. */
export async function createApiKey(ctx: AppContext, projectId: string, scopes: readonly string[] = DEFAULT_KEY_SCOPES) {
  const validScopes = parseScopes(scopes);
  await ctx.db
    .insert(projects)
    .values({ id: projectId, name: projectId, webhookSecret: `whsec_${randomBytes(24).toString("hex")}` })
    .onConflictDoNothing();
  const key = generateApiKey();
  await ctx.db.insert(apiKeys).values({ id: newKeyId(), projectId, keyHash: hashApiKey(key), scopes: validScopes });
  const [p] = await ctx.db.select({ secret: projects.webhookSecret }).from(projects).where(eq(projects.id, projectId));
  return { key, webhookSecret: p!.secret, scopes: validScopes };
}
