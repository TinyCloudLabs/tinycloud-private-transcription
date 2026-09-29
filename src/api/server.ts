import { createContext } from "../context.ts";
import { runMigrations } from "../db/migrate.ts";
import { createApp } from "./app.ts";
import { parseBootstrapKeys, syncBootstrapKeys } from "./bootstrap-keys.ts";

const ctx = createContext();
if (process.env.AUTO_MIGRATE !== "false") await runMigrations(ctx.config.databaseUrl);
if (ctx.config.bootstrapKeys !== "") {
  const { upserted, revoked } = await syncBootstrapKeys(ctx, parseBootstrapKeys(ctx.config.bootstrapKeys));
  ctx.log.info("bootstrap api keys synced", { upserted, revoked });
}
const app = createApp(ctx);
const server = Bun.serve({ port: ctx.config.port, fetch: app.fetch });
ctx.log.info("api listening", { port: server.port, vexa: ctx.config.vexa.baseUrl, provider: ctx.transcription.name });
