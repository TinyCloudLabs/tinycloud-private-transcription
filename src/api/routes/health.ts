import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
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
    const signal = signalReadiness(ctx.config.signal.capture.healthPath, ctx.config.enabledPlatforms.includes("signal"));
    const core = postgres && redis;
    const status = !core ? "error" : vexa.ok && signal.ready ? "ok" : "degraded";
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
          signal,
        },
      },
      core ? 200 : 503,
    );
  });
  return r;
}

function signalReadiness(path: string, enabled: boolean) {
  if (!enabled) return { enabled: false, ready: true, reason: null, capacity: null };
  if (!path) return { enabled: true, ready: false, reason: "Signal capture readiness is not configured", capacity: null };
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as { ready?: unknown; reason?: unknown; observed_at?: unknown; capacity?: { running?: unknown; max?: unknown } };
    const observedAt = typeof record.observed_at === "string" ? Date.parse(record.observed_at) : NaN;
    const age = Date.now() - observedAt;
    if (!Number.isFinite(observedAt) || age < 0 || age > 15_000) return { enabled: true, ready: false, reason: "Signal capture readiness is stale", capacity: null };
    const running = record.capacity?.running;
    const max = record.capacity?.max;
    const capacity = Number.isSafeInteger(running) && (running as number) >= 0 && Number.isSafeInteger(max) && (max as number) > 0
      ? { running, max }
      : null;
    return { enabled: true, ready: record.ready === true, reason: typeof record.reason === "string" ? record.reason : null, capacity };
  } catch {
    return { enabled: true, ready: false, reason: "Signal capture readiness is unavailable", capacity: null };
  }
}
