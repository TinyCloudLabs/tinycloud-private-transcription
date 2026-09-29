import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createApp, mountScoped } from "../../src/api/app.ts";
import { generateApiKey, hashApiKey, type AuthEnv } from "../../src/api/auth.ts";
import { mintBootstrapKeys, parseBootstrapKeys, syncBootstrapKeys, type BootstrapKey } from "../../src/api/bootstrap-keys.ts";
import { apiKeys, projects } from "../../src/db/schema.ts";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
let app: Hono<AuthEnv>;

const status = async (path: string, key: string) => (await app.request(path, { headers: { Authorization: `Bearer ${key}` } })).status;
/** 404 = authenticated and authorized for meetings (unknown id); 403 = wrong scope; 401 = no such key. */
const meetingStatus = (key: string) => status("/v1/meetings/mtg_bootstrap_probe", key);
const transcriptionStatus = (key: string) => status("/v1/transcriptions/trn_probe", key);
const adminStatus = (key: string) => status("/v1/admin/admission", key);
const bootstrapRows = () =>
  h.ctx.db
    .select({ id: apiKeys.id, projectId: apiKeys.projectId, keyHash: apiKeys.keyHash, scopes: apiKeys.scopes, createdAt: apiKeys.createdAt })
    .from(apiKeys)
    .where(eq(apiKeys.bootstrapManaged, true))
    .orderBy(apiKeys.id);

function mint() {
  const { keys, entries } = mintBootstrapKeys([
    { id: "tinychat-batch", project: "tinychat", scopes: ["transcriptions:*"] },
    { id: "owner-admin", project: "ops", scopes: ["admin:*"] },
  ]);
  return { tinychat: keys[0]!.key, admin: keys[1]!.key, entries };
}

beforeAll(async () => {
  h = await startHarness();
  app = createApp(h.ctx);
  const stub = () => new Hono<AuthEnv>().all("*", (c) => c.json({ project: c.get("project").id }));
  mountScoped(app, "/v1/transcriptions", "transcriptions:*", stub());
  mountScoped(app, "/v1/admin", "admin:*", stub());
});
beforeEach(async () => {
  await syncBootstrapKeys(h.ctx, []);
});
afterAll(async () => {
  await h.stop();
});

describe("syncBootstrapKeys", () => {
  test("inserts hashed keys whose scopes are enforced, creating their projects", async () => {
    const { tinychat, admin, entries } = mint();
    expect(await syncBootstrapKeys(h.ctx, entries)).toEqual({ upserted: 2, revoked: 0 });

    expect(await transcriptionStatus(tinychat)).toBe(200);
    expect(await meetingStatus(tinychat)).toBe(403);
    expect(await adminStatus(tinychat)).toBe(403);
    expect(await adminStatus(admin)).toBe(200);
    expect(await transcriptionStatus(admin)).toBe(403);
    expect(await meetingStatus(admin)).toBe(403);

    const rows = await bootstrapRows();
    expect(rows.map(({ id, projectId, scopes }) => ({ id, projectId, scopes }))).toEqual([
      { id: "owner-admin", projectId: "ops", scopes: ["admin:*"] },
      { id: "tinychat-batch", projectId: "tinychat", scopes: ["transcriptions:*"] },
    ]);
    expect(rows.map((r) => r.keyHash).sort()).toEqual([hashApiKey(tinychat), hashApiKey(admin)].sort());
    const created = await h.ctx.db.select({ id: projects.id }).from(projects).where(sql`${projects.id} IN ('tinychat', 'ops')`);
    expect(created.map((p) => p.id).sort()).toEqual(["ops", "tinychat"]);
  });

  test("is idempotent by id", async () => {
    const { tinychat, entries } = mint();
    await syncBootstrapKeys(h.ctx, entries);
    const first = await bootstrapRows();
    expect(await syncBootstrapKeys(h.ctx, entries)).toEqual({ upserted: 2, revoked: 0 });
    expect(await bootstrapRows()).toEqual(first);
    expect(await transcriptionStatus(tinychat)).toBe(200);
  });

  test("a changed hash rotates the key: the old plaintext stops working at once", async () => {
    const before = mint();
    await syncBootstrapKeys(h.ctx, before.entries);
    const after = mint();
    const rotated = [after.entries[0]!, before.entries[1]!];
    expect(await syncBootstrapKeys(h.ctx, rotated)).toEqual({ upserted: 2, revoked: 0 });
    expect(await transcriptionStatus(before.tinychat)).toBe(401);
    expect(await transcriptionStatus(after.tinychat)).toBe(200);
    expect(await adminStatus(before.admin)).toBe(200);
  });

  test("a changed scope set is applied to the existing key", async () => {
    const { tinychat, entries } = mint();
    await syncBootstrapKeys(h.ctx, entries);
    const widened: BootstrapKey[] = [{ ...entries[0]!, scopes: ["transcriptions:*", "admin:*"] }, entries[1]!];
    await syncBootstrapKeys(h.ctx, widened);
    expect(await adminStatus(tinychat)).toBe(200);
    await syncBootstrapKeys(h.ctx, entries);
    expect(await adminStatus(tinychat)).toBe(403);
    expect(await transcriptionStatus(tinychat)).toBe(200);
  });

  test("ids removed from the env are revoked; [] revokes every bootstrap key", async () => {
    const { tinychat, admin, entries } = mint();
    await syncBootstrapKeys(h.ctx, entries);
    expect(await syncBootstrapKeys(h.ctx, [entries[0]!])).toEqual({ upserted: 1, revoked: 1 });
    expect(await adminStatus(admin)).toBe(401);
    expect(await transcriptionStatus(tinychat)).toBe(200);
    expect(await syncBootstrapKeys(h.ctx, [])).toEqual({ upserted: 0, revoked: 1 });
    expect(await transcriptionStatus(tinychat)).toBe(401);
    expect(await bootstrapRows()).toEqual([]);
  });

  test("never modifies or revokes keys minted by create-key", async () => {
    const { entries } = mint();
    await syncBootstrapKeys(h.ctx, entries);
    await syncBootstrapKeys(h.ctx, []);
    expect(await meetingStatus(h.apiKey)).toBe(404);

    const legacyKey = generateApiKey();
    await h.ctx.db.insert(apiKeys).values({ id: "legacy-key", projectId: "demo", keyHash: hashApiKey(legacyKey), scopes: ["meetings:*"] });
    const hijack = parseBootstrapKeys(JSON.stringify([{ id: "legacy-key", project: "demo", scopes: ["admin:*"], sha256: "c".repeat(64) }]));
    await expect(syncBootstrapKeys(h.ctx, [...entries, ...hijack])).rejects.toThrow("collides with an API key that is not bootstrap-managed");

    // The whole sync rolled back: the legacy key is untouched and no bootstrap key was written.
    const [legacy] = await h.ctx.db.select().from(apiKeys).where(eq(apiKeys.id, "legacy-key"));
    expect(legacy).toMatchObject({ keyHash: hashApiKey(legacyKey), scopes: ["meetings:*"], bootstrapManaged: false });
    expect(await meetingStatus(legacyKey)).toBe(404);
    expect(await bootstrapRows()).toEqual([]);
    expect(await meetingStatus(h.apiKey)).toBe(404);
  });
});
