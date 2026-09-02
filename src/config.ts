import { createRecoveryConfiguration } from "./recovery-config.ts";

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

/** Strict boolean env: only the literals `true`/`false` are accepted, so a typo fails loudly instead of silently enabling or disabling a switch. */
export const booleanEnv = (name: string, fallback: string): boolean => {
  const value = env(name, fallback);
  if (value !== "true" && value !== "false") throw new Error(`${name} must be "true" or "false"`);
  return value === "true";
};

export type TranscriptionProviderName = "vexa" | "tinfoil";

const recovery = createRecoveryConfiguration(process.env);

export const config = {
  port: Number(env("PORT", "8080")),
  databaseUrl: env("DATABASE_URL", "postgres://ptx:ptx@localhost:55432/ptx"),
  redisUrl: env("REDIS_URL", "redis://localhost:56379"),
  vexa: {
    /** Real gateway of the capture rig (infra/README.md). Tests point this at the in-process mock (:18056 when run standalone). */
    baseUrl: env("VEXA_BASE_URL", "http://localhost:18066"),
    apiKey: env("VEXA_API_KEY", ""),
    pollIntervalMs: Number(env("VEXA_POLL_INTERVAL_MS", "5000")),
    /** Per-meeting Vexa remote-participant audio silence window before the bot completes with `left_alone`. */
    maxTimeLeftAloneMs: positiveIntegerEnv("VEXA_MAX_TIME_LEFT_ALONE_MS", "300000"),
    /** Provisioned bot ceiling (matches `max_concurrent_bots` in infra/dstack/app-compose.yaml). Reported in /health. */
    maxConcurrentBots: Number(env("VEXA_MAX_CONCURRENT_BOTS", "5")),
  },
  /** Platforms accepted by POST /v1/meetings. Detection still recognizes all platforms; the rest are gated with 400 unsupported_platform. */
  enabledPlatforms: env("ENABLED_PLATFORMS", "jitsi").split(",").map((s) => s.trim()).filter(Boolean),
  /** Worker-side join deadline: a meeting still joining/waiting_for_admission this long after bot dispatch is failed and its bot stopped. */
  joinTimeoutSeconds: Number(env("JOIN_TIMEOUT_SECONDS", "600")),
  transcriptionProvider: env("TRANSCRIPTION_PROVIDER", "vexa") as TranscriptionProviderName,
  /**
   * Intent switch for recovery v2. Off by default and never sufficient on its own: A0/A1 refuse
   * every failed-row restart until A2-A4 install compatible transactional/capability authority.
   */
  recoveryV2Enabled: recovery.switches.acceptance,
  /** One parsed, typed, sanitized source for every recovery policy and readiness seam. */
  recovery,
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
