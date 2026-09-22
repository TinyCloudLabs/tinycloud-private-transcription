import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { AppContext } from "../../context.ts";
import { TinfoilTranscriptionProvider } from "../../providers/transcription/tinfoil.ts";
import { attributedWorkerReady } from "../../services/attributed-transcription.ts";

export function healthRoutes(ctx: AppContext) {
  const r = new Hono();
  r.get("/health", async (c) => {
    const [postgres, redis, vexa] = await Promise.all([
      ctx.db.execute(sql`select 1`).then(() => true, () => false),
      ctx.redis.ping().then(() => true, () => false),
      ctx.vexa.botStatus().then((s) => ({ ok: true, running_bots: s.running_bots.length }), () => ({ ok: false, running_bots: null })),
    ]);
    const signal = signalReadiness(
      ctx.config.signal.healthPaths,
      ctx.config.enabledPlatforms.includes("signal"),
      ctx.config.signal.maxConcurrentCalls,
    );
    const core = postgres && redis;
    const attributedProviderReady = ctx.transcriptRecovery instanceof TinfoilTranscriptionProvider && await attributedWorkerReady(ctx);
    const attributed = {
      enabled: ctx.config.attributedTranscriptionEnabled,
      ready: !ctx.config.attributedTranscriptionEnabled || attributedProviderReady,
      reason: ctx.config.attributedTranscriptionEnabled && !attributedProviderReady ? (ctx.transcriptRecovery instanceof TinfoilTranscriptionProvider ? "Attributed transcription reconciliation is incomplete" : "Attributed transcription provider is not configured") : null,
    };
    const status = !core ? "error" : vexa.ok && signal.ready && attributed.ready ? "ok" : "degraded";
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
          attributed_transcription: attributed,
          signal,
        },
      },
      core ? 200 : 503,
    );
  });
  return r;
}

export function signalReadiness(paths: string[], enabled: boolean, provisionedSeats: number) {
  if (!enabled) return { enabled: false, ready: true, reason: null, capacity: null };
  if (!paths.length) return { enabled: true, ready: false, reason: "Signal capture readiness is not configured", capacity: null };
  if (paths.length !== provisionedSeats) return { enabled: true, ready: false, reason: "Signal capture readiness does not match provisioned capacity", capacity: null };

  let running = 0;
  let max = 0;
  let validCapacity = true;
  const failures: string[] = [];
  for (const [index, path] of paths.entries()) {
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as { ready?: unknown; reason_code?: unknown; observed_at?: unknown; capacity?: { running?: unknown; max?: unknown } };
      const observedAt = typeof record.observed_at === "string" ? Date.parse(record.observed_at) : NaN;
      const age = Date.now() - observedAt;
      if (!Number.isFinite(observedAt) || age < 0 || age > 15_000) {
        failures.push(`seat ${index + 1} readiness is stale`);
        validCapacity = false;
        continue;
      }
      const seatRunning = record.capacity?.running;
      const seatMax = record.capacity?.max;
      if (!Number.isSafeInteger(seatRunning) || (seatRunning as number) < 0 || (seatRunning as number) > 1
          || seatMax !== 1) {
        failures.push(`seat ${index + 1} capacity is invalid`);
        validCapacity = false;
      } else {
        running += seatRunning as number;
        max += seatMax as number;
      }
      if (record.ready !== true) {
        failures.push(`seat ${index + 1} is not ready`);
        validCapacity = false;
      }
    } catch {
      failures.push(`seat ${index + 1} readiness is unavailable`);
      validCapacity = false;
    }
  }

  return {
    enabled: true,
    ready: failures.length === 0,
    reason: failures.length ? failures.join("; ") : null,
    capacity: validCapacity ? { running, max } : null,
  };
}
