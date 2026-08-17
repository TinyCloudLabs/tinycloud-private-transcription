import { Hono } from "hono";
import type { AppContext } from "../context.ts";
import { ApiError } from "../domain/errors.ts";
import { bearerAuth, type AuthEnv } from "./auth.ts";
import { healthRoutes } from "./routes/health.ts";
import { meetingRoutes } from "./routes/meetings.ts";

export function createApp(ctx: AppContext) {
  const app = new Hono<AuthEnv>();

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toBody(), err.status as 400);
    ctx.log.error("unhandled error", { path: c.req.path, error: String(err), stack: (err as Error).stack });
    return c.json(new ApiError("internal_error", "An internal error occurred").toBody(), 500);
  });
  app.notFound((c) => c.json({ error: { type: "not_found_error", code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` } }, 404));

  app.route("/", healthRoutes(ctx));
  app.use("/v1/*", bearerAuth(ctx));
  app.route("/v1/meetings", meetingRoutes(ctx));
  return app;
}
