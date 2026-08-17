import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../context.ts";
import { apiKeys, projects } from "../db/schema.ts";
import { ApiError } from "../domain/errors.ts";
import { newKeyId } from "../domain/ids.ts";

export const KEY_PREFIX = "tc_live_";

export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

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

/** Creates the project if needed and mints a new key. Returns the plaintext key exactly once. */
export async function createApiKey(ctx: AppContext, projectId: string, scopes: string[] = ["meetings:*"]) {
  await ctx.db
    .insert(projects)
    .values({ id: projectId, name: projectId, webhookSecret: `whsec_${randomBytes(24).toString("hex")}` })
    .onConflictDoNothing();
  const key = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  await ctx.db.insert(apiKeys).values({ id: newKeyId(), projectId, keyHash: hashApiKey(key), scopes });
  const [p] = await ctx.db.select({ secret: projects.webhookSecret }).from(projects).where(eq(projects.id, projectId));
  return { key, webhookSecret: p!.secret };
}
