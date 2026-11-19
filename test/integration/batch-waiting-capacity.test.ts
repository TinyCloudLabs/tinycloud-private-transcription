import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { transcriptionProviderBlocks, transcriptionWorkers, transcriptions } from "../../src/db/schema.ts";
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

  test("a job that would enter the wait past maxWaitingBytes fails provider_unavailable and its audio is deleted; creates are not refused", async () => {
    const bytes = await audio("mono_wav");
    h.ctx.config.limits.maxWaitingBytes = bytes.byteLength * 2;
    h.tinfoil.handler = refused;
    const waiting: string[] = [];
    for (let n = 1; n <= 2; n++) {
      waiting.push(await h.submit(bytes, { tenant: tenant(n), ...wav }));
      await h.work();
    }
    for (const id of waiting) expect(await h.row(id)).toMatchObject({ status: "queued" });

    // Two waiting jobs hold exactly the budget. Creating and uploading are still admitted; the outage decides.
    const third = await h.submit(bytes, { tenant: tenant(3), ...wav });
    await h.work();
    expect(await h.row(third)).toMatchObject({ status: "failed", errorCode: "provider_unavailable", deletionState: "files_deleted" });
    expect(await h.ctx.db.select().from(transcriptionProviderBlocks).where(eq(transcriptionProviderBlocks.transcriptionId, third))).toHaveLength(0);
    for (const id of waiting) expect(await h.row(id)).toMatchObject({ status: "queued" });

    h.ctx.config.limits.maxWaitingBytes = bytes.byteLength * 3;
    const fourth = await h.submit(bytes, { tenant: tenant(4), ...wav });
    await h.work();
    expect(await h.row(fourth)).toMatchObject({ status: "queued" });
  });

  test("jobs whose wait has ended take a service-wide slot before they are claimed: while the cap is full they stay queued", async () => {
    const bytes = await audio("mono_wav");
    h.tinfoil.handler = refused;
    const waiting: string[] = [];
    for (let n = 1; n <= N; n++) {
      waiting.push(await h.submit(bytes, { tenant: tenant(n), ...wav }));
      await h.work();
    }

    // Two other jobs now fill a cap of 2, while the three waiting ones hold no slot.
    h.ctx.config.limits.maxActiveJobs = 2;
    const holders: string[] = [];
    for (const n of [N + 1, N + 2]) {
      const res = await h.create(bytes, { tenant: tenant(n), ...wav });
      expect(res.status).toBe(201);
      holders.push((await res.json()).id);
    }

    // Every wait ends at once and the provider is back.
    await h.ctx.db.update(transcriptionProviderBlocks).set({ nextAttemptAt: new Date(Date.now() - 1_000) });
    h.tinfoil.handler = (call) => Response.json({ text: `words ${call}`, language: "en" });
    h.tinfoil.calls = [];
    expect(await h.work()).toBe(false);
    for (const id of waiting) expect(await h.row(id)).toMatchObject({ status: "queued" });
    expect(h.tinfoil.calls).toHaveLength(0);

    // One slot frees: the next claim takes one woken job and it completes; one claim processes one job.
    await h.ctx.db.update(transcriptions).set({ status: "cancelled" }).where(eq(transcriptions.id, holders[0]!));
    expect(await h.work()).toBe(true);
    const statuses = await Promise.all(waiting.map(async (id) => (await h.row(id)).status));
    expect(statuses.filter((status) => status === "completed")).toHaveLength(1);
    expect(statuses.filter((status) => status === "queued")).toHaveLength(N - 1);
  });
});
