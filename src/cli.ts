#!/usr/bin/env bun
import { createApiKey } from "./api/auth.ts";
import { createContext } from "./context.ts";
import { runMigrations } from "./db/migrate.ts";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

switch (cmd) {
  case "create-key": {
    const project = flag("project") ?? "demo";
    await runMigrations();
    const ctx = createContext();
    const { key, webhookSecret } = await createApiKey(ctx, project);
    console.log(`Project:        ${project}`);
    console.log(`API key:        ${key}`);
    console.log(`Webhook secret: ${webhookSecret}`);
    console.log("Store the API key now; it is only shown once (only its sha256 hash is persisted).");
    process.exit(0);
  }
  case "migrate": {
    await runMigrations();
    console.log("migrations applied");
    process.exit(0);
  }
  default:
    console.error("usage: bun run cli <create-key --project <name> | migrate>");
    process.exit(1);
}
