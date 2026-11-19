import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { transcriptionProviderBlocks, transcriptionRegions, transcriptions, transcriptionWorkers } from "../../src/db/schema.ts";
import { runSweep } from "../../src/uploads/ledger.ts";
import { jobDir } from "../../src/uploads/storage.ts";
import { claimNext, recordWorkerHeartbeat } from "../../src/uploads/worker.ts";
import { audio, exists, startBatchHarness, type BatchHarness } from "./batch-harness.ts";

// TC-3444: the privacy policy says Private Transcription keeps the audio and any partial transcript for up to 72 hours
// after upload while it retries, then deletes them. A woken wait claimed just before the deadline must not keep them
// past it while it runs toward the 4-hour processing ceiling.
const scratch = mkdtempSync(join("/var/tmp", "tc-3444."));
const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
process.env.HOME = scratch;
process.env.TMPDIR = scratch;

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
  await h.ctx.db.execute(sql`truncate table transcriptions, transcription_tenant_usage cascade`);
  await h.ctx.db.execute(sql`update provider_dispatch_slots set attempt_id = null, transcription_id = null, owner_id = null, claimed_at = null`);
  await h.ctx.db.delete(transcriptionWorkers);
  await recordWorkerHeartbeat(h.ctx);
});

/** A job with one transcribed region that then hit a 402, woken and claimed again: processing, with partial text and a block row. */
async function wokenWaitProcessing() {
  let call = 0;
  h.tinfoil.handler = () => (++call === 1 ? Response.json({ text: "first region" }) : new Response("", { status: 402 }));
  const id = await h.submit(await audio("clicks_wav"), { contentType: "audio/wav" });
  await h.work();
  expect(await h.row(id)).toMatchObject({ status: "queued" });
  await h.ctx.db.update(transcriptionProviderBlocks).set({ nextAttemptAt: sql`now() - interval '1 second'` })
    .where(eq(transcriptionProviderBlocks.transcriptionId, id));
  const claim = await claimNext(h.ctx);
  expect(claim?.job.id).toBe(id);
  expect(await h.row(id)).toMatchObject({ status: "processing" });
  return { id, audioFile: (await h.row(id)).audioFile!, generation: claim!.fence.generation };
}

const age = (id: string, interval: string) => Promise.all([
  h.ctx.db.update(transcriptions).set({ uploadedAt: sql`now() - ${interval}::interval` }).where(eq(transcriptions.id, id)),
  h.ctx.db.update(transcriptionProviderBlocks).set({ blockedSince: sql`now() - ${interval}::interval` }).where(eq(transcriptionProviderBlocks.transcriptionId, id)),
]);
const regionTexts = async (id: string) => (await h.ctx.db.select({ text: transcriptionRegions.text }).from(transcriptionRegions)
  .where(eq(transcriptionRegions.transcriptionId, id))).map((r) => r.text);

test("a woken wait still processing at 72 h after upload is failed and its audio and partial text deleted", async () => {
  const { id, audioFile, generation } = await wokenWaitProcessing();
  expect(await regionTexts(id)).toContain("first region");

  await age(id, "71 hours 59 minutes");
  await runSweep(h.ctx);
  expect(await h.row(id)).toMatchObject({ status: "processing", deletionState: "none" });
  expect(await exists(join(jobDir(h.uploadDir, id), audioFile))).toBe(true);

  await age(id, "72 hours 1 minute");
  await runSweep(h.ctx);
  const row = await h.row(id);
  expect(row).toMatchObject({ status: "failed", errorCode: "provider_unavailable", deletionState: "files_deleted" });
  expect(row.generation).toBeGreaterThan(generation);
  expect((await regionTexts(id)).every((text) => text === null)).toBe(true);
  expect(await exists(join(jobDir(h.uploadDir, id), audioFile))).toBe(false);
});

test("a processing job that never waited on the provider is left to the processing ceiling", async () => {
  h.tinfoil.handler = () => Response.json({ text: "words" });
  const id = await h.submit(await audio("mono_wav"), { contentType: "audio/wav" });
  expect((await claimNext(h.ctx))?.job.id).toBe(id);
  await h.ctx.db.update(transcriptions).set({ uploadedAt: sql`now() - interval '73 hours'` }).where(eq(transcriptions.id, id));
  await runSweep(h.ctx);
  expect(await h.row(id)).toMatchObject({ status: "processing", deletionState: "none" });
});
