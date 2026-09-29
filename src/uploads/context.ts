import type { Db } from "../db/client.ts";
import type { Logger } from "../log.ts";
import type { BatchConfig } from "./config.ts";
import type { Faults } from "./faults.ts";
import type { BatchTinfoilClient } from "./provider.ts";

/** Everything the batch role needs. Deliberately has no Redis, Vexa, Signal or meeting provider. */
export interface BatchContext {
  config: BatchConfig;
  db: Db;
  log: Logger;
  /** Null when BATCH_TINFOIL_API_KEY is unset: the service then refuses new work with service_unavailable. */
  provider: BatchTinfoilClient | null;
  faults: Faults;
  /** Durable identity of this process in transcription_workers / provider_dispatch_slots. */
  workerId: string;
}
