import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { transcriptionProviderBlocks, transcriptionWorkers } from "../../src/db/schema.ts";
import { recordWorkerHeartbeat } from "../../src/uploads/worker.ts";
import { audio, startBatchHarness, tenant, type BatchHarness } from "./batch-harness.ts";

// The harness writes upload files under os.tmpdir(); keep that and HOME in a private /var/tmp dir.
const scratch = mkdtempSync(join("/var/tmp", "tc-waitcap."));
const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
process.env.HOME = scratch;
process.env.TMPDIR = scratch;
if (!scratch.startsWith("/var/tmp/tc-waitcap.") || process.env.HOME !== scratch) throw new Error("test scratch dir was not applied");

const wav = { contentType: "audio/wav" } as const;
const N = 3;

let h: BatchHarness;
beforeAll(async () => { h = await startBatchHarness(); });
afterAll(async () => {
  try { await h.stop(); }
  finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
    rmSync(scratch, { recursive: true, force: true });
  }
});
afterEach(async () => {
  h.tinfoil.calls = [];
  h.tinfoil.handler = (call) => Response.json({ text: `words ${call}`, language: "en" });
  await h.ctx.db.execute(sql`truncate table transcriptions, transcription_tenant_usage cascade`);
  await h.ctx.db.execute(sql`update provider_dispatch_slots set attempt_id = null, transcription_id = null, owner_id = null, claimed_at = null`);
  await h.ctx.db.delete(transcriptionWorkers);
  await recordWorkerHeartbeat(h.ctx);
  Object.assign(h.ctx.config.limits, { maxActiveJobs: 10, maxWaitingBytes: 10 * 186_496_800 });
});

const refused = () => { const e = new Error("refused") as Error & { code: string }; e.code = "ConnectionRefused"; throw e; };

describe("jobs waiting on a provider outage and the service-wide capacity", () => {
  test("N waiting jobs leave room for job N+1; their tenants keep their one active slot", async () => {
    h.ctx.config.limits.maxActiveJobs = N;
    h.tinfoil.handler = refused;
    const bytes = await audio("mono_wav");
    const ids: string[] = [];
    for (let n = 1; n <= N; n++) {
      ids.push(await h.submit(bytes, { tenant: tenant(n), ...wav }));
      await h.work();
    }
    for (const id of ids) {
      expect(await h.row(id)).toMatchObject({ status: "queued" });
      expect(await h.ctx.db.select().from(transcriptionProviderBlocks).where(eq(transcriptionProviderBlocks.transcriptionId, id))).toHaveLength(1);
    }

    const next = await h.create(bytes, { tenant: tenant(N + 1), ...wav });
    expect(next.status).toBe(201);

    const again = await h.create(bytes, { tenant: tenant(1), ...wav });
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("active_transcription_exists");
  });

  test("the same N jobs not waiting (awaiting upload) still fill the service: N+1 gets service_busy", async () => {
    h.ctx.config.limits.maxActiveJobs = N;
    const bytes = await audio("mono_wav");
    for (let n = 1; n <= N; n++) expect((await h.create(bytes, { tenant: tenant(n), ...wav })).status).toBe(201);
    const busy = await h.create(bytes, { tenant: tenant(N + 1), ...wav });
    expect(busy.status).toBe(429);
    expect((await busy.json()).error.code).toBe("service_busy");
  });

  test("the audio held by waiting jobs is bounded: creates that would not fit under maxWaitingBytes get service_busy", async () => {
    const bytes = await audio("mono_wav");
    h.ctx.config.limits.maxWaitingBytes = bytes.byteLength * 2;
    h.tinfoil.handler = refused;
    for (let n = 1; n <= 2; n++) {
      await h.submit(bytes, { tenant: tenant(n), ...wav });
      await h.work();
    }
    // Two waiting jobs hold exactly the budget; the global job and byte limits are untouched.
    const full = await h.create(bytes, { tenant: tenant(3), ...wav });
    expect(full.status).toBe(429);
    expect((await full.json()).error.code).toBe("service_busy");

    h.ctx.config.limits.maxWaitingBytes = bytes.byteLength * 3;
    expect((await h.create(bytes, { tenant: tenant(3), ...wav })).status).toBe(201);
  });
});
