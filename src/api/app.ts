import { Hono } from "hono";
import type { AppContext } from "../context.ts";
import { ApiError } from "../domain/errors.ts";
import { bearerAuth, requireScope, type ApiKeyScope, type AuthEnv } from "./auth.ts";
import { healthRoutes } from "./routes/health.ts";
import { meetingRoutes } from "./routes/meetings.ts";

/** An authenticated route group and the single API-key scope every one of its routes requires. */
export interface ScopedGroup {
  scope: ApiKeyScope;
  routes: Hono<AuthEnv>;
}

/** The authenticated API: route groups keyed by their `/v1/<name>` mount path. Nothing else under `/v1` is reachable. */
export type ScopedGroups = Record<string, ScopedGroup>;

const GROUP_PATH = /^\/v1\/[a-z][a-z0-9-]*$/;

/** The meeting service's authenticated route groups. */
export const meetingGroups = (ctx: AppContext): ScopedGroups => ({
  "/v1/meetings": { scope: "meetings:*", routes: meetingRoutes(ctx) },
});

export function createApp(ctx: AppContext, groups: ScopedGroups = meetingGroups(ctx)) {
  const table = Object.entries(groups).map(([path, group]) => {
    if (!GROUP_PATH.test(path)) throw new Error(`authenticated route group ${path} must be mounted at /v1/<name>`);
    return { path, authorize: requireScope(group.scope) };
  });
  const app = new Hono<AuthEnv>();

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toBody(), err.status as 400);
    // Request errors can contain SQL, request bodies, provider data, or Signal fragments.  Keep
    // lifecycle telemetry intentionally finite and content-free.
    ctx.log.error("api request failed", { stage: "api_unhandled", code: "internal_error" });
    return c.json(new ApiError("internal_error", "An internal error occurred").toBody(), 500);
  });
  app.notFound((c) => c.json({ error: { type: "not_found_error", code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` } }, 404));

  app.route("/", healthRoutes(ctx));
  // Deny by default. Every /v1 request is authenticated, then authorized against the group registry
  // above: the owning group's scope is required, and a path outside every registered group is 404 even
  // for a valid key. A route mounted under /v1 any other way is therefore unreachable.
  app.use("/v1/*", bearerAuth(ctx), async (c, next) => {
    const group = table.find(({ path }) => c.req.path === path || c.req.path.startsWith(`${path}/`));
    if (!group) return c.notFound();
    return group.authorize(c, next);
  });
  for (const [path, group] of Object.entries(groups)) app.route(path, group.routes);
  return app;
}
