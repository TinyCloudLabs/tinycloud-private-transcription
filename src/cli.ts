#!/usr/bin/env bun
import { API_KEY_SCOPES, createApiKey, DEFAULT_KEY_SCOPES, parseScopes } from "./api/auth.ts";
import { createContext } from "./context.ts";
import { runMigrations } from "./db/migrate.ts";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const USAGE = `usage: bun run cli <create-key --project <name> [--scopes <scope>[,<scope>...]] | migrate>
  scopes: ${API_KEY_SCOPES.join(", ")} (default ${DEFAULT_KEY_SCOPES.join(",")}; quote them in the shell, e.g. --scopes 'transcriptions:*')`;
const fail = (message: string): never => {
  console.error(message);
  console.error(USAGE);
  process.exit(1);
};

switch (cmd) {
  case "create-key": {
    const project = flag("project") ?? "demo";
    const scopesArg = flag("scopes");
    if (rest.includes("--scopes") && scopesArg === undefined) fail("--scopes needs a value");
    let scopes = [...DEFAULT_KEY_SCOPES];
    if (scopesArg !== undefined) {
      try {
        scopes = parseScopes(scopesArg.split(",").map((scope) => scope.trim()));
      } catch (err) {
        fail((err as Error).message);
      }
    }
    await runMigrations();
    const ctx = createContext();
    const { key, webhookSecret } = await createApiKey(ctx, project, scopes);
    console.log(`Project:        ${project}`);
    console.log(`Scopes:         ${scopes.join(",")}`);
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
    console.error(USAGE);
    process.exit(1);
}
