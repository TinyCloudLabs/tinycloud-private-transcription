import { config } from "../config.ts";
import { parseBootstrapKeys, syncBootstrapKeys } from "../api/bootstrap-keys.ts";
import { runMigrations } from "../db/migrate.ts";
import { ensureStorageRoot } from "../uploads/storage.ts";
import { createBatchApp, createBatchContext } from "./batch.ts";

/** PTX_ROLE=batch API process. Never builds the meeting context (no Redis, Vexa or Signal). */
if (config.role !== "batch") throw new Error("src/roles/batch-server.ts runs only with PTX_ROLE=batch");
const ctx = createBatchContext();
if (process.env.AUTO_MIGRATE !== "false") await runMigrations(ctx.config.databaseUrl);
if (config.bootstrapKeys !== "") {
  const { upserted, revoked } = await syncBootstrapKeys(ctx, parseBootstrapKeys(config.bootstrapKeys));
  ctx.log.info("bootstrap api keys synced", { upserted, revoked });
}
await ensureStorageRoot(ctx.config.uploadDir);
const app = createBatchApp(ctx);
// Match Bun's body limit to the PTX byte cap; its default 128 MiB is too small for a three-hour upload. Its default
// 10 s idle timeout is raised above the upload's own 60 s idle rule, which then decides (with a stable code).
const server = Bun.serve({ port: ctx.config.port, fetch: app.fetch, idleTimeout: 120, maxRequestBodySize: ctx.config.limits.maxBytes });
ctx.log.info("batch api listening", { port: server.port, role: "batch", providerConfigured: ctx.provider !== null, diarization: ctx.diarizer !== null });
