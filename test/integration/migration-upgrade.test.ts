import { SQL } from "bun";
import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { jsonb, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createApp } from "../../src/api/app.ts";
import { hashApiKey } from "../../src/api/auth.ts";
import { config } from "../../src/config.ts";
import type { AppContext } from "../../src/context.ts";
import { createDb, type Db } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { transcriptions } from "../../src/db/schema.ts";
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
    expect(migrationCount).toEqual({ count: 28 });

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

test("0017-0024 migrations are additive: every pre-existing column, row and meeting route is unchanged", async () => {
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
    // A pending attributed batch row from before 0019 must survive the additive column untouched.
    await before.execute(sql`INSERT INTO attributed_batches (id, meeting_id, ordinal, batch_json) VALUES ('mtg_upgrade:batch:0', 'mtg_upgrade', 0, '{"ranges":[]}'::jsonb)`);
    const schemaBefore = await columns(before);
    const rowsBefore = await before.execute(sql`SELECT * FROM meetings`);
    await before.$client.close();

    db = await runMigrations(databaseUrl.toString());
    // 0019 adds attributed_batches.fetch_attempts; additive columns on pre-existing tables are
    // allowed, so compare only the columns that already existed.
    const columnsBefore = new Set((schemaBefore as { table_name: string; column_name: string }[])
      .map((c) => `${c.table_name}.${c.column_name}`));
    const schemaAfter = (await columns(db) as { table_name: string; column_name: string }[])
      .filter((c) => columnsBefore.has(`${c.table_name}.${c.column_name}`));
    expect(schemaAfter).toEqual(schemaBefore as never);
    expect((await columns(db)).some((c) => c.table_name === "transcript_versions")).toBe(true);
    expect(await db.execute(sql`SELECT * FROM meetings`)).toEqual(rowsBefore);
    expect(await db.execute(sql`SELECT id, status, attempts, fetch_attempts FROM attributed_batches`))
      .toEqual([{ id: "mtg_upgrade:batch:0", status: "pending", attempts: 0, fetch_attempts: 0 }]);
    // 0017 and 0018 applied in one run: the singleton is seeded and closed (the meeting role never reads it).
    expect(await db.execute(sql`SELECT id, mode FROM transcription_admission`)).toEqual([{ id: 1, mode: "closed" }]);
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

test("0024 upgrades 0023 data additively and tolerates the old image after rollback", async () => {
  const databaseName = `ptx_versions_${crypto.randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(config.databaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const adminUrl = new URL(config.databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new SQL(adminUrl.toString());
  const fixture = await productionMigrationsFixture(24);
  let db: Db | undefined;
  const oldTranscripts = pgTable("transcripts", {
    meetingId: text("meeting_id").primaryKey(), language: text("language").notNull(),
    durationSeconds: real("duration_seconds").notNull(), segmentsJson: jsonb("segments_json").notNull(),
    provider: text("provider").notNull().default("vexa"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  });
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const before = createDb(databaseUrl.toString());
    await migrate(before, { migrationsFolder: fixture });
    await before.execute(sql`insert into projects (id, name, webhook_secret) values ('upgrade', 'fixture', 'fixture')`);
    await before.execute(sql`insert into meetings (id, project_id, meeting_url, platform, status)
      values ('mtg_v1', 'upgrade', 'https://meet.google.com/rep-ubli-sha', 'google_meet', 'completed'),
      ('mtg_old_insert', 'upgrade', 'https://meet.google.com/rep-ubli-shb', 'google_meet', 'processing')`);
    await before.execute(sql`insert into transcripts (meeting_id, language, duration_seconds, provider, segments_json)
      values ('mtg_v1', 'en', 1, 'tinfoil-attributed', '{"speakers":[],"segments":[],"text":"fixture"}'::jsonb)`);
    await before.execute(sql`insert into attributed_transcription_runs (meeting_id, status, manifest_json, coverage_json)
      values ('mtg_v1', 'completed', '{"ranges":[]}'::jsonb, '{"batches":1}'::jsonb)`);
    await before.execute(sql`insert into attributed_batches (id, meeting_id, ordinal, batch_json, status)
      values ('mtg_v1:batch:0', 'mtg_v1', 0, '{}'::jsonb, 'completed')`);
    await before.execute(sql`insert into attributed_attempts (id, batch_id, ordinal, status)
      values ('attempt_v1', 'mtg_v1:batch:0', 0, 'succeeded')`);
    const legacyRows = await before.select().from(oldTranscripts);
    const legacyFingerprint = await before.execute(sql`select md5(t.segments_json::text) as content_hash,
      md5(r.manifest_json::text) as manifest_hash, md5(r.coverage_json::text) as coverage_hash,
      b.status as batch_status, a.status as attempt_status from transcripts t
      join attributed_transcription_runs r on r.meeting_id = t.meeting_id
      join attributed_batches b on b.meeting_id = t.meeting_id
      join attributed_attempts a on a.batch_id = b.id`);
    await before.$client.close();
    db = await runMigrations(databaseUrl.toString());
    expect(await db.execute(sql`select version, published_at from transcripts`)).toEqual([{ version: 1, published_at: null }]);
    expect(await db.execute(sql`select count(*)::int as count from transcript_versions`)).toEqual([{ count: 0 }]);
    expect(await db.execute(sql`select count(*)::int as count from information_schema.columns
      where table_schema = 'public' and table_name = 'transcript_versions' and column_name = 'meeting_ended_at'`))
      .toEqual([{ count: 1 }]);
    // Named-column reads from the actual pre-0024 schema still work, and retain all content.
    expect(JSON.stringify(await db.select().from(oldTranscripts)) === JSON.stringify(legacyRows)).toBe(true);
    expect(await db.execute(sql`select md5(t.segments_json::text) as content_hash,
      md5(r.manifest_json::text) as manifest_hash, md5(r.coverage_json::text) as coverage_hash,
      b.status as batch_status, a.status as attempt_status from transcripts t
      join attributed_transcription_runs r on r.meeting_id = t.meeting_id
      join attributed_batches b on b.meeting_id = t.meeting_id
      join attributed_attempts a on a.batch_id = b.id`)).toEqual(legacyFingerprint);
    // The old migrator ignores the already-newer journal; it does not undo 0024 or check hashes.
    await migrate(db, { migrationsFolder: fixture });
    await db.insert(oldTranscripts).values({ meetingId: "mtg_old_insert", language: "en", durationSeconds: 0,
      segmentsJson: sql`'{"speakers":[],"segments":[],"text":""}'::jsonb` });
    expect(await db.execute(sql`select version, published_at from transcripts where meeting_id = 'mtg_old_insert'`))
      .toEqual([{ version: 1, published_at: null }]);
    expect(await db.execute(sql`select count(*)::int as count from drizzle.__drizzle_migrations`)).toEqual([{ count: 28 }]);
    // Generated DDL must stay additive: rollback means retaining this schema, never dropping it.
    const migration = await readFile(join(migrationsSource, "0024_transcript_versions.sql"), "utf8");
    expect(/^\s*(drop|truncate|delete)\b/im.test(migration)).toBe(false);
    expect(/\bALTER\s+TABLE\s+"transcripts"\s+ADD\s+COLUMN/i.test(migration)).toBe(true);
  } finally {
    await db?.$client.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.close();
    await rm(fixture, { recursive: true, force: true });
  }
}, 30_000);

test("0025 adds the VAD coverage columns without touching existing jobs, and the old image keeps working after rollback", async () => {
  const databaseName = `ptx_vad_${crypto.randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(config.databaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const adminUrl = new URL(config.databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new SQL(adminUrl.toString());
  const fixture = await productionMigrationsFixture(25);
  let db: Db | undefined;
  // The previous image's named-column insert of a job (no coverage columns).
  const insertJob = (target: Db, id: string) => target.execute(sql`insert into transcriptions (id, project_id, tenant_ref, status,
    idempotency_key, request_hash, content_type, byte_size, sha256, channel_mode, channel_labels, upload_deadline_at, tinfoil_audio_seconds)
    values (${id}, 'upgrade', 'tenant', 'completed', ${id}, 'hash', 'audio/mpeg', 1, 'sha', 'mixed', '[]'::jsonb, now(), 12.5)`);
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const before = createDb(databaseUrl.toString());
    await migrate(before, { migrationsFolder: fixture });
    await before.execute(sql`insert into projects (id, name, webhook_secret) values ('upgrade', 'fixture', 'fixture')`);
    await insertJob(before, "trn_before");
    const [rowBefore] = await before.execute(sql`select to_jsonb(t) as row from transcriptions t`);
    await before.$client.close();

    db = await runMigrations(databaseUrl.toString());
    const [rowAfter] = await db.execute(sql`select to_jsonb(t) - 'vad_dropped_above_floor_pct' - 'vad_fallback' - 'vad_stats' as row,
      vad_dropped_above_floor_pct, vad_fallback from transcriptions t`);
    expect(rowAfter).toEqual({ ...(rowBefore as object), vad_dropped_above_floor_pct: null, vad_fallback: null });
    // The old migrator ignores the newer journal; the old image's insert still works and leaves the columns null.
    await migrate(db, { migrationsFolder: fixture });
    await insertJob(db, "trn_old_image");
    expect(await db.execute(sql`select vad_dropped_above_floor_pct, vad_fallback from transcriptions where id = 'trn_old_image'`))
      .toEqual([{ vad_dropped_above_floor_pct: null, vad_fallback: null }]);
    const migration = await readFile(join(migrationsSource, "0025_vad_coverage.sql"), "utf8");
    expect(/^\s*(drop|truncate|delete|update)\b/im.test(migration)).toBe(false);
    expect(/\b(default|not null)\b/i.test(migration)).toBe(false);
  } finally {
    await db?.$client.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.close();
    await rm(fixture, { recursive: true, force: true });
  }
}, 30_000);

test("0026 persists VAD diagnostics additively; old jobs and old-image inserts remain compatible", async () => {
  const databaseName = `ptx_quiet_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = new URL(config.databaseUrl); url.pathname = `/${databaseName}`;
  const adminUrl = new URL(config.databaseUrl); adminUrl.pathname = "/postgres";
  const admin = new SQL(adminUrl.toString());
  const fixture = await productionMigrationsFixture(26);
  let db: Db | undefined;
  const insertJob = (target: Db, id: string) => target.execute(sql`insert into transcriptions (id, project_id, tenant_ref, status,
    idempotency_key, request_hash, content_type, byte_size, sha256, channel_mode, channel_labels, upload_deadline_at)
    values (${id}, 'upgrade', 'tenant', 'completed', ${id}, 'hash', 'audio/mpeg', 1, 'sha', 'mixed', '[]'::jsonb, now())`);
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const before = createDb(url.toString());
    await migrate(before, { migrationsFolder: fixture });
    await before.execute(sql`insert into projects (id, name, webhook_secret) values ('upgrade', 'fixture', 'fixture')`);
    await insertJob(before, "trn_before");
    const [rowBefore] = await before.execute(sql`select to_jsonb(t) as row from transcriptions t`);
    await before.$client.close();
    db = await runMigrations(url.toString());
    const [rowAfter] = await db.execute(sql`select to_jsonb(t) - 'vad_stats' as row, vad_stats from transcriptions t`);
    expect(rowAfter).toEqual({ ...(rowBefore as object), vad_stats: null });
    const stats = { vad_mode: "quiet" as const, noise_floor_dbfs: -58, median_dbfs: -54, p99_dbfs: -38, speech_peak_s: 8.8, dropped_above_noise_pct: 0 };
    await db.update(transcriptions).set({ vadStats: sql`${JSON.stringify(stats)}::text::jsonb` }).where(eq(transcriptions.id, "trn_before"));
    expect(await db.select({ stats: transcriptions.vadStats }).from(transcriptions).where(eq(transcriptions.id, "trn_before"))).toEqual([{ stats }]);
    expect(await db.execute(sql`select jsonb_typeof(vad_stats) as kind from transcriptions where id = 'trn_before'`)).toEqual([{ kind: "object" }]);
    await migrate(db, { migrationsFolder: fixture });
    await insertJob(db, "trn_old_image");
    expect(await db.execute(sql`select vad_stats from transcriptions where id = 'trn_old_image'`)).toEqual([{ vad_stats: null }]);
    const migration = await readFile(join(migrationsSource, "0026_vad_quiet_stats.sql"), "utf8");
    expect(/^\s*(drop|truncate|delete|update)\b/im.test(migration)).toBe(false);
    expect(/\b(default|not null)\b/i.test(migration)).toBe(false);
  } finally {
    await db?.$client.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.close();
    await rm(fixture, { recursive: true, force: true });
  }
}, 30_000);

test("0018: a fresh install starts with admission closed; an existing deployment keeps its admission mode", async () => {
  const adminUrl = new URL(config.databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new SQL(adminUrl.toString());
  const fresh = `ptx_admission_fresh_${crypto.randomUUID().replaceAll("-", "")}`;
  const existing = `ptx_admission_existing_${crypto.randomUUID().replaceAll("-", "")}`;
  const urlFor = (name: string) => {
    const url = new URL(config.databaseUrl);
    url.pathname = `/${name}`;
    return url.toString();
  };
  // Every migration through 0017: a batch deployment that is already open.
  const fixture = await productionMigrationsFixture(18);
  const dbs: Db[] = [];
  const state = (target: Db) => target.execute(sql`
    SELECT a.mode, c.column_default FROM transcription_admission a, information_schema.columns c
    WHERE c.table_name = 'transcription_admission' AND c.column_name = 'mode'`);
  try {
    await admin.unsafe(`CREATE DATABASE "${fresh}"`);
    await admin.unsafe(`CREATE DATABASE "${existing}"`);

    dbs.push(await runMigrations(urlFor(fresh)));
    expect(await state(dbs[0]!)).toEqual([{ mode: "closed", column_default: "'closed'::text" }]);

    const before = createDb(urlFor(existing));
    await migrate(before, { migrationsFolder: fixture });
    expect(await before.execute(sql`SELECT mode FROM transcription_admission`)).toEqual([{ mode: "open" }]);
    await before.$client.close();
    dbs.push(await runMigrations(urlFor(existing)));
    expect(await state(dbs[1]!)).toEqual([{ mode: "open", column_default: "'closed'::text" }]);
  } finally {
    for (const db of dbs) await db.$client.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${fresh}" WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${existing}" WITH (FORCE)`);
    await admin.close();
    await rm(fixture, { recursive: true, force: true });
  }
}, 30_000);

test("0022: batch jobs queued before diarization existed stay non-diarized", async () => {
  const databaseName = `ptx_diarize_${crypto.randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(config.databaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const adminUrl = new URL(config.databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new SQL(adminUrl.toString());
  // Every migration through 0021: a batch deployment with a job in flight when the diarization image rolls out.
  const fixture = await productionMigrationsFixture(22);
  let db: Db | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const before = createDb(databaseUrl.toString());
    await migrate(before, { migrationsFolder: fixture });
    await before.execute(sql`INSERT INTO projects (id, name, webhook_secret) VALUES ('tinychat', 'tinychat', 'whsec_legacy')`);
    await before.execute(sql`
      INSERT INTO transcriptions (id, project_id, tenant_ref, status, idempotency_key, request_hash, content_type, byte_size,
        sha256, channel_mode, channel_labels, upload_deadline_at)
      VALUES ('trn_legacy', 'tinychat', ${"a".repeat(64)}, 'processing', 'k', 'h', 'audio/mpeg', 10, ${"b".repeat(64)},
        'mixed', '["Speaker 1"]'::jsonb, now())`);
    await before.execute(sql`
      INSERT INTO transcription_regions (transcription_id, ordinal, channel, start_ms, end_ms, status, generation)
      VALUES ('trn_legacy', 0, 0, 0, 1000, 'pending', 1)`);
    await before.$client.close();

    db = await runMigrations(databaseUrl.toString());
    // The worker resumes it on the VAD path and assembles channel_N speakers, exactly as before.
    expect(await db.execute(sql`SELECT id, status, diarize FROM transcriptions`)).toEqual([{ id: "trn_legacy", status: "processing", diarize: false }]);
    expect(await db.execute(sql`SELECT ordinal, status, speaker FROM transcription_regions`)).toEqual([{ ordinal: 0, status: "pending", speaker: null }]);
  } finally {
    await db?.$client.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.close();
    await rm(fixture, { recursive: true, force: true });
  }
}, 30_000);
