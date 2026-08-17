const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
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
  },
  transcriptionProvider: env("TRANSCRIPTION_PROVIDER", "vexa") as TranscriptionProviderName,
  tinfoil: {
    baseUrl: env("TINFOIL_BASE_URL", "https://inference.tinfoil.sh"),
    apiKey: env("TINFOIL_API_KEY", ""),
    model: env("TINFOIL_MODEL", "voxtral-small-24b"),
  },
  logLevel: env("LOG_LEVEL", "info"),
};

export type Config = typeof config;
