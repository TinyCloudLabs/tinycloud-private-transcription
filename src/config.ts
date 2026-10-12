import { logger } from "./log.ts";

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

/** Comma-separated positive millisecond delays; empty entries are rejected so a typo cannot disable retries. */
export const backoffEnv = (name: string, fallback: string): number[] => {
  const values = env(name, fallback).split(",").map((value) => Number(value.trim()));
  if (!values.length || values.length > 15 || values.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error(`${name} must be 1-15 comma-separated positive integers`);
  return values;
};

/** Comma-separated positive integers; empty is an empty list. */
export const integerListEnv = (name: string, fallback: string): number[] => {
  const values = env(name, fallback).split(",").map((value) => value.trim()).filter(Boolean).map(Number);
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error(`${name} must be comma-separated positive integers`);
  return values;
};

export const percentEnv = (name: string, fallback: string): number => {
  const value = positiveIntegerEnv(name, fallback);
  if (value > 100) throw new Error(`${name} must be a percentage from 1 to 100`);
  return value;
};

/** `off` does nothing, `dry-run` logs what would be deleted, `apply` deletes (TC-904). */
export type ArtifactRetentionMode = "off" | "dry-run" | "apply";
export function parseArtifactRetentionMode(value: string): ArtifactRetentionMode {
  if (value !== "off" && value !== "dry-run" && value !== "apply") throw new Error(`ARTIFACT_RETENTION_MODE must be "off", "dry-run" or "apply", got ${JSON.stringify(value)}`);
  return value;
}

/** An invalid ops setting logs a warning and yields `fallback`: a typo must never stop api/worker boot (TC-904). */
export function lenientSetting<T>(name: string, fallback: T, parse: () => T, invalid?: string[]): T {
  try {
    return parse();
  } catch (error) {
    logger.warn("invalid setting ignored; using the default", { setting: name, default: fallback, error: (error as Error).message });
    invalid?.push(name);
    return fallback;
  }
}

/** Retention settings. Any invalid one also forces dry-run: a misread setting must never delete. */
export function artifactRetentionConfig() {
  const invalid: string[] = [];
  const mode = lenientSetting<ArtifactRetentionMode>("ARTIFACT_RETENTION_MODE", "dry-run", () => parseArtifactRetentionMode(env("ARTIFACT_RETENTION_MODE", "off")), invalid);
  const days = lenientSetting("ARTIFACT_RETENTION_DAYS", 14, () => positiveIntegerEnv("ARTIFACT_RETENTION_DAYS", "14"), invalid);
  const intervalMs = lenientSetting("ARTIFACT_RETENTION_INTERVAL_MS", 21_600_000, () => positiveIntegerEnv("ARTIFACT_RETENTION_INTERVAL_MS", "21600000"), invalid);
  const orphans = lenientSetting("ARTIFACT_RETENTION_ORPHANS", false, () => {
    const value = env("ARTIFACT_RETENTION_ORPHANS", "false");
    if (value !== "true" && value !== "false") throw new Error(`ARTIFACT_RETENTION_ORPHANS must be "true" or "false", got ${JSON.stringify(value)}`);
    return value === "true";
  }, invalid);
  const keepVexaMeetingIds = lenientSetting("ARTIFACT_RETENTION_KEEP_VEXA_MEETING_IDS", [] as number[], () => integerListEnv("ARTIFACT_RETENTION_KEEP_VEXA_MEETING_IDS", ""), invalid);
  if (invalid.length && mode === "apply") logger.warn("artifact retention forced to dry-run: a setting is invalid", { invalid });
  return {
    mode: invalid.length && mode === "apply" ? "dry-run" as const : mode,
    days,
    intervalMs,
    orphans,
    keepVexaMeetingIds,
    /** Vexa's MinIO. Retention lists and deletes objects directly: Vexa has no delete API for them. */
    s3: {
      endpoint: env("VEXA_MINIO_ENDPOINT", ""),
      accessKeyId: env("VEXA_MINIO_ACCESS_KEY", ""),
      secretAccessKey: env("VEXA_MINIO_SECRET_KEY", ""),
      /** File holding the secret key (the CVM self-provisions a least-privilege MinIO user; read per sweep). */
      secretAccessKeyFile: env("VEXA_MINIO_SECRET_KEY_FILE", ""),
      bucket: env("VEXA_MINIO_BUCKET", "vexa"),
    },
  };
}

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
    /**
     * Concurrent meeting-bot ceiling, enforced when POST /v1/meetings admits a non-Signal meeting
     * (TC-902) and reported in /health. Each bot is a ~1-1.2 GB Chromium container; the dstack
     * compose sets it per deploy and applies the same value to the Vexa user's max_concurrent_bots.
     */
    maxConcurrentBots: positiveIntegerEnv("VEXA_MAX_CONCURRENT_BOTS", "2"),
    /**
     * A Vexa 429 at bot start (its user's max_concurrent_bots, e.g. a leaving bot Vexa still counts)
     * is retried at this interval while the meeting stays queued, until this window after creation
     * has passed; only then does the meeting fail with capacity_exhausted.
     */
    capacityRetryIntervalMs: positiveIntegerEnv("VEXA_CAPACITY_RETRY_INTERVAL_MS", "10000"),
    capacityRetryWindowMs: positiveIntegerEnv("VEXA_CAPACITY_RETRY_WINDOW_MS", "120000"),
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
    /** Used for an attributed batch after two empty Whisper results, so voiced audio is not lost (TC-758). Untimed. */
    attributedFallbackModel: env("TINFOIL_ATTRIBUTED_FALLBACK_MODEL", "voxtral-small-24b"),
  },
  /**
   * Attributed batches and recording gap fills whose paid call was uncertain, empty or failed are
   * re-sent after these delays (TC-758). A batch gets length + 1 paid attempts and as many fetch
   * tries; a possible duplicate Tinfoil charge is accepted in exchange for never losing speech.
   */
  attributedRetry: {
    backoffMs: backoffEnv("ATTRIBUTED_RETRY_BACKOFF_MS", "30000,60000,120000,240000,480000"),
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
  /**
   * Disk-usage signal (TC-904). On the meeting CVM, `/` inside a container reports the one
   * persistent volume that holds Docker images, MinIO and Postgres. Shown in /health; the worker
   * logs a warning while usage is at or above the high-water mark.
   */
  disk: {
    path: env("DISK_CHECK_PATH", "/"),
    highWaterPercent: lenientSetting("DISK_HIGH_WATER_PERCENT", 80, () => percentEnv("DISK_HIGH_WATER_PERCENT", "80")),
  },
  /**
   * Retention for Vexa's bulky per-meeting artifacts in MinIO: recordings, attributed audio and
   * signal tapes (TC-904). Off by default. Only a meeting published (`completed`) more than `days`
   * ago qualifies; meetings with a reference transcript, a queued or running eval, or listed in
   * `keepVexaMeetingIds` are kept. Artifacts with no ptx meeting are deleted only with `orphans`.
   */
  artifactRetention: artifactRetentionConfig(),
  logLevel: env("LOG_LEVEL", "info"),
  /**
   * Sealed JSON array of `{id, project, scopes, sha256}` (hashes only) that the API makes the exact set of
   * bootstrap-managed keys at boot. Unset/empty = no bootstrap management; `[]` revokes all bootstrap keys.
   */
  bootstrapKeys: env("PTX_BOOTSTRAP_KEYS", ""),
};

export type Config = typeof config;
