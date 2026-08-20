const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
};

export const positiveIntegerEnv = (name: string, fallback: string): number => {
  const value = Number(env(name, fallback));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};

export type TranscriptionProviderName = "vexa" | "tinfoil";

export const config = {
  port: Number(env("PORT", "8080")),
  databaseUrl: env("DATABASE_URL", "postgres://ptx:ptx@localhost:55432/ptx"),
  redisUrl: env("REDIS_URL", "redis://localhost:56379"),
  vexa: {
    /** Real gateway of the capture rig (infra/README.md). Tests point this at the in-process mock (:18056 when run standalone). */
    baseUrl: env("VEXA_BASE_URL", "http://localhost:18066"),
    apiKey: env("VEXA_API_KEY", ""),
    pollIntervalMs: Number(env("VEXA_POLL_INTERVAL_MS", "5000")),
    /** Per-meeting Vexa delay after everyone else leaves. The bot then completes with `left_alone`. */
    maxTimeLeftAloneMs: positiveIntegerEnv("VEXA_MAX_TIME_LEFT_ALONE_MS", "300000"),
    /** Provisioned bot ceiling (matches `max_concurrent_bots` in infra/dstack/app-compose.yaml). Reported in /health. */
    maxConcurrentBots: Number(env("VEXA_MAX_CONCURRENT_BOTS", "5")),
  },
  /** Platforms accepted by POST /v1/meetings. Detection still recognizes all platforms; the rest are gated with 400 unsupported_platform. */
  enabledPlatforms: env("ENABLED_PLATFORMS", "jitsi").split(",").map((s) => s.trim()).filter(Boolean),
  /** Worker-side join deadline: a meeting still joining/waiting_for_admission this long after bot dispatch is failed and its bot stopped. */
  joinTimeoutSeconds: Number(env("JOIN_TIMEOUT_SECONDS", "600")),
  transcriptionProvider: env("TRANSCRIPTION_PROVIDER", "vexa") as TranscriptionProviderName,
  tinfoil: {
    baseUrl: env("TINFOIL_BASE_URL", "https://inference.tinfoil.sh"),
    apiKey: env("TINFOIL_API_KEY", ""),
    model: env("TINFOIL_MODEL", "voxtral-small-24b"),
    /** `turns` (per speaker turn, keeps segmentation) | `whole` (one call, one segment). */
    segmentation: env("TINFOIL_SEGMENTATION", "turns") as "turns" | "whole",
  },
  logLevel: env("LOG_LEVEL", "info"),
};

export type Config = typeof config;
