import { mkdtempSync, rmSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { transcriptionAdmission, transcriptionRegions, transcriptionResults, transcriptions } from "../../src/db/schema.ts";
import { runSweep } from "../../src/uploads/ledger.ts";
import { jobDir } from "../../src/uploads/storage.ts";
import { claimNext } from "../../src/uploads/worker.ts";
import { audio, exists, startBatchHarness, type BatchHarness } from "./batch-harness.ts";

const scratch = mkdtempSync("/var/tmp/tc2743-test-");
const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
process.env.HOME = scratch;
process.env.TMPDIR = scratch;
let h: BatchHarness;
beforeAll(async () => { h = await startBatchHarness(); });
afterAll(async () => {
  try { await h?.stop(); }
  finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
    rmSync(scratch, { recursive: true, force: true });
  }
});
afterEach(async () => {
  await h.ctx.db.execute(sql`truncate table transcriptions, transcription_tenant_usage cascade`);
  await h.ctx.db.update(transcriptionAdmission).set({ mode: "open" });
});
const queued = async () => h.submit(await audio("mono_wav"), { contentType: "audio/wav" });
const age = (id: string) => h.ctx.db.update(transcriptions).set({ uploadedAt: sql`now() - interval '73 hours'` }).where(eq(transcriptions.id, id));

for (const mode of ["closed", "provider_absent"] as const) {
  test(`never-blocked queued audio expires with ${mode}`, async () => {
    const id = await queued();
    await age(id);
    if (mode === "closed") await h.ctx.db.update(transcriptionAdmission).set({ mode: "closed" });
    const ctx = mode === "provider_absent" ? h.withContext({ provider: null }) : h.ctx;
    expect(await claimNext(ctx)).toBeNull();
    await runSweep(ctx);
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "processing_timeout", deletionState: "files_deleted" });
    expect(await exists(jobDir(h.uploadDir, id))).toBe(false);
  });
}

test("the database-clock deadline is inclusive and expired jobs cannot be claimed", async () => {
  const id = await queued();
  await h.ctx.db.transaction(async (tx) => {
    // The sweep/claim use the same database transaction clock for the exact boundary.
    const ctx = h.withContext({ db: tx as unknown as typeof h.ctx.db });
    await tx.update(transcriptions).set({ uploadedAt: sql`now() - interval '72 hours' + interval '1 millisecond'` }).where(eq(transcriptions.id, id));
    await runSweep(ctx);
    expect((await tx.select().from(transcriptions).where(eq(transcriptions.id, id)))[0]).toMatchObject({ status: "queued", deletionState: "none" });
    await tx.update(transcriptions).set({ uploadedAt: sql`now() - interval '72 hours'` }).where(eq(transcriptions.id, id));
    expect(await claimNext(ctx)).toBeNull();
    await runSweep(ctx);
    expect((await tx.select().from(transcriptions).where(eq(transcriptions.id, id)))[0]).toMatchObject({ status: "failed", deletionState: "files_deleted" });
  });
});

test("expiry clears partial content and retries a failed audio unlink", async () => {
  const id = await queued();
  await age(id);
  await h.ctx.db.insert(transcriptionRegions).values({ transcriptionId: id, ordinal: 0, channel: 0, startMs: 0, endMs: 1000, generation: 0, text: "partial private text" });
  await h.ctx.db.insert(transcriptionResults).values({ transcriptionId: id, resultJson: { text: "partial private text" } });
  const dir = jobDir(h.uploadDir, id);
  await chmod(dir, 0o500);
  try {
    await runSweep(h.ctx);
    expect(await h.row(id)).toMatchObject({ status: "failed", deletionState: "pending" });
    expect((await h.ctx.db.select().from(transcriptionRegions).where(eq(transcriptionRegions.transcriptionId, id)))[0]?.text).toBeNull();
    expect(await h.ctx.db.select().from(transcriptionResults).where(eq(transcriptionResults.transcriptionId, id))).toEqual([]);
    expect(await exists(dir)).toBe(true);
  } finally { await chmod(dir, 0o700); }
  await runSweep(h.ctx);
  expect(await h.row(id)).toMatchObject({ status: "failed", deletionState: "files_deleted" });
  expect(await exists(dir)).toBe(false);
});

test("a concurrent cancel or expired claim cannot resurrect a swept job", async () => {
  const id = await queued();
  await age(id);
  await Promise.all([runSweep(h.ctx), claimNext(h.ctx), h.api(`/v1/transcriptions/${id}/cancel`, { method: "POST" })]);
  const row = await h.row(id);
  expect(["failed", "cancelled"]).toContain(row.status);
  expect(row.deletionState).toBe("files_deleted");
  expect(await exists(jobDir(h.uploadDir, id))).toBe(false);
});
