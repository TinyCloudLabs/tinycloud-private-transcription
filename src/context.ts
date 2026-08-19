import { RedisClient } from "bun";
import { config as defaultConfig, type Config } from "./config.ts";
import { createDb, type Db } from "./db/client.ts";
import { VexaClient } from "./providers/vexa/client.ts";
import { createTranscriptionProvider, type TranscriptionProvider } from "./providers/transcription/index.ts";
import { Queue } from "./worker/queue.ts";
import { logger, type Logger } from "./log.ts";

export interface AppContext {
  config: Config;
  db: Db;
  redis: RedisClient;
  queue: Queue;
  vexa: VexaClient;
  transcription: TranscriptionProvider;
  log: Logger;
  /** Webhook retry schedule (ms after previous attempt). Overridable for tests. */
  webhookRetryDelaysMs: number[];
}

export const DEFAULT_WEBHOOK_RETRY_DELAYS_MS = [0, 60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

export function createContext(overrides: Partial<AppContext> & { config?: Config } = {}): AppContext {
  const cfg = overrides.config ?? defaultConfig;
  const redis = overrides.redis ?? new RedisClient(cfg.redisUrl);
  const log = overrides.log ?? logger;
  return {
    config: cfg,
    db: overrides.db ?? createDb(cfg.databaseUrl),
    redis,
    queue: overrides.queue ?? new Queue(redis),
    vexa: overrides.vexa ?? new VexaClient({ baseUrl: cfg.vexa.baseUrl, apiKey: cfg.vexa.apiKey }),
    transcription: overrides.transcription ?? createTranscriptionProvider(cfg, log),
    log,
    webhookRetryDelaysMs: overrides.webhookRetryDelaysMs ?? DEFAULT_WEBHOOK_RETRY_DELAYS_MS,
  };
}
