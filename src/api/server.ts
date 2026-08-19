import { createContext } from "../context.ts";
import { runMigrations } from "../db/migrate.ts";
import { createApp } from "./app.ts";

const ctx = createContext();
if (process.env.AUTO_MIGRATE !== "false") await runMigrations(ctx.config.databaseUrl);
const app = createApp(ctx);
const server = Bun.serve({ port: ctx.config.port, fetch: app.fetch });
ctx.log.info("api listening", { port: server.port, vexa: ctx.config.vexa.baseUrl, provider: ctx.transcription.name });
