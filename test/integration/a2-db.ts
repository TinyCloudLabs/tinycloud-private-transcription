import { SQL } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { config } from "../../src/config.ts";

const MIGRATIONS = [
  "0000_init.sql",
  "0001_transcript_provider.sql",
  "0002_transcript_fallback.sql",
] as const;

export interface IsolatedDatabase {
  name: string;
  url: string;
  sql: SQL;
  drop(): Promise<void>;
}

function databaseUrl(name: string): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

export async function createIsolatedDatabase(prefix: string): Promise<IsolatedDatabase> {
  const name = `${prefix}_${randomBytes(8).toString("hex")}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("unsafe synthetic database name");

  const admin = new SQL(databaseUrl("postgres"));
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.close();

  const url = databaseUrl(name);
  const client = new SQL(url);
  return {
    name,
    url,
    sql: client,
    async drop() {
      await client.close();
      const cleanup = new SQL(databaseUrl("postgres"));
      await cleanup.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await cleanup.close();
    },
  };
}

async function executeMigrationFile(client: SQL, filename: string): Promise<string> {
  const fileUrl = new URL(`../../src/db/migrations/${filename}`, import.meta.url);
  const contents = await Bun.file(fileUrl).text();
  for (const statement of contents.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
  return createHash("sha256").update(contents).digest("hex");
}

/** Install the repository's exact 0002 SQL state and the matching Drizzle journal position. */
export async function installExact0002(client: SQL): Promise<void> {
  const hashes: string[] = [];
  for (const migration of MIGRATIONS) hashes.push(await executeMigrationFile(client, migration));
  await client`create schema if not exists drizzle`;
  await client`
    create table if not exists drizzle.__drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `;
  await client`
    insert into drizzle.__drizzle_migrations (hash, created_at)
    values (${hashes[2]!}, ${1787135985152})
  `;
}
