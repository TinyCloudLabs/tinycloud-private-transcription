import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { runMigrations } from "../../src/db/migrate.ts";
import {
  meetings,
  outboxJobs,
  projectRecoveryBuckets,
  projectRecoveryGuards,
  providerCallLedger,
  recoveryOperations,
  serviceCapabilityLeases,
  transcriptionChunks,
} from "../../src/db/schema.ts";
import { createIsolatedDatabase, installExact0002, type IsolatedDatabase } from "./a2-db.ts";
import {
  PROVIDER_V2_MAX_SOURCE_SAMPLE_RATE_HZ,
  reconstructProviderV2SampleRange,
} from "../../src/providers/transcription/provider-v2-planner.ts";

const PROJECT_ID = "prj_a2_schema_opaque";
const LEGACY_MEETING_ID = "mtg_01J00000000000000000000000";
const FRESH_MEETING_ID = "mtg_01J00000000000000000000001";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

const words = (value: string): string[] => value ? value.split(" ") : [];

const A2_MANIFEST = {
  meetings: {
    columns: words("budget_provenance manual_recovery_cycles_consumed automatic_recovery_cycles_consumed operator_recovery_cycles_consumed consecutive_recoverable_failures next_recovery_eligible_at active_recovery_operation_id last_recovery_outcome recovery_phase transcript_revision recovery_capability_version deleted_at deletion_fence deletion_saga_state deletion_provider_platform deletion_provider_native_meeting_id"),
    indexes: [],
    foreignKeys: words("meetings_active_recovery_operation_id_recovery_operations_id_fk"),
    checks: words("meetings_budget_provenance_check meetings_recovery_counters_check meetings_last_recovery_outcome_check meetings_recovery_phase_check meetings_create_idempotency_key_check meetings_deletion_fence_check"),
  },
  recovery_operations: {
    columns: words("id project_id meeting_id idempotency_key_hash kind state phase eligibility_code ordinal planned_audio_ms submitted_audio_ms source_sample_rate_hz source_sample_count reserved_calls spent_calls reserved_cost_microunits spent_cost_microunits cooldown_snapshot_at deadline_at delayed_at worker_lease_owner_hash worker_lease_expires_at worker_lease_fence failure_code correlation_id actor_class reason_code accepted_at started_at completed_at created_at updated_at"),
    indexes: words("recovery_operations_project_meeting_key_idx recovery_operations_one_active_meeting_idx recovery_operations_project_state_idx"),
    foreignKeys: words("recovery_operations_project_id_projects_id_fk recovery_operations_meeting_id_meetings_id_fk"),
    checks: words("recovery_operations_key_hash_check recovery_operations_kind_check recovery_operations_state_check recovery_operations_phase_check recovery_operations_eligibility_code_check recovery_operations_failure_code_check recovery_operations_actor_class_check recovery_operations_reason_code_check recovery_operations_correlation_id_check recovery_operations_counters_check recovery_operations_source_samples_check"),
  },
  transcription_chunks: {
    columns: words("id operation_id ordinal version start_ms end_ms speaker_ref_hash provenance state attempt retry_count next_eligible_at split_parent_id provider_call_ledger_id checkpoint_ciphertext checkpoint_nonce checkpoint_key_version checkpoint_content_hash lease_owner_hash lease_expires_at lease_fence created_at updated_at"),
    indexes: words("transcription_chunks_operation_ordinal_version_idx transcription_chunks_operation_state_idx"),
    foreignKeys: words("transcription_chunks_operation_id_recovery_operations_id_fk transcription_chunks_split_parent_id_transcription_chunks_id_fk transcription_chunks_ledger_id_fk"),
    checks: words("transcription_chunks_bounds_check transcription_chunks_provenance_check transcription_chunks_state_check transcription_chunks_checkpoint_shape_check"),
  },
  provider_call_ledger: {
    columns: words("id project_id operation_id chunk_id reservation_key_hash kind submitted_audio_ms submitted_bytes reserved_cost_microunits spent_cost_microunits attempt dispatch_state outcome_code status_class lease_fence budget_bucket_minute reserved_at dispatching_at completed_at created_at updated_at"),
    indexes: words("provider_call_ledger_operation_chunk_attempt_idx provider_call_ledger_project_reservation_idx provider_call_ledger_operation_state_idx"),
    foreignKeys: words("provider_call_ledger_project_id_projects_id_fk provider_call_ledger_operation_id_recovery_operations_id_fk provider_call_ledger_chunk_id_transcription_chunks_id_fk"),
    checks: words("provider_call_ledger_reservation_hash_check provider_call_ledger_kind_check provider_call_ledger_dispatch_state_check provider_call_ledger_outcome_code_check provider_call_ledger_status_class_check provider_call_ledger_counters_check"),
  },
  project_recovery_guards: {
    columns: words("project_id lock_version created_at updated_at"),
    indexes: [],
    foreignKeys: words("project_recovery_guards_project_id_projects_id_fk"),
    checks: words("project_recovery_guards_lock_version_check"),
  },
  project_recovery_buckets: {
    columns: words("project_id bucket_minute initial_cycles manual_cycles automatic_cycles operator_cycles reserved_calls spent_calls reserved_audio_ms spent_audio_ms reserved_cost_microunits spent_cost_microunits created_at updated_at"),
    indexes: [],
    foreignKeys: words("project_recovery_buckets_project_id_projects_id_fk"),
    checks: words("project_recovery_buckets_minute_check project_recovery_buckets_counters_check"),
  },
  outbox_jobs: {
    columns: words("id project_id operation_id chunk_id event_type dedupe_key_hash state available_at lease_owner_hash lease_expires_at lease_fence attempt last_error_code created_at updated_at"),
    indexes: words("outbox_jobs_project_dedupe_idx outbox_jobs_delivery_idx"),
    foreignKeys: words("outbox_jobs_project_id_projects_id_fk outbox_jobs_operation_id_recovery_operations_id_fk outbox_jobs_chunk_id_transcription_chunks_id_fk"),
    checks: words("outbox_jobs_dedupe_hash_check outbox_jobs_event_type_check outbox_jobs_state_check outbox_jobs_last_error_code_check outbox_jobs_counters_check"),
  },
  service_capability_leases: {
    columns: words("component lease_owner_hash build_revision contract_version finalizer_version schema_version config_version lease_expires_at heartbeat_at lease_fence created_at updated_at"),
    indexes: [],
    foreignKeys: [],
    checks: words("service_capability_leases_component_check service_capability_leases_bounded_fields_check"),
  },
} as const;

type A2TableName = keyof typeof A2_MANIFEST;
type A2TableManifest = {
  columns: readonly string[];
  indexes: readonly string[];
  foreignKeys: readonly string[];
  checks: readonly string[];
};

const A2_DRIZZLE_TABLES: Record<A2TableName, PgTable> = {
  meetings,
  recovery_operations: recoveryOperations,
  transcription_chunks: transcriptionChunks,
  provider_call_ledger: providerCallLedger,
  project_recovery_guards: projectRecoveryGuards,
  project_recovery_buckets: projectRecoveryBuckets,
  outbox_jobs: outboxJobs,
  service_capability_leases: serviceCapabilityLeases,
};

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function scopedValues(table: string, values: string[], expected: readonly string[]): string[] {
  return table === "meetings" ? values.filter((name) => expected.includes(name)) : values;
}

function normalizeManifest(manifest: Record<string, A2TableManifest>): Record<string, A2TableManifest> {
  return Object.fromEntries(Object.entries(manifest).map(([table, definition]) => [table, {
    columns: sorted(definition.columns),
    indexes: sorted(definition.indexes),
    foreignKeys: sorted(definition.foreignKeys),
    checks: sorted(definition.checks),
  }]));
}

function drizzleManifest(): Record<string, A2TableManifest> {
  return Object.fromEntries(Object.entries(A2_DRIZZLE_TABLES).map(([table, declaration]) => {
    const expected = A2_MANIFEST[table as A2TableName];
    const config = getTableConfig(declaration);
    return [table, {
      columns: scopedValues(table, config.columns.map((column) => column.name), expected.columns),
      indexes: scopedValues(table, config.indexes
        .map((index) => index.config.name)
        .filter((name): name is string => typeof name === "string"), expected.indexes),
      foreignKeys: scopedValues(table, config.foreignKeys.map((foreignKey) => foreignKey.getName()), expected.foreignKeys),
      checks: scopedValues(table, config.checks.map((constraint) => constraint.name), expected.checks),
    }];
  }));
}

function snapshotManifest(snapshot: any): Record<string, A2TableManifest> {
  return Object.fromEntries(Object.entries(A2_MANIFEST).map(([table, expected]) => {
    const declaration = snapshot.tables[`public.${table}`];
    return [table, {
      columns: scopedValues(table, Object.keys(declaration.columns), expected.columns),
      indexes: scopedValues(table, Object.keys(declaration.indexes), expected.indexes),
      foreignKeys: scopedValues(table, Object.keys(declaration.foreignKeys), expected.foreignKeys),
      checks: scopedValues(table, Object.keys(declaration.checkConstraints), expected.checks),
    }];
  }));
}

function sqlManifest(migration: string): Record<string, A2TableManifest> {
  const meetingColumns = [...migration.matchAll(/ALTER TABLE "meetings" ADD COLUMN "([^"]+)"/g)].map((match) => match[1]!);
  return Object.fromEntries(Object.entries(A2_MANIFEST).map(([table, expected]) => {
    const createBody = table === "meetings"
      ? ""
      : migration.match(new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);--> statement-breakpoint`))?.[1] ?? "";
    const columns = table === "meetings"
      ? meetingColumns
      : [...createBody.matchAll(/^  "([^"]+)" /gm)].map((match) => match[1]!);
    const indexes = [...migration.matchAll(new RegExp(`CREATE (?:UNIQUE )?INDEX "([^"]+)" ON "${table}"`, "g"))]
      .map((match) => match[1]!);
    const foreignKeys = [...migration.matchAll(new RegExp(`ALTER TABLE "${table}" ADD CONSTRAINT "([^"]+)" FOREIGN KEY`, "g"))]
      .map((match) => match[1]!);
    const checkSource = table === "meetings"
      ? [...migration.matchAll(/ALTER TABLE "meetings" ADD CONSTRAINT "([^"]+)" CHECK/g)].map((match) => match[1]!)
      : [...createBody.matchAll(/CONSTRAINT "([^"]+)" CHECK/g)].map((match) => match[1]!);
    return [table, {
      columns: scopedValues(table, columns, expected.columns),
      indexes: scopedValues(table, indexes, expected.indexes),
      foreignKeys: scopedValues(table, foreignKeys, expected.foreignKeys),
      checks: scopedValues(table, checkSource, expected.checks),
    }];
  }));
}

async function liveManifest(database: IsolatedDatabase): Promise<Record<string, A2TableManifest>> {
  const manifest: Record<string, A2TableManifest> = {};
  for (const [table, expected] of Object.entries(A2_MANIFEST)) {
    const columns = await database.sql<{ name: string }[]>`
      select column_name as name from information_schema.columns
      where table_schema = 'public' and table_name = ${table}
      order by ordinal_position
    `;
    const indexes = await database.sql<{ name: string }[]>`
      select indexname as name from pg_indexes
      where schemaname = 'public' and tablename = ${table}
        and indexname <> ${`${table}_pkey`} and indexname <> ${"project_recovery_buckets_pk"}
      order by indexname
    `;
    const constraints = await database.sql<{ name: string; type: string }[]>`
      select con.conname as name, con.contype as type
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      where nsp.nspname = 'public' and rel.relname = ${table} and con.contype in ('f', 'c')
      order by con.conname
    `;
    manifest[table] = {
      columns: scopedValues(table, columns.map((row) => row.name), expected.columns),
      indexes: scopedValues(table, indexes.map((row) => row.name), expected.indexes),
      foreignKeys: scopedValues(table, constraints.filter((row) => row.type === "f").map((row) => row.name), expected.foreignKeys),
      checks: scopedValues(table, constraints.filter((row) => row.type === "c").map((row) => row.name), expected.checks),
    };
  }
  return manifest;
}

let fresh: IsolatedDatabase;
let upgraded: IsolatedDatabase;

setDefaultTimeout(30_000);

async function expectDatabaseRejects(query: Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await query;
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
}

async function a2SchemaInventory(database: IsolatedDatabase): Promise<string[]> {
  const rows = await database.sql<{ definition: string }[]>`
    select concat('constraint:', c.relname, ':', con.conname, ':', pg_get_constraintdef(con.oid)) as definition
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and (c.relname in (
        'recovery_operations', 'transcription_chunks', 'provider_call_ledger',
        'project_recovery_guards', 'project_recovery_buckets', 'outbox_jobs',
        'service_capability_leases'
      ) or con.conname like 'meetings_recovery_%' or con.conname like 'meetings_budget_%'
          or con.conname like 'meetings_last_recovery_%'
          or con.conname = 'meetings_active_recovery_operation_id_recovery_operations_id_fk')
    union all
    select concat('index:', tablename, ':', indexname, ':', indexdef) as definition
    from pg_indexes
    where schemaname = 'public'
      and tablename in (
        'recovery_operations', 'transcription_chunks', 'provider_call_ledger',
        'project_recovery_guards', 'project_recovery_buckets', 'outbox_jobs',
        'service_capability_leases'
      )
    order by definition
  `;
  return rows.map((row) => row.definition);
}

beforeAll(async () => {
  fresh = await createIsolatedDatabase("ptx_a2_fresh");
  const freshMigrationDb = await runMigrations(fresh.url);
  await freshMigrationDb.$client.close();

  upgraded = await createIsolatedDatabase("ptx_a2_upgrade");
  await installExact0002(upgraded.sql);
  await upgraded.sql`
    insert into projects (id, name, webhook_secret)
    values (${PROJECT_ID}, ${"synthetic-project"}, ${"whsec_synthetic_opaque"})
  `;
  await upgraded.sql`
    insert into meetings (
      id, project_id, meeting_url, platform, status, metadata, transcription_attempts
    ) values (
      ${LEGACY_MEETING_ID}, ${PROJECT_ID}, ${"https://synthetic.invalid/opaque"},
      ${"jitsi"}, ${"failed"}, ${{ fixture: "opaque" }}, ${7}
    )
  `;
  const upgradeMigrationDb = await runMigrations(upgraded.url);
  await upgradeMigrationDb.$client.close();
}, 30_000);

afterAll(async () => {
  await fresh?.drop();
  await upgraded?.drop();
}, 30_000);

describe("A2 migration", () => {
  test("fresh database migrates through 0003 with every additive table", async () => {
    const tables = await fresh.sql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
      order by table_name
    `;
    expect(tables.map((row) => row.table_name)).toEqual(expect.arrayContaining([
      "outbox_jobs",
      "project_recovery_buckets",
      "project_recovery_guards",
      "provider_call_ledger",
      "recovery_operations",
      "service_capability_leases",
      "transcription_chunks",
    ]));

    const [journal] = await fresh.sql<{ created_at: bigint }[]>`
      select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1
    `;
    expect(Number(journal!.created_at)).toBeGreaterThan(1787135985152);
  });

  test("exact 0002 upgrade preserves old columns and marks the legacy meeting ineligible", async () => {
    const [row] = await upgraded.sql<{
      meeting_url: string;
      status: string;
      transcription_attempts: number;
      budget_provenance: string;
      manual_recovery_cycles_consumed: number;
      automatic_recovery_cycles_consumed: number;
      manual_budget_eligible: boolean;
      automatic_budget_eligible: boolean;
    }[]>`
      select meeting_url, status, transcription_attempts, budget_provenance,
             manual_recovery_cycles_consumed, automatic_recovery_cycles_consumed,
             budget_provenance = 'tracked' as manual_budget_eligible,
             budget_provenance = 'tracked' as automatic_budget_eligible
      from meetings where id = ${LEGACY_MEETING_ID}
    `;
    expect(row).toMatchObject({
      meeting_url: "https://synthetic.invalid/opaque",
      status: "failed",
      transcription_attempts: 7,
      budget_provenance: "legacy_unknown",
      manual_recovery_cycles_consumed: 0,
      automatic_recovery_cycles_consumed: 0,
      manual_budget_eligible: false,
      automatic_budget_eligible: false,
    });

    const oldColumns = await upgraded.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'meetings'
        and column_name in (
          'id', 'project_id', 'meeting_url', 'platform', 'status', 'bot_name', 'language',
          'webhook_url', 'vexa_platform', 'vexa_native_meeting_id', 'vexa_bot_id', 'created_at',
          'started_at', 'ended_at', 'completed_at', 'metadata', 'error_code', 'error_message',
          'idempotency_key', 'request_hash', 'transcription_attempts'
        )
      order by column_name
    `;
    expect(oldColumns).toHaveLength(21);
  });

  test("fresh and exact-0002 upgrade paths have identical A2 constraints and indexes", async () => {
    expect(await a2SchemaInventory(fresh)).toEqual(await a2SchemaInventory(upgraded));
  });

  test("live, Drizzle, snapshot, journal, and SQL independently match the A2 manifest", async () => {
    const snapshot = await Bun.file(new URL("../../src/db/migrations/meta/0003_snapshot.json", import.meta.url)).json();
    const previousSnapshot = await Bun.file(new URL("../../src/db/migrations/meta/0002_snapshot.json", import.meta.url)).json();
    const journal = await Bun.file(new URL("../../src/db/migrations/meta/_journal.json", import.meta.url)).json();
    const migration = await Bun.file(new URL("../../src/db/migrations/0003_recovery_v2_schema.sql", import.meta.url)).text();
    const intended = normalizeManifest(A2_MANIFEST);

    expect([...migration.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]).sort()).toEqual(
      Object.keys(A2_MANIFEST).filter((table) => table !== "meetings").sort(),
    );
    expect(Object.keys(snapshot.tables).filter((table) => !(table in previousSnapshot.tables)).sort()).toEqual(
      Object.keys(A2_MANIFEST).filter((table) => table !== "meetings").map((table) => `public.${table}`).sort(),
    );
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 3,
      version: "7",
      tag: "0003_recovery_v2_schema",
      breakpoints: true,
    });
    expect(snapshot.version).toBe("7");
    expect(snapshot.prevId).toBe("3a178a9e-20d1-43a7-9dc0-f605fb8e6fe0");
    expect(normalizeManifest(await liveManifest(fresh))).toEqual(intended);
    expect(normalizeManifest(drizzleManifest())).toEqual(intended);
    expect(normalizeManifest(snapshotManifest(snapshot))).toEqual(intended);
    expect(normalizeManifest(sqlManifest(migration))).toEqual(intended);
  }, 30_000);

  test("meetings created after 0003 are tracked with zero counters and all additive fields", async () => {
    await fresh.sql`
      insert into projects (id, name, webhook_secret)
      values (${PROJECT_ID}, ${"synthetic-project"}, ${"whsec_synthetic_opaque"})
    `;
    const [row] = await fresh.sql<Record<string, unknown>[]>`
      insert into meetings (id, project_id, meeting_url, platform, status)
      values (${FRESH_MEETING_ID}, ${PROJECT_ID}, ${"https://synthetic.invalid/fresh"}, ${"jitsi"}, ${"queued"})
      returning budget_provenance, manual_recovery_cycles_consumed,
                automatic_recovery_cycles_consumed, operator_recovery_cycles_consumed,
                consecutive_recoverable_failures, next_recovery_eligible_at,
                active_recovery_operation_id, last_recovery_outcome, recovery_phase,
                transcript_revision, recovery_capability_version
    `;
    expect(row).toEqual({
      budget_provenance: "tracked",
      manual_recovery_cycles_consumed: 0,
      automatic_recovery_cycles_consumed: 0,
      operator_recovery_cycles_consumed: 0,
      consecutive_recoverable_failures: 0,
      next_recovery_eligible_at: null,
      active_recovery_operation_id: null,
      last_recovery_outcome: null,
      recovery_phase: null,
      transcript_revision: 0,
      recovery_capability_version: null,
    });
  });

  test("create idempotency keys are bounded by the database as well as the route", async () => {
    for (const [suffix, key] of [["empty", ""], ["long", "x".repeat(129)], ["unicode", "café"]] as const) {
      await expectDatabaseRejects(fresh.sql`
        insert into meetings (id, project_id, meeting_url, platform, status, idempotency_key)
        values (${`mtg_create_key_${suffix}`}, ${PROJECT_ID}, ${"https://synthetic.invalid/key"}, ${"jitsi"}, ${"queued"}, ${key})
      `);
    }
  });

  test("operation idempotency and one-active-operation constraints are database enforced", async () => {
    await fresh.sql`
      insert into recovery_operations
        (id, project_id, meeting_id, idempotency_key_hash, kind, state, phase, ordinal, correlation_id, actor_class, reason_code)
      values
        (${"rop_completed_a"}, ${PROJECT_ID}, ${FRESH_MEETING_ID}, ${HASH_A}, ${"manual"}, ${"completed"}, ${"completed"}, ${1}, ${"corr_completed_a"}, ${"user"}, ${"user_requested"})
    `;
    await expectDatabaseRejects(fresh.sql`
      insert into recovery_operations
        (id, project_id, meeting_id, idempotency_key_hash, kind, state, phase, ordinal, correlation_id, actor_class, reason_code)
      values
        (${"rop_completed_duplicate"}, ${PROJECT_ID}, ${FRESH_MEETING_ID}, ${HASH_A}, ${"manual"}, ${"completed"}, ${"completed"}, ${2}, ${"corr_completed_b"}, ${"user"}, ${"user_requested"})
    `);

    await fresh.sql`
      insert into recovery_operations
        (id, project_id, meeting_id, idempotency_key_hash, kind, state, phase, ordinal, correlation_id, actor_class, reason_code)
      values
        (${"rop_active_a"}, ${PROJECT_ID}, ${FRESH_MEETING_ID}, ${HASH_B}, ${"manual"}, ${"active"}, ${"transcribing"}, ${2}, ${"corr_active_a"}, ${"user"}, ${"user_requested"})
    `;
    await expectDatabaseRejects(fresh.sql`
      insert into recovery_operations
        (id, project_id, meeting_id, idempotency_key_hash, kind, state, phase, ordinal, correlation_id, actor_class, reason_code)
      values
        (${"rop_active_b"}, ${PROJECT_ID}, ${FRESH_MEETING_ID}, ${HASH_C}, ${"manual"}, ${"accepted"}, ${"queued"}, ${3}, ${"corr_active_b"}, ${"user"}, ${"user_requested"})
    `);
  });

  test("paired source sample metadata and conservative integer duration round-trip for a sub-ms tail", async () => {
    await fresh.sql`
      insert into recovery_operations
        (id, project_id, meeting_id, idempotency_key_hash, kind, state, phase, ordinal,
         planned_audio_ms, source_sample_rate_hz, source_sample_count,
         correlation_id, actor_class, reason_code)
      values
        (${"rop_sub_ms"}, ${PROJECT_ID}, ${FRESH_MEETING_ID}, ${HASH_C}, ${"manual"}, ${"completed"},
         ${"completed"}, ${4}, ${2001}, ${16000}, ${32001}, ${"corr_sub_ms"}, ${"user"}, ${"user_requested"})
    `;
    await fresh.sql`
      insert into transcription_chunks
        (id, operation_id, ordinal, version, start_ms, end_ms, provenance, state)
      values (${"chk_sub_ms_tail"}, ${"rop_sub_ms"}, ${2}, ${1}, ${2000}, ${2001}, ${"provider"}, ${"planned"})
    `;
    const [row] = await fresh.sql<{
      planned_audio_ms: bigint;
      source_sample_rate_hz: number;
      source_sample_count: bigint;
      start_ms: bigint;
      end_ms: bigint;
    }[]>`
      select o.planned_audio_ms, o.source_sample_rate_hz, o.source_sample_count,
             c.start_ms, c.end_ms
      from recovery_operations o
      join transcription_chunks c on c.operation_id = o.id
      where o.id = ${"rop_sub_ms"}
    `;
    expect(Number(row!.planned_audio_ms)).toBe(2_001);
    expect(Number.isSafeInteger(Number(row!.planned_audio_ms))).toBe(true);
    expect(reconstructProviderV2SampleRange(
      Number(row!.start_ms),
      Number(row!.end_ms),
      row!.source_sample_rate_hz,
      Number(row!.source_sample_count),
      true,
    )).toEqual({ startSample: 32_000, endSample: 32_001 });
  });

  test("maximum planner-compatible sample rate round-trips within PostgreSQL integer storage", async () => {
    await fresh.sql`
      insert into recovery_operations
        (id, project_id, meeting_id, idempotency_key_hash, kind, state, phase, ordinal,
         planned_audio_ms, source_sample_rate_hz, source_sample_count,
         correlation_id, actor_class, reason_code)
      values
        (${"rop_max_sample_rate"}, ${PROJECT_ID}, ${FRESH_MEETING_ID}, ${HASH_D}, ${"manual"},
         ${"completed"}, ${"completed"}, ${5}, ${1}, ${PROVIDER_V2_MAX_SOURCE_SAMPLE_RATE_HZ}, ${1},
         ${"corr_max_sample_rate"}, ${"user"}, ${"user_requested"})
    `;
    const [row] = await fresh.sql<{
      planned_audio_ms: bigint;
      source_sample_rate_hz: number;
      source_sample_count: bigint;
    }[]>`
      select planned_audio_ms, source_sample_rate_hz, source_sample_count
      from recovery_operations where id = ${"rop_max_sample_rate"}
    `;
    expect(Number(row!.planned_audio_ms)).toBe(1);
    expect(row!.source_sample_rate_hz).toBe(PROVIDER_V2_MAX_SOURCE_SAMPLE_RATE_HZ);
    expect(Number(row!.source_sample_count)).toBe(1);
    expect(reconstructProviderV2SampleRange(
      0,
      1,
      row!.source_sample_rate_hz,
      Number(row!.source_sample_count),
      true,
    )).toEqual({ startSample: 0, endSample: 1 });

    const [constraint] = await fresh.sql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname = 'recovery_operations_source_samples_check'
    `;
    expect(constraint!.definition).toContain(`source_sample_rate_hz <= ${PROVIDER_V2_MAX_SOURCE_SAMPLE_RATE_HZ}`);
    const migration = await Bun.file(new URL("../../src/db/migrations/0003_recovery_v2_schema.sql", import.meta.url)).text();
    const snapshot = await Bun.file(new URL("../../src/db/migrations/meta/0003_snapshot.json", import.meta.url)).json();
    expect(migration).toContain(`"source_sample_rate_hz" <= ${PROVIDER_V2_MAX_SOURCE_SAMPLE_RATE_HZ}`);
    expect(snapshot.tables["public.recovery_operations"].checkConstraints
      .recovery_operations_source_samples_check.value).toContain(
        `"recovery_operations"."source_sample_rate_hz" <= ${PROVIDER_V2_MAX_SOURCE_SAMPLE_RATE_HZ}`,
      );
  });

  test("source sample metadata is nullable only as a pair and rejects incompatible values", async () => {
    const fixtures = [
      ["rate_only", 16_000, null, 0],
      ["count_only", null, 32_001, 0],
      ["zero_rate", 0, 32_001, 2_001],
      ["unaligned_rate", 44_100, 32_001, 2_001],
      ["zero_count", 16_000, 0, 0],
      ["unsafe_count", 16_000, 9_007_199_254_740_992n, 2_001],
      ["duration_mismatch", 16_000, 32_001, 2_000],
    ] as const;
    for (const [label, rate, count, duration] of fixtures) {
      await expectDatabaseRejects(fresh.sql`
        insert into recovery_operations
          (id, project_id, meeting_id, idempotency_key_hash, kind, state, phase, ordinal,
           planned_audio_ms, source_sample_rate_hz, source_sample_count,
           correlation_id, actor_class, reason_code)
        values
          (${`rop_bad_samples_${label}`}, ${PROJECT_ID}, ${FRESH_MEETING_ID}, ${HASH_A}, ${"manual"},
           ${"completed"}, ${"completed"}, ${10}, ${duration}, ${rate}, ${count},
           ${`corr_bad_samples_${label}`}, ${"user"}, ${"user_requested"})
      `);
    }
  });

  test("chunk and ledger uniqueness, fences, protected checkpoint shape, and database timestamps are enforced", async () => {
    const [chunk] = await fresh.sql<{ created_at: Date; database_now: Date }[]>`
      insert into transcription_chunks
        (id, operation_id, ordinal, version, start_ms, end_ms, provenance, state,
         checkpoint_ciphertext, checkpoint_nonce, checkpoint_key_version, checkpoint_content_hash)
      values
        (${"chk_opaque_a"}, ${"rop_active_a"}, ${1}, ${1}, ${0}, ${60000}, ${"provider"}, ${"planned"},
         ${"AQID"}, ${"BAUG"}, ${"key-v1"}, ${HASH_A})
      returning created_at, clock_timestamp() as database_now
    `;
    expect(Math.abs(chunk!.database_now.getTime() - chunk!.created_at.getTime())).toBeLessThan(5_000);
    await expectDatabaseRejects(fresh.sql`
      insert into transcription_chunks
        (id, operation_id, ordinal, version, start_ms, end_ms, provenance, state)
      values (${"chk_opaque_duplicate"}, ${"rop_active_a"}, ${1}, ${1}, ${0}, ${60000}, ${"provider"}, ${"planned"})
    `);
    await expectDatabaseRejects(fresh.sql`
      insert into transcription_chunks
        (id, operation_id, ordinal, version, start_ms, end_ms, provenance, state, lease_fence)
      values (${"chk_bad_fence"}, ${"rop_active_a"}, ${2}, ${1}, ${60000}, ${120000}, ${"provider"}, ${"planned"}, ${-1})
    `);
    await expectDatabaseRejects(fresh.sql`
      insert into transcription_chunks
        (id, operation_id, ordinal, version, start_ms, end_ms, provenance, state, checkpoint_ciphertext)
      values (${"chk_bad_checkpoint"}, ${"rop_active_a"}, ${3}, ${1}, ${120000}, ${180000}, ${"provider"}, ${"planned"}, ${"Bw=="})
    `);

    await fresh.sql`
      insert into provider_call_ledger
        (id, project_id, operation_id, chunk_id, reservation_key_hash, kind,
         submitted_audio_ms, submitted_bytes, attempt, dispatch_state, lease_fence)
      values
        (${"pcl_opaque_a"}, ${PROJECT_ID}, ${"rop_active_a"}, ${"chk_opaque_a"}, ${HASH_B}, ${"manual"},
         ${60000}, ${1024}, ${1}, ${"reserved"}, ${1})
    `;
    await expectDatabaseRejects(fresh.sql`
      insert into provider_call_ledger
        (id, project_id, operation_id, chunk_id, reservation_key_hash, kind,
         submitted_audio_ms, submitted_bytes, attempt, dispatch_state)
      values
        (${"pcl_opaque_duplicate"}, ${PROJECT_ID}, ${"rop_active_a"}, ${"chk_opaque_a"}, ${HASH_C}, ${"manual"},
         ${60000}, ${1024}, ${1}, ${"reserved"})
    `);
    await expectDatabaseRejects(fresh.sql`
      insert into provider_call_ledger
        (id, project_id, operation_id, chunk_id, reservation_key_hash, kind,
         submitted_audio_ms, submitted_bytes, attempt, dispatch_state, lease_fence)
      values
        (${"pcl_bad_fence"}, ${PROJECT_ID}, ${"rop_active_a"}, ${"chk_opaque_a"}, ${HASH_C}, ${"manual"},
         ${60000}, ${1024}, ${2}, ${"reserved"}, ${-1})
    `);
  });

  test("protected checkpoints reject every partial field population", async () => {
    const protectedValues = ["AQID", "BAUG", "key-v1", HASH_A] as const;
    for (let mask = 1; mask < 0b1111; mask += 1) {
      const values = protectedValues.map((value, index) => (
        mask & (1 << index) ? value : null
      ));
      await expectDatabaseRejects(fresh.sql`
        insert into transcription_chunks
          (id, operation_id, ordinal, version, start_ms, end_ms, provenance, state,
           checkpoint_ciphertext, checkpoint_nonce, checkpoint_key_version, checkpoint_content_hash)
        values
          (${`chk_partial_${mask}`}, ${"rop_active_a"}, ${100 + mask}, ${1}, ${200000 + mask * 1000},
           ${200500 + mask * 1000}, ${"provider"}, ${"planned"}, ${values[0]}, ${values[1]},
           ${values[2]}, ${values[3]})
      `);
    }
  });

  test("protected checkpoint encodings are nonempty and bounded", async () => {
    const invalidShapes = [
      ["", "BAUG", "key-v1", HASH_A],
      ["A".repeat(1_048_577), "BAUG", "key-v1", HASH_A],
      ["AQID", "", "key-v1", HASH_A],
      ["AQID", "B".repeat(257), "key-v1", HASH_A],
      ["AQID", "BAUG", "", HASH_A],
      ["AQID", "BAUG", "k".repeat(129), HASH_A],
      ["AQID", "BAUG", "key-v1", "not-a-hash"],
    ] as const;
    for (const [index, values] of invalidShapes.entries()) {
      await expectDatabaseRejects(fresh.sql`
        insert into transcription_chunks
          (id, operation_id, ordinal, version, start_ms, end_ms, provenance, state,
           checkpoint_ciphertext, checkpoint_nonce, checkpoint_key_version, checkpoint_content_hash)
        values
          (${`chk_bounded_${index}`}, ${"rop_active_a"}, ${300 + index}, ${1}, ${400000 + index * 1000},
           ${400500 + index * 1000}, ${"provider"}, ${"planned"}, ${values[0]}, ${values[1]},
           ${values[2]}, ${values[3]})
      `);
    }
    await fresh.sql`
      insert into transcription_chunks
        (id, operation_id, ordinal, version, start_ms, end_ms, provenance, state)
      values
        (${"chk_no_checkpoint"}, ${"rop_active_a"}, ${399}, ${1}, ${500000}, ${501000},
         ${"provider"}, ${"planned"})
    `;
  });

  test("chunk ledger references require an existing ledger and block destructive deletes", async () => {
    await expectDatabaseRejects(fresh.sql`
      insert into transcription_chunks
        (id, operation_id, ordinal, version, start_ms, end_ms, provenance, state, provider_call_ledger_id)
      values
        (${"chk_missing_ledger"}, ${"rop_active_a"}, ${200}, ${1}, ${300000}, ${301000},
         ${"provider"}, ${"planned"}, ${"pcl_missing"})
    `);

    await fresh.sql`
      insert into transcription_chunks
        (id, operation_id, ordinal, version, start_ms, end_ms, provenance, state)
      values
        (${"chk_link_target"}, ${"rop_active_a"}, ${201}, ${1}, ${301000}, ${302000},
         ${"provider"}, ${"planned"})
    `;
    await fresh.sql`
      insert into provider_call_ledger
        (id, project_id, operation_id, chunk_id, reservation_key_hash, kind,
         submitted_audio_ms, submitted_bytes, attempt, dispatch_state)
      values
        (${"pcl_link_target"}, ${PROJECT_ID}, ${"rop_active_a"}, ${"chk_link_target"}, ${HASH_C},
         ${"manual"}, ${1000}, ${128}, ${2}, ${"reserved"})
    `;
    await fresh.sql`
      update transcription_chunks
      set provider_call_ledger_id = ${"pcl_link_target"}
      where id = ${"chk_link_target"}
    `;
    const [linked] = await fresh.sql<{ provider_call_ledger_id: string }[]>`
      select provider_call_ledger_id from transcription_chunks where id = ${"chk_link_target"}
    `;
    expect(linked).toEqual({ provider_call_ledger_id: "pcl_link_target" });
    await expectDatabaseRejects(fresh.sql`
      delete from provider_call_ledger where id = ${"pcl_link_target"}
    `);
    await expectDatabaseRejects(fresh.sql`
      delete from transcription_chunks where id = ${"chk_link_target"}
    `);
  });

  test("outbox and capability leases retain bounded enums, leases, and fences", async () => {
    await expectDatabaseRejects(fresh.sql`
      insert into outbox_jobs
        (id, project_id, operation_id, event_type, dedupe_key_hash, state, lease_fence)
      values (${"job_bad_event"}, ${PROJECT_ID}, ${"rop_active_a"}, ${"caller_chosen_event"}, ${HASH_A}, ${"pending"}, ${0})
    `);
    await expectDatabaseRejects(fresh.sql`
      insert into service_capability_leases
        (component, lease_owner_hash, build_revision, contract_version, finalizer_version, schema_version,
         config_version, lease_expires_at, lease_fence)
      values (${"caller_component"}, ${HASH_A}, ${"build-opaque"}, ${"recovery-v2"}, ${"finalizer-v2"}, ${"0003"},
              ${"config-unset"}, clock_timestamp() + interval '1 minute', ${0})
    `);
  });

  test("audit, reservation, availability, and heartbeat timestamps use database-time defaults", async () => {
    const expected = [
      "outbox_jobs.available_at",
      "outbox_jobs.created_at",
      "outbox_jobs.updated_at",
      "project_recovery_buckets.created_at",
      "project_recovery_buckets.updated_at",
      "project_recovery_guards.created_at",
      "project_recovery_guards.updated_at",
      "provider_call_ledger.budget_bucket_minute",
      "provider_call_ledger.created_at",
      "provider_call_ledger.reserved_at",
      "provider_call_ledger.updated_at",
      "recovery_operations.accepted_at",
      "recovery_operations.created_at",
      "recovery_operations.updated_at",
      "service_capability_leases.created_at",
      "service_capability_leases.heartbeat_at",
      "service_capability_leases.updated_at",
      "transcription_chunks.created_at",
      "transcription_chunks.updated_at",
    ];
    const rows = await fresh.sql<{ qualified_name: string; column_default: string | null }[]>`
      select table_name || '.' || column_name as qualified_name, column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name in (
          'recovery_operations', 'transcription_chunks', 'provider_call_ledger',
          'project_recovery_guards', 'project_recovery_buckets', 'outbox_jobs',
          'service_capability_leases'
        )
        and column_default = 'now()'
      order by qualified_name
    `;
    expect(rows.map((row) => row.qualified_name)).toEqual(expected);
  });
});
