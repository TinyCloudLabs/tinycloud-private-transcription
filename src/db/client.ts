import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof createDb>;

export function createDb(databaseUrl: string) {
  const client = new SQL(databaseUrl);
  return drizzle({ client, schema });
}
