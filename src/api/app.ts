import { Hono } from "hono";
import type { AppContext } from "../context.ts";
import { ApiError } from "../domain/errors.ts";
import { newRequestId } from "../domain/ids.ts";
import { bearerAuth, type AuthEnv } from "./auth.ts";
import { healthRoutes } from "./routes/health.ts";
import { meetingRoutes } from "./routes/meetings.ts";
import { capabilityRoutes } from "./routes/capabilities.ts";
import { createProductionRecoveryApiRuntime, type RecoveryApiRuntime } from "./recovery-runtime.ts";

export function createApp(ctx: AppContext, options: { recoveryApiRuntime?: RecoveryApiRuntime } = {}) {
  const app = new Hono<AuthEnv>();
  const recoveryApiRuntime = options.recoveryApiRuntime ?? createProductionRecoveryApiRuntime(ctx);

  // Minted per request and never read from a request header: an echoed id would let a caller
  // choose the correlation token that appears in our logs and in another response.
  app.use("*", async (c, next) => {
    c.set("requestId", newRequestId());
    await next();
  });

  app.onError((err, c) => {
    const requestId = c.get("requestId") ?? newRequestId();
    if (err instanceof ApiError) {
      if (err.status === 429 && err.retryAfterSeconds !== null) {
        c.header("Retry-After", String(err.retryAfterSeconds));
      }
      return c.json(err.toBody(requestId), err.status as 400);
    }
    // Do not inspect or serialize the exception or request. Either can contain provider bodies,
    // URLs, identifiers, credentials, caller correlation values, or an unbounded stack.
    ctx.log.error("request_failed", { requestId, errorClass: "unhandled_error" });
    return c.json(new ApiError("internal_error", "An internal error occurred").toBody(requestId), 500);
  });
  // The requested method and path are deliberately not echoed: the response is for a caller that
  // already knows what it sent, and reflecting it back only widens what a rejection can carry.
  app.notFound((c) =>
    c.json(new ApiError("not_found", "No route matches this request.").toBody(c.get("requestId") ?? newRequestId()), 404),
  );

  app.route("/", healthRoutes(ctx));
  app.use("/v1/*", bearerAuth(ctx));
  app.route("/v1", capabilityRoutes(ctx, recoveryApiRuntime));
  app.route("/v1/meetings", meetingRoutes(ctx, recoveryApiRuntime));
  return app;
}
