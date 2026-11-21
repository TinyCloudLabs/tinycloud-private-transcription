import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mintBootstrapKeys, parseBootstrapKeys, syncBootstrapKeys } from "../../src/api/bootstrap-keys.ts";
import { createApiKey } from "../../src/api/auth.ts";
import { config as baseConfig } from "../../src/config.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { silentLogger } from "../../src/log.ts";
import { createBatchApp, createBatchContext } from "../../src/roles/batch.ts";
import { BatchTinfoilClient } from "../../src/uploads/provider.ts";
import { ensureStorageRoot } from "../../src/uploads/storage.ts";
import { recordWorkerHeartbeat } from "../../src/uploads/worker.ts";
import { MockTinfoil, ScriptedFaults, TENANT_A, testBatchConfig } from "./batch-harness.ts";

// TC-3490: ptx-batch keeps no database backup. If its Postgres volume is lost, the next boot on an empty database
// (migrations, then PTX_BOOTSTRAP_KEYS, exactly as src/roles/batch-server.ts) must give back a working service that
// starts closed, accepts exactly the sealed-config keys, and does not bring back keys made with create-key.
const admin = new SQL(baseConfig.databaseUrl);
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const names = { lost: `ptx_tc3490_lost_${suffix}`, recovered: `ptx_tc3490_recovered_${suffix}` };
const urlOf = (name: string) => {
  const url = new URL(baseConfig.databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};
let uploadDir: string;

beforeAll(async () => {
  for (const name of Object.values(names)) await admin.unsafe(`create database "${name}"`);
  uploadDir = await mkdtemp(join(tmpdir(), "ptx-tc3490-"));
  await ensureStorageRoot(uploadDir);
});
afterAll(async () => {
  try {
    for (const name of Object.values(names)) await admin.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.close();
    await rm(uploadDir, { recursive: true, force: true });
  }
});

/** What batch-server.ts does at boot, against `url`. */
async function boot(url: string, bootstrapKeys: string) {
  const db = await runMigrations(url);
  const ctx = createBatchContext({
    config: { ...testBatchConfig(uploadDir), databaseUrl: url },
    db,
    log: silentLogger,
    provider: new BatchTinfoilClient({ ...testBatchConfig(uploadDir).tinfoil, fetch: new MockTinfoil().fetch }),
    faults: new ScriptedFaults(),
    workerId: `test-worker:${crypto.randomUUID()}`,
  });
  await syncBootstrapKeys(ctx, parseBootstrapKeys(bootstrapKeys));
  const app = createBatchApp(ctx);
  const api = async (path: string, key: string | null, init: { method?: string; json?: unknown } = {}) => {
    const headers = new Headers({ "X-Tenant-Ref": TENANT_A });
    if (key) headers.set("Authorization", `Bearer ${key}`);
    if (init.json !== undefined) headers.set("Content-Type", "application/json");
    const res = await app.request(path, { method: init.method ?? "GET", headers, body: init.json === undefined ? undefined : JSON.stringify(init.json) });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  return { ctx, db, api };
}

test("a lost database comes back from the sealed config alone: closed, bootstrap keys only, no create-key keys", async () => {
  const minted = mintBootstrapKeys([
    { id: "tinychat-batch", project: "tinychat", scopes: ["transcriptions:*"] },
    { id: "ops-admin", project: "ops", scopes: ["admin:*"] },
  ]);
  const key = Object.fromEntries(minted.keys.map(({ id, key }) => [id, key])) as Record<"tinychat-batch" | "ops-admin", string>;

  // The database before the loss: the same sealed keys, plus a key minted with create-key and admission open.
  const lost = await boot(urlOf(names.lost), minted.env);
  const cliKey = (await createApiKey({ db: lost.db } as never, "tinychat", ["transcriptions:*"])).key;
  expect((await lost.api("/v1/admin/admission", key["ops-admin"], { method: "PUT", json: { mode: "open" } })).status).toBe(200);
  expect((await lost.api("/v1/transcriptions/capabilities", cliKey)).status).toBe(200);
  await lost.db.$client.close();
  await admin.unsafe(`drop database "${names.lost}" with (force)`);

  // A fresh volume: the next boot runs on an empty database with the unchanged sealed environment.
  const recovered = await boot(urlOf(names.recovered), minted.env);
  try {
    const projects = await recovered.db.$client`select id from projects order by id`;
    expect(projects.map((row: { id: string }) => row.id)).toEqual(["ops", "tinychat"]);
    const keys = await recovered.db.$client`select id, bootstrap_managed from api_keys order by id`;
    expect(keys.map((row: { id: string; bootstrap_managed: boolean }) => [row.id, row.bootstrap_managed])).toEqual([["ops-admin", true], ["tinychat-batch", true]]);
    const slots = await recovered.db.$client`select count(*)::int as n from provider_dispatch_slots where id = 1 and attempt_id is null`;
    expect(slots[0].n).toBe(1);

    // Starts closed (0018); only the deploy's final gate opens it.
    const admission = await recovered.api("/v1/admin/admission", key["ops-admin"]);
    expect(admission).toMatchObject({ status: 200, body: { mode: "closed", active: { awaiting_upload: 0, queued: 0, processing: 0 } } });

    // The sealed keys work with their sealed scopes; the create-key key from the lost database does not exist.
    expect((await recovered.api("/v1/transcriptions/capabilities", key["tinychat-batch"])).status).toBe(200);
    expect((await recovered.api("/v1/admin/admission", key["tinychat-batch"])).status).toBe(403);
    expect((await recovered.api("/v1/transcriptions/capabilities", cliKey)).status).toBe(401);

    // Ready once its worker heartbeats; the deploy then opens admission.
    await recordWorkerHeartbeat(recovered.ctx);
    expect(await recovered.api("/health", null)).toMatchObject({ body: { checks: { upload_transcription: { ready: true } } } });
    expect(await recovered.api("/v1/admin/admission", key["ops-admin"], { method: "PUT", json: { mode: "open" } })).toMatchObject({ status: 200, body: { mode: "open" } });

    // Rotating the sealed keys after the loss (runbook step) revokes the dropped entry at the next boot.
    const rotated = mintBootstrapKeys([{ id: "ops-admin", project: "ops", scopes: ["admin:*"] }]);
    await syncBootstrapKeys(recovered.ctx, parseBootstrapKeys(rotated.env));
    expect((await recovered.api("/v1/transcriptions/capabilities", key["tinychat-batch"])).status).toBe(401);
    expect((await recovered.api("/v1/admin/admission", key["ops-admin"])).status).toBe(401);
    expect((await recovered.api("/v1/admin/admission", rotated.keys[0]!.key)).status).toBe(200);
  } finally {
    await recovered.db.$client.close();
  }
});
