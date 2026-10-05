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

/**
 * Which service this process is. `meeting` (default) is the live meeting-bot service and never mounts or
 * runs anything batch. `batch` is the dedicated batch-transcription service (src/roles/batch.ts), which
 * never touches Vexa, Redis or Signal. Anything else fails boot.
 */
export type PtxRole = "meeting" | "batch";
export function parseRole(value: string): PtxRole {
  if (value !== "meeting" && value !== "batch") throw new Error(`PTX_ROLE must be "meeting" or "batch", got ${JSON.stringify(value)}`);
  return value;
}

export const config = {
  role: parseRole(env("PTX_ROLE", "meeting")),
  port: Number(env("PORT", "8080")),
  databaseUrl: env("DATABASE_URL", "postgres://ptx:ptx@localhost:55432/ptx"),
  redisUrl: env("REDIS_URL", "redis://localhost:56379"),
  vexa: {
    /** Real gateway of the capture rig (infra/README.md). Tests point this at the in-process mock (:18056 when run standalone). */
    baseUrl: env("VEXA_BASE_URL", "http://localhost:18066"),
    apiKey: env("VEXA_API_KEY", ""),
    // Strictly positive: every attributed requeue delay is derived from it, and delayMs <= 0 would
    // bypass the delayed-queue dedupe and reintroduce the capacity-wait hot loop (TC-576).
    pollIntervalMs: positiveIntegerEnv("VEXA_POLL_INTERVAL_MS", "5000"),
    /** Per-meeting Vexa remote-participant audio silence window before the bot completes with `left_alone`. */
    maxTimeLeftAloneMs: positiveIntegerEnv("VEXA_MAX_TIME_LEFT_ALONE_MS", "300000"),
    /** Provisioned bot ceiling (matches `max_concurrent_bots` in infra/dstack/app-compose.yaml). Reported in /health. */
    maxConcurrentBots: Number(env("VEXA_MAX_CONCURRENT_BOTS", "5")),
  },
  /** Opt-in until the Vexa producer contract is deployed everywhere. */
  attributedTranscriptionEnabled: env("ATTRIBUTED_TRANSCRIPTION_ENABLED", "false") === "true",
  /** Isolated capture workers which own Signal Desktop CDP and PulseAudio capture. */
  signal: {
    /** One loopback capture endpoint per independently linked Signal Desktop seat. */
    captureUrls: env("SIGNAL_CAPTURE_URLS", env("SIGNAL_CAPTURE_URL", "http://127.0.0.1:18076"))
      .split(",").map((value) => value.trim()).filter(Boolean),
    /** One private control-token file per capture endpoint; required for non-loopback endpoints. */
    controlTokenPaths: env("SIGNAL_CAPTURE_TOKEN_PATHS", "")
      .split(",").map((value) => value.trim()).filter(Boolean),
    /** Non-secret readiness records written independently by each capture seat. */
    healthPaths: env("SIGNAL_HEALTH_PATHS", env("SIGNAL_HEALTH_PATH", ""))
      .split(",").map((value) => value.trim()).filter(Boolean),
    capabilityKey: env("SIGNAL_CAPABILITY_KEY", ""),
    maxConcurrentCalls: positiveIntegerEnv("SIGNAL_MAX_CONCURRENT_CALLS", "1"),
    /** Capture-worker process settings. Bind and CDP endpoint are rejected unless loopback. */
    capture: {
      bind: env("SIGNAL_CAPTURE_BIND", "127.0.0.1"),
      port: positiveIntegerEnv("SIGNAL_CAPTURE_PORT", "18076"),
      cdpUrl: env("SIGNAL_CDP_URL", "http://127.0.0.1:9222"),
      profileDir: env("SIGNAL_PROFILE_DIR", "/var/lib/signal"),
      pulseSource: env("SIGNAL_PULSE_SOURCE", ""),
      /** argv prefix; the worker appends a temporary wav path and reads JSON RawSegment[] on stdout. */
      transcriber: env("SIGNAL_TRANSCRIBER", "").split(" ").filter(Boolean),
      /** Replay timeline used only by the rig smoke; it captures no audio and proves no live call. */
      replayScript: env("SIGNAL_REPLAY_SCRIPT", ""),
      /** Hard ceiling on one captured call, so a forgotten seat cannot hold Signal Desktop forever. */
      maxCallSeconds: positiveIntegerEnv("SIGNAL_MAX_CALL_SECONDS", "7200"),
      /** How long a terminal snapshot stays readable so PTX's next poll can finalize. */
      sessionRetentionSeconds: positiveIntegerEnv("SIGNAL_SESSION_RETENTION_SECONDS", "900"),
      /** Shared, non-secret readiness record written by the isolated capture worker. */
      healthPath: env("SIGNAL_HEALTH_PATH", ""),
      /** Private bearer token authenticating the PTX worker to this seat's control API. */
      controlTokenPath: env("SIGNAL_CAPTURE_TOKEN_PATH", ""),
    },
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
    /** Attributed Google Meet batches (TC-741): a Whisper model returns segment timestamps for turn order. */
    attributedModel: env("TINFOIL_ATTRIBUTED_MODEL", ""),
  },
  /** Internal transcript evaluation (TC-745): shadow transcriptions stored beside the canonical one. */
  eval: {
    /** Comma-separated Tinfoil models re-run on each eligible meeting after publication; empty disables. */
    models: env("EVAL_MODELS", "").split(",").map((s) => s.trim()).filter(Boolean),
    /** Lowercase TinyChat owner addresses whose meetings are evaluated automatically. */
    tinychatAddresses: env("EVAL_TINYCHAT_ADDRESSES", "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    allMeetings: env("EVAL_ALL_MEETINGS", "false") === "true",
    delayMs: positiveIntegerEnv("EVAL_DELAY_MS", "120000"),
    /** Production attributed transcription owns two Tinfoil dispatch slots; evals take one more at most. */
    concurrency: positiveIntegerEnv("EVAL_CONCURRENCY", "1"),
  },
  /** Durable paid-call fence for whole-recording recovery (TC-574). */
  recordingRecovery: {
    /**
     * How long one admission may own the paid transcription slot without a heartbeat before a
     * competing poll may re-admit it. Must comfortably exceed one dispatch wave's worst-case
     * duration (see TranscriptionProvider.maxRequestWaveMs) plus the heartbeat freshness margin;
     * the worker treats an acknowledgement older than the leftover budget as a fence miss.
     */
    admissionMs: positiveIntegerEnv("RECORDING_RECOVERY_ADMISSION_MS", "600000"),
  },
  logLevel: env("LOG_LEVEL", "info"),
  /**
   * Sealed JSON array of `{id, project, scopes, sha256}` (hashes only) that the API makes the exact set of
   * bootstrap-managed keys at boot. Unset/empty = no bootstrap management; `[]` revokes all bootstrap keys.
   */
  bootstrapKeys: env("PTX_BOOTSTRAP_KEYS", ""),
};

export type Config = typeof config;
