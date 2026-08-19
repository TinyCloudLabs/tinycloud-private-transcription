import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createDb } from "./client.ts";
import { config } from "../config.ts";

const migrationsFolder = new URL("./migrations", import.meta.url).pathname;

export async function runMigrations(databaseUrl = config.databaseUrl) {
  const db = createDb(databaseUrl);
  await migrate(db, { migrationsFolder });
  return db;
}

if (import.meta.main) {
  await runMigrations();
  console.log("migrations applied");
  process.exit(0);
}
