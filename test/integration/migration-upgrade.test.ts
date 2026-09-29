import { SQL } from "bun";
import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createApp } from "../../src/api/app.ts";
import { hashApiKey } from "../../src/api/auth.ts";
import { config } from "../../src/config.ts";
import type { AppContext } from "../../src/context.ts";
import { createDb, type Db } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { silentLogger } from "../../src/log.ts";

const migrationsSource = fileURLToPath(new URL("../../src/db/migrations/", import.meta.url));

async function productionMigrationsFixture(migrationCount = 4): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "ptx-production-migrations-"));
  await mkdir(join(folder, "meta"));
  const journal = JSON.parse(await readFile(join(migrationsSource, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.slice(0, migrationCount);
  await writeFile(join(folder, "meta/_journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
  for (const entry of journal.entries) {
    await copyFile(join(migrationsSource, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  return folder;
}

test("0004-0015 retain production retry, fallback, terminal delivery, and deletion state for rollback", async () => {
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
    expect(migrationCount).toEqual({ count: 18 });

    const [deletionAdmission] = await db.execute(sql`
      SELECT count(*)::int AS count
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'meetings'
        AND column_name = 'deletion_provider_admitted_at'
    `);
    expect(deletionAdmission).toEqual({ count: 1 });

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

test("0016 keeps every pre-enforcement key working on meeting routes and grants no other scope", async () => {
  const databaseName = `ptx_scopes_${crypto.randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(config.databaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const adminUrl = new URL(config.databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new SQL(adminUrl.toString());
  // Every migration before 0016_api_key_scopes: the schema the live deployment runs today.
  const fixture = await productionMigrationsFixture(16);
  let db: Db | undefined;
  const cliKey = "tc_live_scope_upgrade_cli_fixture";
  const emptyKey = "tc_live_scope_upgrade_empty_fixture";
  const otherKey = "tc_live_scope_upgrade_other_fixture";
  const nullKey = "tc_live_scope_upgrade_null_fixture";
  const nullMixedKey = "tc_live_scope_upgrade_null_mixed_fixture";

  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const productionDb = createDb(databaseUrl.toString());
    await migrate(productionDb, { migrationsFolder: fixture });
    await productionDb.execute(sql`INSERT INTO projects (id, name, webhook_secret) VALUES ('demo', 'demo', 'whsec_legacy')`);
    // What `create-key` has always written, e.g. the tinychat backend's live key.
    await productionDb.execute(sql`
      INSERT INTO api_keys (id, project_id, key_hash, scopes)
      VALUES ('key_cli', 'demo', ${hashApiKey(cliKey)}, ARRAY['meetings:*'])
    `);
    // A raw insert relying on the column default '{}'.
    await productionDb.execute(sql`INSERT INTO api_keys (id, project_id, key_hash) VALUES ('key_empty', 'demo', ${hashApiKey(emptyKey)})`);
    // A raw insert with some other, never-enforced scope string.
    await productionDb.execute(sql`
      INSERT INTO api_keys (id, project_id, key_hash, scopes)
      VALUES ('key_other', 'demo', ${hashApiKey(otherKey)}, ARRAY['meetings'])
    `);
    // Arrays holding NULL elements, where `'meetings:*' = ANY(scopes)` is NULL rather than false.
    await productionDb.execute(sql`
      INSERT INTO api_keys (id, project_id, key_hash, scopes)
      VALUES ('key_null', 'demo', ${hashApiKey(nullKey)}, ARRAY[NULL]::text[]),
             ('key_null_mixed', 'demo', ${hashApiKey(nullMixedKey)}, ARRAY[NULL, 'meetings']::text[])
    `);
    await productionDb.$client.close();

    db = await runMigrations(databaseUrl.toString());

    const rows = await db.execute(sql`SELECT id, scopes, bootstrap_managed FROM api_keys ORDER BY id`);
    expect(rows).toEqual([
      { id: "key_cli", scopes: ["meetings:*"], bootstrap_managed: false },
      { id: "key_empty", scopes: ["meetings:*"], bootstrap_managed: false },
      { id: "key_null", scopes: [null, "meetings:*"], bootstrap_managed: false },
      { id: "key_null_mixed", scopes: [null, "meetings", "meetings:*"], bootstrap_managed: false },
      { id: "key_other", scopes: ["meetings", "meetings:*"], bootstrap_managed: false },
    ]);

    const app = createApp({ db, log: silentLogger } as AppContext);
    const get = (key: string) => app.request("/v1/meetings/mtg_missing", { headers: { Authorization: `Bearer ${key}` } });
    // 404 meeting_not_found = authenticated, authorized, and answered by the handler, as before.
    expect((await get(cliKey)).status).toBe(404);
    expect((await get(emptyKey)).status).toBe(404);
    expect((await get(otherKey)).status).toBe(404);
    expect((await get(nullKey)).status).toBe(404);
    expect((await get(nullMixedKey)).status).toBe(404);
    // A key created after 0016 without meetings:* is not grandfathered.
    const newKey = "tc_live_scope_upgrade_new_fixture";
    await db.execute(sql`
      INSERT INTO api_keys (id, project_id, key_hash, scopes)
      VALUES ('key_new', 'demo', ${hashApiKey(newKey)}, ARRAY['transcriptions:*'])
    `);
    expect((await get(newKey)).status).toBe(403);

    // Rollback: the pre-enforcement image, whose schema is exactly this table (no bootstrap_managed) and
    // which never checks scopes, keeps minting and authenticating keys against the migrated schema.
    const preEnforcementApiKeys = pgTable("api_keys", {
      id: text("id").primaryKey(),
      projectId: text("project_id").notNull(),
      keyHash: text("key_hash").notNull().unique(),
      scopes: text("scopes").array().notNull().default([]),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    });
    const rollbackKey = "tc_live_scope_upgrade_rollback_fixture";
    await db.insert(preEnforcementApiKeys).values({ id: "key_rollback", projectId: "demo", keyHash: hashApiKey(rollbackKey), scopes: ["meetings:*"] });
    const lookup = (key: string) =>
      db!
        .select({ projectId: preEnforcementApiKeys.projectId, scopes: preEnforcementApiKeys.scopes })
        .from(preEnforcementApiKeys)
        .where(eq(preEnforcementApiKeys.keyHash, hashApiKey(key)))
        .limit(1);
    expect(await lookup(rollbackKey)).toEqual([{ projectId: "demo", scopes: ["meetings:*"] }]);
    expect(await lookup(cliKey)).toEqual([{ projectId: "demo", scopes: ["meetings:*"] }]);
    // A key the old image minted is an ordinary key when rolling forward again.
    const [rolledBack] = await db.execute(sql`SELECT bootstrap_managed FROM api_keys WHERE id = 'key_rollback'`);
    expect(rolledBack).toEqual({ bootstrap_managed: false });
    expect((await get(rollbackKey)).status).toBe(404);
  } finally {
    await db?.$client.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.close();
    await rm(fixture, { recursive: true, force: true });
  }
}, 30_000);

test("0017 (batch transcription) is additive: every pre-existing table, row and meeting route is unchanged", async () => {
  const databaseName = `ptx_batch_${crypto.randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(config.databaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const adminUrl = new URL(config.databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new SQL(adminUrl.toString());
  // Every migration through 0016: the schema the meeting service runs once P1 ships.
  const fixture = await productionMigrationsFixture(17);
  let db: Db | undefined;
  const key = "tc_live_batch_upgrade_fixture";
  const columns = (target: Db) => target.execute(sql`
    SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`);
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const before = createDb(databaseUrl.toString());
    await migrate(before, { migrationsFolder: fixture });
    await before.execute(sql`INSERT INTO projects (id, name, webhook_secret) VALUES ('demo', 'demo', 'whsec_legacy')`);
    await before.execute(sql`INSERT INTO api_keys (id, project_id, key_hash, scopes) VALUES ('key_cli', 'demo', ${hashApiKey(key)}, ARRAY['meetings:*'])`);
    await before.execute(sql`INSERT INTO meetings (id, project_id, meeting_url, platform, status) VALUES ('mtg_upgrade', 'demo', 'https://meet.jit.si/x', 'jitsi', 'processing')`);
    const schemaBefore = await columns(before);
    const rowsBefore = await before.execute(sql`SELECT * FROM meetings`);
    await before.$client.close();

    db = await runMigrations(databaseUrl.toString());
    const tablesBefore = new Set((schemaBefore as { table_name: string }[]).map((c) => c.table_name));
    const schemaAfter = (await columns(db) as { table_name: string }[]).filter((c) => tablesBefore.has(c.table_name));
    expect(schemaAfter).toEqual(schemaBefore as never);
    expect(await db.execute(sql`SELECT * FROM meetings`)).toEqual(rowsBefore);
    expect(await db.execute(sql`SELECT id, mode FROM transcription_admission`)).toEqual([{ id: 1, mode: "open" }]);
    expect(await db.execute(sql`SELECT id, attempt_id FROM provider_dispatch_slots`)).toEqual([{ id: 1, attempt_id: null }]);

    const app = createApp({ db, log: silentLogger } as AppContext);
    const res = await app.request("/v1/meetings/mtg_upgrade_missing", { headers: { Authorization: `Bearer ${key}` } });
    expect(res.status).toBe(404);
    // The meeting role never mounts the batch API.
    expect((await app.request("/v1/transcriptions", { headers: { Authorization: `Bearer ${key}` } })).status).toBe(404);
  } finally {
    await db?.$client.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.close();
    await rm(fixture, { recursive: true, force: true });
  }
}, 30_000);
