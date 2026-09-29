import { positiveIntegerEnv } from "../config.ts";

/** 2 h at 128 kbps stereo + 5% (the same formula Exo uses for its 8 h local cap). */
export const MAX_UPLOAD_BYTES = 120_960_000;
export const MAX_DURATION_SECONDS = 7_200;
export const MAX_CHANNELS = 2;
export const CONTENT_TYPES = ["audio/mpeg", "audio/wav", "audio/ogg"] as const;
export type UploadContentType = (typeof CONTENT_TYPES)[number];

/**
 * Batch-role configuration. Read only when PTX_ROLE=batch; the meeting role never evaluates it. The batch
 * Tinfoil credential has its own variable (BATCH_TINFOIL_API_KEY) so a batch process can never pick up the
 * meeting service's TINFOIL_API_KEY by accident.
 */
export interface BatchConfig {
  port: number;
  databaseUrl: string;
  /** Holds jobs/<id>/…: accepted audio, in-flight upload temp files and per-claim PCM work dirs. */
  uploadDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  tinfoil: { baseUrl: string; apiKey: string; model: string; timeoutMs: number };
  limits: {
    maxBytes: number;
    maxDurationSeconds: number;
    maxChannels: number;
    /** Service-wide jobs in awaiting_upload + queued + processing. */
    maxActiveJobs: number;
    /** Service-wide sum of declared byte_size over the same active set. Bounds temp + accepted audio on disk. */
    maxReservedBytes: number;
    /** Service-wide PUTs holding a live upload lease. */
    maxConcurrentUploads: number;
    /** Creates and PUTs are refused while the upload volume is at or above this used percentage. */
    diskHighWaterPercent: number;
    /** Per tenant per UTC day, charged at create. */
    tenantDailyBytes: number;
  };
  upload: {
    capabilityTtlSeconds: number;
    maxLiveCapabilities: number;
    /** Absolute: create + this. After it the job fails upload_expired and no PUT is accepted. */
    deadlineSeconds: number;
    /** Absolute cap on one PUT, also clamped to the job's upload deadline. Heartbeats never extend it. */
    maxPutSeconds: number;
    /** A PUT is aborted after `progressGraceSeconds` if its average rate drops below this. */
    minBytesPerSecond: number;
    progressGraceSeconds: number;
    /** A PUT is aborted when no bytes arrive for this long. */
    idleTimeoutSeconds: number;
    leaseHeartbeatSeconds: number;
    /** A lease whose heartbeat is older than this belongs to a dead request and may be taken over. */
    leaseStaleSeconds: number;
  };
  worker: {
    pollIntervalMs: number;
    heartbeatSeconds: number;
    /** API readiness and slot reclamation treat a worker process silent this long as dead. */
    workerStaleSeconds: number;
    claimRenewSeconds: number;
    claimStaleSeconds: number;
    maxClaims: number;
    maxConsecutiveRateLimits: number;
    retryAfterDefaultSeconds: number;
    retryAfterMaxSeconds: number;
    maxNotSentAttempts: number;
    notSentBackoffMs: number;
    maxProcessingSeconds: number;
  };
  retention: {
    transcriptTtlSeconds: number;
    tombstoneRetentionSeconds: number;
    retentionLagDegradedSeconds: number;
    sweepIntervalMs: number;
  };
}

const str = (name: string, fallback: string) => process.env[name] ?? fallback;

export function batchConfigFromEnv(): BatchConfig {
  const percent = positiveIntegerEnv("BATCH_DISK_HIGH_WATER_PERCENT", "80");
  if (percent >= 100) throw new Error("BATCH_DISK_HIGH_WATER_PERCENT must be below 100");
  return {
    port: positiveIntegerEnv("PORT", "8080"),
    databaseUrl: str("DATABASE_URL", "postgres://ptx:ptx@localhost:55432/ptx"),
    uploadDir: str("BATCH_UPLOAD_DIR", "/var/lib/ptx-batch/uploads"),
    ffmpegPath: str("FFMPEG_PATH", "ffmpeg"),
    ffprobePath: str("FFPROBE_PATH", "ffprobe"),
    tinfoil: {
      baseUrl: str("BATCH_TINFOIL_BASE_URL", "https://inference.tinfoil.sh"),
      apiKey: str("BATCH_TINFOIL_API_KEY", ""),
      model: str("BATCH_TINFOIL_MODEL", "voxtral-small-24b"),
      timeoutMs: positiveIntegerEnv("BATCH_TINFOIL_TIMEOUT_MS", "180000"),
    },
    limits: {
      maxBytes: MAX_UPLOAD_BYTES,
      maxDurationSeconds: MAX_DURATION_SECONDS,
      maxChannels: MAX_CHANNELS,
      maxActiveJobs: positiveIntegerEnv("BATCH_MAX_ACTIVE_JOBS", "10"),
      maxReservedBytes: positiveIntegerEnv("BATCH_MAX_RESERVED_BYTES", String(10 * MAX_UPLOAD_BYTES)),
      maxConcurrentUploads: positiveIntegerEnv("BATCH_MAX_CONCURRENT_UPLOADS", "3"),
      diskHighWaterPercent: percent,
      tenantDailyBytes: positiveIntegerEnv("BATCH_TENANT_DAILY_BYTES", String(3 * MAX_UPLOAD_BYTES)),
    },
    upload: {
      capabilityTtlSeconds: 3_600,
      maxLiveCapabilities: 5,
      deadlineSeconds: 7_200,
      maxPutSeconds: positiveIntegerEnv("BATCH_UPLOAD_MAX_PUT_SECONDS", "1800"),
      minBytesPerSecond: positiveIntegerEnv("BATCH_UPLOAD_MIN_BYTES_PER_SECOND", "32768"),
      progressGraceSeconds: 60,
      idleTimeoutSeconds: 60,
      leaseHeartbeatSeconds: 10,
      leaseStaleSeconds: 120,
    },
    worker: {
      pollIntervalMs: 1_000,
      heartbeatSeconds: 10,
      workerStaleSeconds: 30,
      claimRenewSeconds: 20,
      claimStaleSeconds: 60,
      maxClaims: 3,
      maxConsecutiveRateLimits: 20,
      retryAfterDefaultSeconds: 30,
      retryAfterMaxSeconds: 120,
      maxNotSentAttempts: 5,
      notSentBackoffMs: 1_000,
      maxProcessingSeconds: 4 * 3_600,
    },
    retention: {
      transcriptTtlSeconds: 86_400,
      tombstoneRetentionSeconds: 7 * 86_400,
      retentionLagDegradedSeconds: 300,
      sweepIntervalMs: 60_000,
    },
  };
}
