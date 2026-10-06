import { randomUUID } from "node:crypto";
import { createDb } from "../db/client.ts";
import { logger } from "../log.ts";
import { batchConfigFromEnv, type BatchConfig } from "../uploads/config.ts";
import type { BatchContext } from "../uploads/context.ts";
import { diarizerFromConfig } from "../uploads/diarize.ts";
import { faultsFromEnv } from "../uploads/faults.ts";
import { BatchTinfoilClient } from "../uploads/provider.ts";
import { createBatchRoutes } from "../uploads/routes.ts";

export type { BatchContext } from "../uploads/context.ts";

/**
 * PTX_ROLE=batch: the dedicated batch-transcription service. It builds no Redis client, Vexa client,
 * Signal adapter or meeting provider, and reads only BATCH_* provider configuration.
 */
export function createBatchContext(overrides: Partial<BatchContext> & { config?: BatchConfig } = {}): BatchContext {
  const config = overrides.config ?? batchConfigFromEnv();
  return {
    config,
    db: overrides.db ?? createDb(config.databaseUrl),
    log: overrides.log ?? logger,
    provider: overrides.provider !== undefined ? overrides.provider : config.tinfoil.apiKey ? new BatchTinfoilClient(config.tinfoil) : null,
    diarizer: overrides.diarizer !== undefined ? overrides.diarizer : diarizerFromConfig(config.diarization),
    faults: overrides.faults ?? faultsFromEnv(),
    workerId: overrides.workerId ?? `batch-worker:${process.pid}:${randomUUID()}`,
  };
}

/** Health, /v1/transcriptions* (transcriptions:*), /v1/admin/* (admin:*) and PUT /uploads/{id} (capability). */
export function createBatchApp(ctx: BatchContext) {
  return createBatchRoutes(ctx);
}
