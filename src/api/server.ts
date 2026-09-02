import { createContext } from "../context.ts";
import { runMigrations } from "../db/migrate.ts";
import { createApp } from "./app.ts";
import { safeProviderName } from "../log.ts";
import { randomUUID } from "node:crypto";
import { startProductionCapabilityHeartbeat } from "../services/recovery-capability.ts";
import { createProductionRecoveryReadinessSource } from "../services/recovery-readiness.ts";
import { createProductionRecoveryApiRuntime } from "./recovery-runtime.ts";

const ctx = createContext();
if (process.env.AUTO_MIGRATE !== "false") await runMigrations(ctx.config.databaseUrl);
const recoveryReadiness = createProductionRecoveryReadinessSource(ctx.config.recovery, {
  dispatchAdapterReady: () => false,
  providerAdapterReady: () => false,
  recordingAdapterReady: () => false,
  checkpointProtectionReady: () => false,
});
const recoveryApiRuntime = createProductionRecoveryApiRuntime(ctx, recoveryReadiness);
const app = createApp(ctx, { recoveryApiRuntime });
const server = Bun.serve({ port: ctx.config.port, fetch: app.fetch });
const capabilityHeartbeat = startProductionCapabilityHeartbeat({
  db: ctx.db,
  component: "api",
  owner: `api-${process.pid}-${randomUUID()}`,
  environment: process.env,
  recoveryConfiguration: ctx.config.recovery,
  readinessSource: recoveryReadiness,
});
ctx.log.info("api_listening", { port: server.port, provider: safeProviderName(ctx.transcription.name) });

const shutdown = async () => {
  server.stop();
  await capabilityHeartbeat?.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
