import { SQL } from "bun";
import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createApp } from "../../src/api/app.ts";
import { hashApiKey } from "../../src/api/auth.ts";
import { config } from "../../src/config.ts";
import type { AppContext } from "../../src/context.ts";
import { createDb, type Db } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { silentLogger } from "../../src/log.ts";

const migrationsSource = fileURLToPath(new URL("../../src/db/migrations/", import.meta.url));

async function productionMigrationsFixture(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "ptx-production-migrations-"));
  await mkdir(join(folder, "meta"));
  const journal = JSON.parse(await readFile(join(migrationsSource, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.slice(0, 4);
  await writeFile(join(folder, "meta/_journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
  for (const entry of journal.entries) {
    await copyFile(join(migrationsSource, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  return folder;
}

test("0004-0014 retain production retry, fallback, and terminal delivery state for rollback", async () => {
  const databaseName = `ptx_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(config.databaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const adminUrl = new URL(config.databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new SQL(adminUrl.toString());
  const fixture = await productionMigrationsFixture();
  let db: Db | undefined;

  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const productionDb = createDb(databaseUrl.toString());
    await migrate(productionDb, { migrationsFolder: fixture });

    const apiKey = "tc_live_migration_upgrade_fixture";
    await productionDb.execute(sql`
      INSERT INTO projects (id, name, webhook_secret)
      VALUES ('legacy-project', 'Legacy project', 'whsec_legacy')
    `);
    await productionDb.execute(sql`
      INSERT INTO api_keys (id, project_id, key_hash, scopes)
      VALUES ('key_legacy', 'legacy-project', ${hashApiKey(apiKey)}, ARRAY['meetings:*'])
    `);
    for (const [index, attempt] of [1, 1, 1, 2].entries()) {
      const ordinal = index + 1;
      await productionDb.execute(sql`
        INSERT INTO meetings (
          id, project_id, meeting_url, platform, status, transcription_attempts
        ) VALUES (
          ${`mtg_legacy_${ordinal}`}, 'legacy-project', ${`https://meet.jit.si/Legacy${ordinal}`},
          'jitsi', ${ordinal === 1 ? "completed" : "failed"}, ${attempt}
        )
      `);
    }
    await productionDb.execute(sql`
      INSERT INTO transcripts (
        meeting_id, language, duration_seconds, segments_json, provider, fallback_from, fallback_reason
      ) VALUES (
        'mtg_legacy_1', 'en', 1.5,
        '{"speakers":[],"segments":[],"text":"legacy transcript"}'::jsonb,
        'vexa', 'tinfoil', 'no_usable_recording'
      )
    `);
    await productionDb.$client.close();

    db = await runMigrations(databaseUrl.toString());

    const retryRows = await db.execute(sql`
      SELECT id, transcription_attempts
      FROM meetings
      WHERE id LIKE 'mtg_legacy_%'
      ORDER BY id
    `);
    expect(retryRows).toEqual([
      { id: "mtg_legacy_1", transcription_attempts: 1 },
      { id: "mtg_legacy_2", transcription_attempts: 1 },
      { id: "mtg_legacy_3", transcription_attempts: 1 },
      { id: "mtg_legacy_4", transcription_attempts: 2 },
    ]);
    const [retryAggregate] = await db.execute(sql`
      SELECT
        count(*)::int AS count,
        min(transcription_attempts)::int AS min,
        max(transcription_attempts)::int AS max,
        count(DISTINCT transcription_attempts)::int AS distinct,
        sum(transcription_attempts)::int AS sum
      FROM meetings
      WHERE transcription_attempts > 0
    `);
    expect(retryAggregate).toEqual({ count: 4, min: 1, max: 2, distinct: 2, sum: 5 });

    const [fallback] = await db.execute(sql`
      SELECT fallback_from, fallback_reason
      FROM transcripts
      WHERE meeting_id = 'mtg_legacy_1'
    `);
    expect(fallback).toEqual({
      fallback_from: "tinfoil",
      fallback_reason: "no_usable_recording",
    });

    const columns = await db.execute(sql`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          ('meetings', 'transcription_attempts'),
          ('transcripts', 'fallback_from'),
          ('transcripts', 'fallback_reason')
        )
      ORDER BY table_name, column_name
    `);
    expect(columns).toEqual([
      {
        table_name: "meetings",
        column_name: "transcription_attempts",
        data_type: "integer",
        is_nullable: "NO",
        column_default: "0",
      },
      {
        table_name: "transcripts",
        column_name: "fallback_from",
        data_type: "text",
        is_nullable: "YES",
        column_default: null,
      },
      {
        table_name: "transcripts",
        column_name: "fallback_reason",
        data_type: "text",
        is_nullable: "YES",
        column_default: null,
      },
    ]);

    const [signalColumns] = await db.execute(sql`
      SELECT count(*)::int AS count
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'meetings'
        AND column_name IN ('signal_session_id', 'signal_capability')
    `);
    expect(signalColumns).toEqual({ count: 2 });

    const [migrationCount] = await db.execute(sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`);
    expect(migrationCount).toEqual({ count: 15 });

    const app = createApp({ db, log: silentLogger } as AppContext);
    const response = await app.request("/v1/meetings/mtg_legacy_1", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ id: "mtg_legacy_1", status: "completed", transcript_provider: "vexa" });
    expect(body).not.toHaveProperty("transcription_attempts");
    expect(body).not.toHaveProperty("fallback_from");
    expect(body).not.toHaveProperty("fallback_reason");

    // The previous image can still read and write its legacy fields immediately after rollback.
    await db.execute(sql`
      UPDATE meetings
      SET transcription_attempts = transcription_attempts + 1
      WHERE id = 'mtg_legacy_1'
    `);
    await db.execute(sql`
      UPDATE transcripts
      SET fallback_reason = 'rollback_write_verified'
      WHERE meeting_id = 'mtg_legacy_1'
    `);
    const [rollbackWrite] = await db.execute(sql`
      SELECT m.transcription_attempts, t.fallback_reason
      FROM meetings m
      JOIN transcripts t ON t.meeting_id = m.id
      WHERE m.id = 'mtg_legacy_1'
    `);
    expect(rollbackWrite).toEqual({ transcription_attempts: 2, fallback_reason: "rollback_write_verified" });
  } finally {
    await db?.$client.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.close();
    await rm(fixture, { recursive: true, force: true });
  }
}, 30_000);
