import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { transcriptionAttempts, transcriptionProviderBlocks, transcriptionRegions, transcriptions, transcriptionWorkers } from "../../src/db/schema.ts";
import { runSweep } from "../../src/uploads/ledger.ts";
import { jobDir } from "../../src/uploads/storage.ts";
import { recordWorkerHeartbeat } from "../../src/uploads/worker.ts";
import { audio, exists, startBatchHarness, TENANT_B, type BatchHarness } from "./batch-harness.ts";

// TC-2084: the harness writes upload files under os.tmpdir(); keep that and HOME in a private /var/tmp dir.
const scratch = mkdtempSync(join("/var/tmp", "tc-2084."));
process.env.HOME = scratch;
process.env.TMPDIR = scratch;
if (!scratch.startsWith("/var/tmp/tc-2084.") || process.env.HOME !== scratch) throw new Error("test scratch dir was not applied");

type Logged = { level: string; message: string; fields: Record<string, unknown> };

const MIN = 60_000;
const HOUR = 60 * MIN;
const wav = { contentType: "audio/wav" } as const;
const refuse = (status: number) => () => new Response("body-probe Bearer sk-probe transcript-probe", { status, headers: { "x-probe": "header-probe" } });

let h: BatchHarness;
let logs: Logged[] = [];
beforeAll(async () => {
  h = await startBatchHarness();
  const record = (level: string) => (message: string, fields?: Record<string, unknown>) => void logs.push({ level, message, fields: fields ?? {} });
  h.ctx.log = { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
});
afterAll(async () => {
  await h.stop();
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(async () => {
  logs = [];
  h.tinfoil.calls = [];
  h.tinfoil.handler = (call) => Response.json({ text: `words ${call}`, language: "en" });
  await h.ctx.db.execute(sql`truncate table transcriptions, transcription_tenant_usage cascade`);
  await h.ctx.db.execute(sql`update provider_dispatch_slots set attempt_id = null, transcription_id = null, owner_id = null, claimed_at = null`);
  await h.ctx.db.delete(transcriptionWorkers);
  await recordWorkerHeartbeat(h.ctx);
  Object.assign(h.ctx.config.worker, { maxConsecutiveRateLimits: 20, maxNotSentAttempts: 5 });
});

const attempts = (id: string) => h.ctx.db.select().from(transcriptionAttempts).where(eq(transcriptionAttempts.transcriptionId, id));
const regions = (id: string) => h.ctx.db.select().from(transcriptionRegions).where(eq(transcriptionRegions.transcriptionId, id));
const dto = async (id: string) => (await h.api(`/v1/transcriptions/${id}`)).json();
const events = (message: string) => logs.filter((l) => l.message === message);
/** Moves the job's not-before into the past: the fake clock for a waiting job. */
const block = async (id: string) => (await h.ctx.db.select().from(transcriptionProviderBlocks).where(eq(transcriptionProviderBlocks.transcriptionId, id)))[0];
const elapse = (id: string) => h.ctx.db.update(transcriptionProviderBlocks).set({ nextAttemptAt: new Date(Date.now() - 1_000) }).where(eq(transcriptionProviderBlocks.transcriptionId, id));
const waitedSeconds = async (id: string) => ((await block(id))!.nextAttemptAt.getTime() - Date.now()) / 1000;

describe("a blocked provider makes the job wait", () => {
  for (const status of [402, 401, 403]) {
    test(`${status}: the job is released to queued with a not-before; nothing fails and no counter burns`, async () => {
      // Every retry counter is at its smallest: any one of them being consumed would fail the job.
      Object.assign(h.ctx.config.worker, { maxConsecutiveRateLimits: 1, maxNotSentAttempts: 1 });
      h.tinfoil.handler = refuse(status);
      const id = await h.submit(await audio("mono_wav"), wav);
      const before = Date.now();
      expect(await h.work()).toBe(true);

      const row = await h.row(id);
      expect(row).toMatchObject({ status: "queued", errorCode: null, errorMessage: null, claimToken: null, claimOwnerId: null, claimCount: 0, deletionState: "none" });
      const wait = (await block(id))!;
      expect(wait).toMatchObject({ attempts: 1, lastStatus: status });
      expect(wait.blockedSince.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(wait.nextAttemptAt.getTime() - before).toBeGreaterThan(55_000);
      expect(wait.nextAttemptAt.getTime() - before).toBeLessThan(65_000);
      expect(row.terminalAt).toBeNull();
      expect(row.processingStartedAt).toBeNull();
      expect((await attempts(id)).map((a) => [a.status, a.outcome])).toEqual([["blocked", `http_${status}`]]);
      expect((await regions(id)).map((r) => r.status)).toEqual(["pending"]);
      expect((await h.ctx.db.execute(sql`select attempt_id from provider_dispatch_slots`))[0]!.attempt_id).toBeNull();
      // The upload stays on disk while the job waits, and the decoded scratch of the released claim is gone.
      expect(await exists(join(jobDir(h.uploadDir, id), row.audioFile!))).toBe(true);
      expect(await exists(join(jobDir(h.uploadDir, id), `work-${row.generation - 1}`))).toBe(false);
    });
  }

  test("the client sees a delayed job: status queued, provider_delayed true, no error", async () => {
    h.tinfoil.handler = refuse(402);
    const id = await h.submit(await audio("mono_wav"), wav);
    expect(await dto(id)).not.toHaveProperty("provider_delayed");
    await h.work();
    const waiting = await dto(id);
    expect(waiting).toMatchObject({ status: "queued", provider_delayed: true, error: null });
    const listed = (await (await h.api("/v1/transcriptions")).json()).data.find((j: { id: string }) => j.id === id);
    expect(listed.provider_delayed).toBe(true);
  });

  test("a waiting job is not claimed before its not-before, and the provider is not called", async () => {
    h.tinfoil.handler = refuse(402);
    const id = await h.submit(await audio("mono_wav"), wav);
    await h.work();
    expect(h.tinfoil.calls).toHaveLength(1);
    expect(await h.work()).toBe(false);
    expect(await h.work()).toBe(false);
    expect(h.tinfoil.calls).toHaveLength(1);
    await elapse(id);
    expect(await h.work()).toBe(true);
    expect(h.tinfoil.calls).toHaveLength(2);
  });

  test("backoff is 1, 2, 5, 10, 30 minutes, then every 30 minutes", async () => {
    h.tinfoil.handler = refuse(402);
    const id = await h.submit(await audio("mono_wav"), wav);
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      await h.work();
      seen.push(Math.round((await waitedSeconds(id)) / 60));
      await elapse(id);
    }
    expect(seen).toEqual([1, 2, 5, 10, 30, 30, 30, 30]);
    expect(await block(id)).toMatchObject({ attempts: 8 });
    expect((await h.row(id)).status).toBe("queued");
  });

  test("the give-up window runs from the first block: the last wait is cut to it, then the job fails provider_unavailable", async () => {
    h.tinfoil.handler = refuse(402);
    const id = await h.submit(await audio("mono_wav"), wav);
    await h.work();
    // 23 h 50 min into the spell the next wait (30 min) is cut to the 24 h mark.
    await h.ctx.db.update(transcriptionProviderBlocks).set({ blockedSince: new Date(Date.now() - 23 * HOUR - 50 * MIN), attempts: 6 }).where(eq(transcriptionProviderBlocks.transcriptionId, id));
    await elapse(id);
    await h.work();
    const since = (await block(id))!.blockedSince.getTime();
    expect((await block(id))!.nextAttemptAt.getTime()).toBe(since + 24 * HOUR);
    expect((await h.row(id)).status).toBe("queued");

    await h.ctx.db.update(transcriptionProviderBlocks).set({ blockedSince: new Date(Date.now() - 24 * HOUR - MIN) }).where(eq(transcriptionProviderBlocks.transcriptionId, id));
    await elapse(id);
    await h.work();
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "provider_unavailable", deletionState: "files_deleted" });
    expect(await dto(id)).not.toHaveProperty("provider_delayed");
  });

  test("429 past maxConsecutiveRateLimits waits like a block instead of failing", async () => {
    Object.assign(h.ctx.config.worker, { maxConsecutiveRateLimits: 3 });
    h.tinfoil.handler = () => new Response("busy", { status: 429, headers: { "Retry-After": "0" } });
    const id = await h.submit(await audio("mono_wav"), wav);
    await h.work();
    expect(h.tinfoil.calls).toHaveLength(3);
    expect(await h.row(id)).toMatchObject({ status: "queued", errorCode: null });
    expect(await block(id)).toMatchObject({ lastStatus: 429, attempts: 1 });
    expect(await dto(id)).toMatchObject({ status: "queued", provider_delayed: true });
    expect(events("batch provider blocked")).toHaveLength(1);
    expect(events("batch provider blocked")[0]!.fields).toMatchObject({ http_status: 429, reason: "rate_limited" });
    // The streak is per claim: the next claim gets a fresh budget of consecutive 429s.
    await elapse(id);
    await h.work();
    expect(h.tinfoil.calls).toHaveLength(6);
    expect(await block(id)).toMatchObject({ attempts: 2 });
  });
});

describe("recovery", () => {
  test("after the provider answers 200 the job completes, logged once with the count of waiting jobs", async () => {
    h.tinfoil.handler = refuse(402);
    const id = await h.submit(await audio("mono_wav"), wav);
    await h.work();
    await elapse(id);
    await h.work();
    expect(events("batch provider recovered")).toHaveLength(0);

    h.tinfoil.handler = (call) => Response.json({ text: `ok ${call}` });
    await elapse(id);
    await h.work();
    expect(await h.row(id)).toMatchObject({ status: "completed" });
    expect(await block(id)).toBeUndefined();
    expect(await dto(id)).not.toHaveProperty("provider_delayed");
    const recovered = events("batch provider recovered");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ level: "warn", fields: { delayed_jobs: 1, stage: "dispatch" } });
  });

  test("the first success releases every waiting job at once; the recovery is logged once for all of them", async () => {
    h.tinfoil.handler = refuse(402);
    const a = await h.submit(await audio("mono_wav"), wav);
    const b = await h.submit(await audio("mono_wav"), { ...wav, tenant: TENANT_B });
    await h.work();
    await h.work();
    expect([(await h.row(a)).status, (await h.row(b)).status]).toEqual(["queued", "queued"]);

    h.tinfoil.handler = (call) => Response.json({ text: `ok ${call}` });
    await elapse(a);
    await h.work();
    expect((await h.row(a)).status).toBe("completed");
    // b's own not-before was cleared by a's success: no waiting needed.
    expect(await h.row(b)).toMatchObject({ status: "queued" });
    expect(await block(b)).toBeUndefined();
    expect(await h.work()).toBe(true);
    expect((await h.row(b)).status).toBe("completed");
    expect(events("batch provider recovered")).toHaveLength(1);
    expect(events("batch provider recovered")[0]!.fields).toMatchObject({ delayed_jobs: 2 });
  });

  test("a block in the middle of a job keeps the finished regions and never re-sends them", async () => {
    let call = 0;
    h.tinfoil.handler = () => (++call === 1 ? Response.json({ text: "first" }) : new Response("", { status: 402 }));
    const id = await h.submit(await audio("clicks_wav"), wav);
    await h.work();
    const total = (await regions(id)).length;
    expect(total).toBeGreaterThan(1);
    expect((await regions(id)).filter((r) => r.status === "completed")).toHaveLength(1);
    expect(await h.row(id)).toMatchObject({ status: "queued" });
    expect(await block(id)).toMatchObject({ lastStatus: 402 });
    expect(h.tinfoil.calls).toHaveLength(2);

    h.tinfoil.handler = () => Response.json({ text: "more" });
    await elapse(id);
    await h.work();
    expect((await h.row(id)).status).toBe("completed");
    expect(h.tinfoil.calls).toHaveLength(1 + total); // 1 sent before, then every region except the finished one, plus the refused call
  });

  test("a restart picks the waiting job up at its not-before (the wait is in the database)", async () => {
    h.tinfoil.handler = refuse(402);
    const id = await h.submit(await audio("mono_wav"), wav);
    await h.work();
    const restarted = h.withContext({ workerId: `restarted:${crypto.randomUUID()}` });
    await recordWorkerHeartbeat(restarted);
    expect(await h.work(restarted)).toBe(false);
    h.tinfoil.handler = (call) => Response.json({ text: `ok ${call}` });
    await elapse(id);
    expect(await h.work(restarted)).toBe(true);
    expect((await h.row(id)).status).toBe("completed");
  });

  test("retention: a waiting job's upload survives the sweep and the processing ceiling", async () => {
    h.tinfoil.handler = refuse(402);
    const id = await h.submit(await audio("mono_wav"), wav);
    await h.work();
    await h.ctx.db.update(transcriptions).set({ uploadedAt: new Date(Date.now() - 48 * HOUR), createdAt: new Date(Date.now() - 48 * HOUR) }).where(eq(transcriptions.id, id));
    const row = await h.row(id);
    await runSweep(h.ctx);
    expect(await h.row(id)).toMatchObject({ status: "queued", deletionState: "none" });
    expect(await exists(join(jobDir(h.uploadDir, id), row.audioFile!))).toBe(true);
  });
});

describe("logs", () => {
  test("batch provider blocked: once per job per distinct status, coded tokens only, level error with alert", async () => {
    const id = await h.submit(await audio("mono_wav"), wav);
    for (const status of [402, 402, 403, 403, 402]) {
      h.tinfoil.handler = refuse(status);
      await h.work();
      await elapse(id);
    }
    const blocked = events("batch provider blocked");
    expect(blocked.map((l) => l.fields.http_status)).toEqual([402, 403, 402]);
    expect(blocked.map((l) => l.fields.reason)).toEqual(["payment_required", "forbidden", "payment_required"]);
    expect(blocked[0]).toMatchObject({ level: "error", fields: { transcriptionId: id, http_status: 402, reason: "payment_required", stage: "dispatch", alert: true } });
    expect(Object.keys(blocked[0]!.fields).sort()).toEqual(["alert", "http_status", "reason", "stage", "transcriptionId"]);
    const everything = JSON.stringify(logs);
    for (const probe of ["body-probe", "sk-probe", "transcript-probe", "header-probe"]) expect(everything).not.toContain(probe);
  });

  test("401 logs reason unauthorized", async () => {
    h.tinfoil.handler = refuse(401);
    await h.submit(await audio("mono_wav"), wav);
    await h.work();
    expect(events("batch provider blocked")[0]!.fields).toMatchObject({ http_status: 401, reason: "unauthorized" });
  });
});

describe("outcomes that must not wait", () => {
  for (const [label, respond] of [
    ["500", () => new Response("", { status: 500 })],
    ["502", () => new Response("", { status: 502 })],
    ["timeout", () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }],
    ["connection reset", () => { const e = new Error("reset") as Error & { code: string }; e.code = "ECONNRESET"; throw e; }],
  ] as const) {
    test(`ambiguous ${label}: one call, never retried, provider_outcome_unknown, not delayed`, async () => {
      h.tinfoil.handler = respond;
      const id = await h.submit(await audio("mono_wav"), wav);
      await h.work();
      expect(h.tinfoil.calls).toHaveLength(1);
      expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "provider_outcome_unknown" });
      expect(await block(id)).toBeUndefined();
      expect(await h.work()).toBe(false);
      expect(h.tinfoil.calls).toHaveLength(1);
      expect(events("batch provider blocked")).toHaveLength(0);
    });
  }

  test("404 stays terminal provider_unavailable", async () => {
    h.tinfoil.handler = refuse(404);
    const id = await h.submit(await audio("mono_wav"), wav);
    await h.work();
    expect(h.tinfoil.calls).toHaveLength(1);
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
    expect(await block(id)).toBeUndefined();
    expect(events("batch provider blocked")).toHaveLength(0);
    expect(events("batch provider rejected the service credential or model")).toHaveLength(1);
  });

  test("400 stays terminal transcription_failed", async () => {
    h.tinfoil.handler = refuse(400);
    const id = await h.submit(await audio("mono_wav"), wav);
    await h.work();
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "transcription_failed" });
  });
});
