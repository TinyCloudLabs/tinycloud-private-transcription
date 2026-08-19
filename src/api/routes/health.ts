import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppContext } from "../../context.ts";

export function healthRoutes(ctx: AppContext) {
  const r = new Hono();
  r.get("/health", async (c) => {
    const [postgres, redis, vexa] = await Promise.all([
      ctx.db.execute(sql`select 1`).then(() => true, () => false),
      ctx.redis.ping().then(() => true, () => false),
      ctx.vexa.botStatus().then((s) => ({ ok: true, running_bots: s.running_bots.length }), () => ({ ok: false, running_bots: null })),
    ]);
    const core = postgres && redis;
    const status = !core ? "error" : vexa.ok ? "ok" : "degraded";
    return c.json(
      {
        status,
        checks: {
          postgres,
          redis,
          vexa: vexa.ok,
          // running = bots Vexa reports as live (null when Vexa is unreachable); max = provisioned ceiling.
          bot_capacity: { running: vexa.running_bots, max: ctx.config.vexa.maxConcurrentBots },
          transcription_provider: ctx.transcription.name,
        },
      },
      core ? 200 : 503,
    );
  });
  return r;
}
